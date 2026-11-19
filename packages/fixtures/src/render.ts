/**
 * HTML for the synthetic documents. Every cited field prints exactly its
 * quote, so the PDF text and the extraction always agree.
 */
import { dec, sum, toFixed, type Cmr, type CommercialInvoice, type Contract, type CustomsDeclaration, type PackingList, type Party } from "@logisticshub/core";
import { formatter } from "./format.ts";
import { LABELS, type Labels } from "./labels.ts";
import type { ShipmentSpec } from "./model.ts";

type Cited = { quote: string | null };

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/*
 * Field paths: render functions read the document through track(), which
 * remembers the path of every object it hands out ("lines[1].lineTotal").
 * q() wraps each quote in <span data-f="path">, so the website can mark the
 * exact fields a finding cites. Spans do not change the printed text.
 */
const PATHS = new WeakMap<object, string>();

function track<T extends object>(value: T, path = ""): T {
  return new Proxy(value, {
    get(target, key, receiver) {
      const child: unknown = Reflect.get(target, key, receiver);
      if (typeof key === "symbol" || child === null || typeof child !== "object") return child;
      const childPath = Array.isArray(target) ? `${path}[${key}]` : path ? `${path}.${key}` : key;
      const proxy = track(child, childPath);
      PATHS.set(proxy, childPath);
      return proxy;
    },
  });
}

const q = (field: Cited) => {
  const text = esc(field.quote ?? "");
  const path = PATHS.get(field as object);
  return path ? `<span data-f="${path}">${text}</span>` : text;
};

export interface RenderOptions {
  /** Extra <head> markup, e.g. web fonts and mark styles for the website. */
  head?: string;
  /** Invoice only: the table goes on over the page before this line (see Layout.invoiceBreakBefore). */
  breakBefore?: number;
}

const STYLE = `
  @page { size: A4; margin: 14mm 14mm 12mm; }
  * { box-sizing: border-box; }
  body { font-family: "Noto Sans", "Noto Sans Georgian", sans-serif; font-size: 8.6pt; color: #16181d; margin: 0; line-height: 1.38; }
  .top { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #16181d; padding-bottom: 6px; margin-bottom: 10px; }
  .brand { font-weight: 700; letter-spacing: .02em; font-size: 9pt; }
  h1 { font-size: 15pt; margin: 0; }
  .ref { text-align: right; font-size: 9pt; white-space: nowrap; flex-shrink: 0; padding-left: 12px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 8px; }
  .grid3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin-bottom: 8px; }
  .box { border: 1px solid #c9ccd3; padding: 6px 8px; min-height: 44px; }
  .label { font-size: 7pt; text-transform: uppercase; letter-spacing: .04em; color: #5b6170; margin-bottom: 2px; }
  .name { font-weight: 600; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0; }
  th { font-size: 7pt; text-transform: uppercase; color: #5b6170; text-align: left; border-bottom: 1px solid #16181d; padding: 4px; }
  td { border-bottom: 1px solid #e3e5ea; padding: 4px; vertical-align: top; }
  td.n, th.n { text-align: right; white-space: nowrap; }
  tr.sum td { font-weight: 700; border-top: 1px solid #16181d; border-bottom: none; }
  tr.carry td { color: #5b6170; font-style: italic; }
  .next-page { break-before: page; }
  .totals { margin-left: auto; width: 55%; }
  .totals td:first-child { color: #5b6170; }
  .words { border-left: 3px solid #16181d; padding: 4px 8px; margin: 8px 0; }
  .convention { font-size: 7.4pt; border: 1px solid #16181d; padding: 5px 8px; margin-bottom: 8px; }
  p { margin: 0 0 6px; }
  .sign { display: flex; justify-content: space-between; margin-top: 22px; }
  .sign div { width: 45%; border-top: 1px solid #16181d; padding-top: 3px; font-size: 7.5pt; color: #5b6170; }
  .foot { position: fixed; bottom: 0; left: 0; right: 0; font-size: 6.8pt; color: #8a8f9c; text-align: center; }
`;

function page(title: string, number: Cited, date: Cited, L: Labels, body: string, lang: string, options: RenderOptions = {}): string {
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><style>${STYLE}</style>${options.head ?? ""}</head><body>
  <div class="top"><div><div class="brand">LOGISTICSHUB · DEMO</div><h1>${esc(title)}</h1></div>
  <div class="ref">${esc(L.number)} ${q(number)}<br>${esc(L.date)} ${q(date)}</div></div>
  ${body}
  <div class="foot">${esc(L.synthetic)}</div>
  </body></html>`;
}

function partyBox(label: string, p: Party, taxLabel: string): string {
  return `<div class="box"><div class="label">${esc(label)}</div>
    <div class="name">${q(p.name)}</div><div>${q(p.address)}</div><div>${q(p.country)}</div>
    ${p.taxId.quote ? `<div>${esc(taxLabel)}: ${q(p.taxId)}</div>` : ""}</div>`;
}

function field(label: string, value: string): string {
  return `<div class="box"><div class="label">${esc(label)}</div><div>${value}</div></div>`;
}

export function renderInvoice(source: CommercialInvoice, spec: ShipmentSpec, options: RenderOptions = {}): string {
  const doc = track(source);
  const L = LABELS[spec.language];
  const withHs = doc.lines.some((line) => line.hsCode.quote);
  const rows = doc.lines.map(
    (l) => `<tr><td>${q(l.model)}</td><td>${q(l.description)}</td>${withHs ? `<td class="n">${q(l.hsCode)}</td>` : ""}<td class="n">${q(l.quantity)}</td><td>${q(l.unit)}</td>
      <td class="n">${q(l.unitPrice)}</td><td class="n">${q(l.lineTotal)}</td></tr>`,
  );
  const header = `<thead><tr><th>${esc(L.model)}</th><th>${esc(L.description)}</th>${withHs ? '<th class="n">HS</th>' : ""}<th class="n">${esc(L.quantity)}</th><th>${esc(L.unit)}</th>
      <th class="n">${esc(L.unitPrice)}</th><th class="n">${esc(L.amount)}</th></tr></thead>`;
  const table = (body: string) => `<table>${header}<tbody>${body}</tbody></table>`;
  // A table over two pages: the running sum closes page 1 and opens page 2, under the repeated header.
  const cut = options.breakBefore;
  const carried = (label: string) => {
    const f = formatter(spec.style);
    const amount = toFixed(sum(source.lines.slice(0, cut).map((l) => dec(l.lineTotal.value ?? "0"))), 2);
    return `<tr class="carry"><td colspan="${withHs ? 6 : 5}">${esc(label)}</td><td class="n">${esc(`${spec.currency} ${f.number(amount)}`)}</td></tr>`;
  };
  const lines =
    cut === undefined
      ? table(rows.join(""))
      : `${table(rows.slice(0, cut).join("") + carried(L.carriedForward))}
    <div class="top next-page"><div><div class="brand">LOGISTICSHUB · DEMO</div><h1>${esc(L.invoice)}</h1></div>
    <div class="ref">${esc(L.number)} ${esc(source.number.quote ?? "")}<br>2 / 2</div></div>
    ${table(carried(L.broughtForward) + rows.slice(cut).join(""))}`;
  const totals = [
    [L.subtotal, doc.subtotal],
    [L.discount, doc.discount],
    [L.freight, doc.freight],
    [L.insurance, doc.insurance],
    ...doc.otherCharges.map((charge) => [L.otherCharges, charge] as const),
    [L.tax, doc.tax],
    [L.total, doc.total],
  ] as const;
  const body = `
    <div class="grid">${partyBox(L.seller, doc.seller, L.taxId)}${partyBox(L.buyer, doc.buyer, L.taxId)}</div>
    <div class="grid3">
      ${field(L.contractRef, `${q(doc.contractRef.number)} / ${q(doc.contractRef.date)}`)}
      ${field(L.incoterm, `${q(doc.incoterm.code)} ${q(doc.incoterm.place)}, ${q(doc.incoterm.version)}`)}
      ${field(`${L.currency} · ${L.origin}`, `${q(doc.currency)} · ${q(doc.countryOfOrigin)}`)}
    </div>
    ${lines}
    <table class="totals"><tbody>
      ${totals.filter(([, v]) => v.quote).map(([label, v]) => `<tr><td>${esc(label)}</td><td class="n">${q(v)}</td></tr>`).join("")}
      <tr><td>${esc(L.packages)}</td><td class="n">${q(doc.packages)}</td></tr>
    </tbody></table>
    <div class="words"><div class="label">${esc(L.inWords)}</div>${q(doc.totalInWords)}</div>
    <div class="sign"><div>${esc(L.seller)} · ${esc(L.signature)}</div><div>${esc(L.date)}</div></div>`;
  return page(L.invoice, doc.number, doc.date, L, body, spec.language, options);
}

export function renderPackingList(source: PackingList, spec: ShipmentSpec, options: RenderOptions = {}): string {
  const doc = track(source);
  const L = LABELS[spec.language];
  const withQty = doc.lines.some((l) => l.quantity.quote);
  const rows = doc.lines
    .map(
      (l) => `<tr><td>${q(l.model)}</td><td>${q(l.description)}</td>
      ${withQty ? `<td class="n">${q(l.quantity)}</td><td>${q(l.unit)}</td>` : ""}
      <td class="n">${q(l.packages)}</td><td class="n">${q(l.netWeightKg)}</td><td class="n">${q(l.grossWeightKg)}</td><td class="n">${q(l.volumeM3)}</td></tr>`,
    )
    .join("");
  const body = `
    <div class="grid">${partyBox(L.shipper, doc.shipper, L.taxId)}${partyBox(L.consignee, doc.consignee, L.taxId)}</div>
    <div class="grid">${field(L.invoiceRef, `${q(doc.invoiceRef.number)} / ${q(doc.invoiceRef.date)}`)}${field(L.packing, q(doc.packingMethod))}</div>
    <table><thead><tr><th>${esc(L.model)}</th><th>${esc(L.description)}</th>
      ${withQty ? `<th class="n">${esc(L.quantity)}</th><th>${esc(L.unit)}</th>` : ""}
      <th class="n">${esc(L.packages)}</th><th class="n">${esc(L.net)}</th><th class="n">${esc(L.gross)}</th><th class="n">${esc(L.volume)}</th></tr></thead>
      <tbody>${rows}
      <tr class="sum"><td colspan="2">${esc(L.totals)}</td>${withQty ? `<td class="n">${q(doc.totalQuantity)}</td><td></td>` : ""}
      <td class="n">${q(doc.totalPackages)}</td><td class="n">${q(doc.totalNetWeightKg)}</td><td class="n">${q(doc.totalGrossWeightKg)}</td><td class="n">${q(doc.totalVolumeM3)}</td></tr>
      </tbody></table>
    <div class="grid">${field(L.marks, doc.lines.map((l) => esc(spec.lines.find((s) => s.model === l.model.value)?.marks ?? "")).join("<br>"))}<div></div></div>
    <div class="sign"><div>${esc(L.shipper)} · ${esc(L.signature)}</div><div>${esc(L.date)}</div></div>`;
  return page(L.packingList, doc.number, doc.date, L, body, spec.language, options);
}

export function renderCmr(source: Cmr, spec: ShipmentSpec, options: RenderOptions = {}): string {
  const doc = track(source);
  const L = LABELS[spec.language];
  const rows = doc.goods
    .map(
      (g) => `<tr><td>${q(g.marksAndNumbers)}</td><td class="n">${q(g.packages)}</td><td>${q(g.packingMethod)}</td><td>${q(g.description)}</td>
      <td class="n">${q(g.grossWeightKg)}</td><td class="n">${q(g.volumeM3)}</td></tr>`,
    )
    .join("");
  const body = `
    <div class="convention">${q(doc.convention)}</div>
    <div class="grid">${partyBox(`1. ${L.shipper}`, doc.sender, L.taxId)}${partyBox(`16. ${L.carrier}`, doc.carrier, L.taxId)}</div>
    <div class="grid">${partyBox(`2. ${L.consignee}`, doc.consignee, L.taxId)}${field(L.delivery, q(doc.placeOfDelivery))}</div>
    <div class="grid">${field(L.takingOver, `${q(doc.placeOfTakingOver)}<br>${q(doc.dateOfTakingOver)}`)}${field(L.attached, doc.attachedDocuments.map(q).join("<br>"))}</div>
    <table><thead><tr><th>6. ${esc(L.marks)}</th><th class="n">7. ${esc(L.packages)}</th><th>8. ${esc(L.packing)}</th><th>9. ${esc(L.description)}</th>
      <th class="n">11. ${esc(L.gross)}</th><th class="n">12. ${esc(L.volume)}</th></tr></thead>
      <tbody>${rows}<tr class="sum"><td>${esc(L.totals)}</td><td class="n">${q(doc.totalPackages)}</td><td></td><td></td><td class="n">${q(doc.totalGrossWeightKg)}</td><td></td></tr></tbody></table>
    <div class="grid">${field(L.instructions, q(doc.customsInstructions))}${field(L.charges, q(doc.carriageCharges))}</div>
    <div class="grid">${field(L.placeOfIssue, `${q(doc.placeOfIssue)} · ${q(doc.date)}`)}<div></div></div>
    <div class="sign"><div>22. ${esc(L.shipper)} · ${esc(L.signature)}</div><div>23. ${esc(L.carrier)} · ${esc(L.signature)}</div></div>`;
  return page(L.cmr, doc.number, doc.date, L, body, spec.language, options);
}

export function renderContract(source: Contract, spec: ShipmentSpec, options: RenderOptions = {}): string {
  const doc = track(source);
  const L = LABELS[spec.language];
  const f = formatter(spec.style);
  const body = `
    <div class="grid">${partyBox(L.seller, doc.seller, L.taxId)}${partyBox(L.buyer, doc.buyer, L.taxId)}</div>
    <p><b>1. ${esc(L.goodsDescription)}.</b> ${q(doc.goodsDescription)}</p>
    <table><thead><tr><th>${esc(L.model)}</th><th>${esc(L.description)}</th><th class="n">${esc(L.quantity)}</th><th>${esc(L.unit)}</th><th class="n">${esc(L.unitPrice)}</th></tr></thead>
      <tbody>${spec.lines.map((l) => `<tr><td>${esc(l.model)}</td><td>${esc(l.description)}</td><td class="n">${esc(f.number(l.quantity))}</td><td>${esc(l.unit)}</td><td class="n">${esc(f.number(l.unitPrice))}</td></tr>`).join("")}</tbody></table>
    <p><b>2. ${esc(L.contractTotal)}:</b> ${q(doc.totalAmount)}</p>
    <div class="words"><div class="label">${esc(L.inWords)}</div>${q(doc.totalInWords)}</div>
    <p><b>3. ${esc(L.incoterm)}:</b> ${q(doc.incoterm.code)} ${q(doc.incoterm.place)}, ${q(doc.incoterm.version)}. ${esc(L.currency)}: ${q(doc.currency)}.</p>
    <div class="sign"><div>${esc(L.seller)} · ${esc(L.signature)}</div><div>${esc(L.buyer)} · ${esc(L.signature)}</div></div>`;
  return page(L.contract, doc.number, doc.date, L, body, spec.language, options);
}

export function renderDeclaration(source: CustomsDeclaration): string {
  const doc = track(source);
  const L = LABELS.ka;
  const body = `
    <div class="grid">
      ${field("A · საბაჟო ორგანო", `${q(doc.customsOfficeCode)} · ${q(doc.customsOfficeName)}`)}
      ${field("B · შეფასება", `${q(doc.assessmentNumber)} · ${q(doc.assessmentDate)}`)}
      ${field("1 · რეჟიმი", q(doc.regime))}
      ${field("6 · შეფუთვების ჯამი", q(doc.totalPackages))}
      ${partyBox("2 · ექსპორტიორი", doc.exporter, L.taxId)}
      ${partyBox("8 · იმპორტიორი", doc.importer, L.taxId)}
      ${field("15 · გამომგზავნი ქვეყანა", q(doc.countryOfDispatch))}
      ${field("17 · დანიშნულების ქვეყანა", q(doc.countryOfDestination))}
      ${field("22 · ვალუტა და ფაქტურული ღირებულება", `${q(doc.currency)} ${q(doc.totalInvoiceAmount)}`)}
      ${field("23 · გაცვლითი კურსი", q(doc.exchangeRate))}
    </div>
    ${doc.items.map((item) => `<div class="grid">
      ${field("32 · საქონლის ნომერი", q(item.itemNumber))}
      ${field("31 · აღწერა და შეფუთვა", `${q(item.description)}<br>${q(item.packages)} ${q(item.packingMethod)}`)}
      ${field("33 · სასაქონლო კოდი", q(item.hsCode))}
      ${field("34ა · წარმოშობა", q(item.countryOfOrigin))}
      ${field("35 · ბრუტო წონა (კგ)", q(item.grossWeightKg))}
      ${field("37 · პროცედურა", q(item.procedure))}
      ${field("38 · ნეტო წონა (კგ)", q(item.netWeightKg))}
      ${field("41 · დამატებითი ერთეული", `${q(item.supplementaryQuantity)} ${q(item.supplementaryUnit)}`)}
      ${field("42 · ფაქტურული ღირებულება", q(item.invoiceValue))}
      ${field("46 · საბაჟო ღირებულება (ლარი)", q(item.customsValueGel))}
    </div>`).join("")}
    ${field("44 · თანდართული დოკუმენტები", doc.attachedDocuments.map(q).join("<br>"))}
  `;
  return page("საქონლის საბაჟო დეკლარაცია", doc.number, doc.date, { ...L, number: "A · რეგისტრაციის ნომერი", date: "რეგისტრაციის თარიღი" }, body, "ka");
}
