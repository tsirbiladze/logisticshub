/**
 * Cross-document rules. With several documents of one type, the first one
 * is used (DOC-01 says so in the report).
 */
import { compare, equals, sum, type Decimal } from "../../decimal.ts";
import type { CitedDecimal, CitedText, Party, TradeDocument } from "../../schema.ts";
import {
  containsRef,
  currencyCode,
  evidence,
  foldName,
  isoDate,
  normalizeRef,
  num,
  roundingTolerance,
  sameParty,
  sameWithin,
  show,
  sumAll,
  text,
} from "../helpers.ts";
import type { Role } from "../messages.ts";
import type { Evidence, Finding, Rule } from "../types.ts";

/** JSON [[type, value], …], localized by formatMessage. */
const encode = (entries: [TradeDocument["type"], string | null][]) => JSON.stringify(entries.map(([type, value]) => [type, value ?? ""]));

/** A value read from a document; `computed` when it is a sum of lines rather than a printed figure. */
type Observed = { doc: TradeDocument; path: string; field: CitedDecimal; value: Decimal; computed: boolean };

function observe(doc: TradeDocument | undefined, path: string, field: CitedDecimal | undefined): Observed | null {
  if (!doc || !field) return null;
  const value = num(field);
  return value ? { doc, path, field, value, computed: false } : null;
}

const cite = (o: Observed) => evidence(o.doc, o.path, o.field, o.computed);

/** A total stated on the document, or the sum of its lines if not stated. */
function statedOrSum<L>(
  doc: TradeDocument | undefined,
  totalPath: string,
  total: CitedDecimal | undefined,
  lines: readonly L[] | undefined,
  linesPath: string,
  pick: (line: L) => CitedDecimal,
): Observed | null {
  const stated = observe(doc, totalPath, total);
  if (stated || !doc || !lines) return stated;
  const summed = sumAll(lines, pick);
  if (!summed) return null;
  // A computed sum has no single quote; point at the page of the first line.
  const first = lines[0];
  const page = first ? pick(first).page : null;
  return { doc, path: `${linesPath}[*]`, field: { value: show(summed), quote: null, page }, value: summed, computed: true };
}

/**
 * Compares the same quantity across documents; one finding listing all values.
 *
 * Every two documents must agree, not each with the first one: 1000.0, 1000.5
 * and 999.5 kg are each within 0.5 kg of the first, and the last two are
 * still 1.0 kg apart. Two values agree when they are within the tolerance of
 * either, so where the tolerance follows the printed precision the coarser
 * value of a pair sets it, whichever document prints it.
 */
function agree(
  observed: (Observed | null)[],
  tolerance: (o: Observed) => Decimal | string,
  finding: (values: string, evidence: Evidence[]) => Finding,
): Finding[] {
  const present = observed.filter((o): o is Observed => o !== null);
  if (present.length < 2) return [];
  const same = (a: Observed, b: Observed) => sameWithin(a.value, b.value, tolerance(a)) || sameWithin(a.value, b.value, tolerance(b));
  if (present.every((a, i) => present.slice(i + 1).every((b) => same(a, b)))) return [];
  const values = encode(present.map((o) => [o.doc.type, o.field.value]));
  return [finding(values, present.map(cite))];
}

/** Packing method words by kind (folded stems; a word matches when it starts with one). */
export const PACKING_KINDS: Record<string, string[]> = {
  carton: ["carton", "ctn", "box", "karton", "kutu", "koli", "короб", "ящик", "ყუთ", "კოლოფ"],
  pallet: ["pallet", "palet", "plt", "паллет", "палет", "поддон", "პალეტ"],
  crate: ["crate", "sandik", "обрешет"],
  bag: ["bag", "sack", "мешок", "мешк", "cuval", "torba", "ტომარ"],
  roll: ["roll", "рулон", "rulo", "რულონ"],
  bale: ["bale", "кип", "balya"],
  drum: ["drum", "barrel", "бочк", "varil", "კასრ"],
  bundle: ["bundle", "пачк", "связк", "demet", "შეკვრ"],
  case: ["case"],
};

const PACKING_STEMS = Object.entries(PACKING_KINDS)
  .flatMap(([kind, stems]) => stems.map((stem) => [foldName(stem), kind] as const))
  .sort((a, b) => b[0].length - a[0].length);

/**
 * Normalized packing method of some texts ("82 cartons", "მუყაოს ყუთი"):
 * the kinds named, joined ("carton", "carton+pallet"), or null when none is.
 * Generic words ("packages", "места", "kap") name no kind.
 */
export function packingKind(texts: (string | null)[]): string | null {
  const kinds = new Set<string>();
  for (const value of texts) {
    for (const word of foldName(value ?? "").match(/\p{L}+/gu) ?? []) {
      const match = PACKING_STEMS.find(([stem]) => word.startsWith(stem));
      if (match) kinds.add(match[1]);
    }
  }
  return kinds.size > 0 ? [...kinds].sort().join("+") : null;
}

/**
 * Spellings of the same unit of measure, by unit. A unit is compared after
 * folding (case, accents, dots and spaces), so "PCS." equals "pcs", and
 * without a plain English plural ending, so "rolls" equals "roll"; these
 * lists add the spellings neither can join ("pcs", "pieces", "шт").
 */
export const UNIT_ALIASES: Record<string, string[]> = {
  piece: ["pc", "pcs", "pce", "pces", "piece", "pieces", "ea", "each", "шт", "штук", "штука", "штуки", "ცალი", "ც", "adet", "ad"],
  set: ["set", "sets", "компл", "комплект", "комплекта", "комплектов", "კომპლექტი", "კომპლ", "takım", "tk"],
  pair: ["pair", "pairs", "pr", "prs", "пара", "пары", "пар", "წყვილი", "çift"],
  kg: ["kg", "kgs", "kilogram", "kilograms", "кг", "კგ"],
  m: ["m", "meter", "meters", "metre", "metres", "м", "მ"],
  m2: ["m2", "sqm", "sq m", "кв м", "м2", "მ2"],
  l: ["l", "lt", "ltr", "liter", "liters", "litre", "litres", "л", "ლ"],
};

/** Folded unit without dots and spaces: "PCS." -> "pcs", "m²" -> "m2". */
const foldUnit = (value: string) => foldName(value).replace(/[^\p{L}\p{N}]+/gu, "");

const UNIT_KEYS = new Map(Object.entries(UNIT_ALIASES).flatMap(([unit, spellings]) => spellings.map((spelling) => [foldUnit(spelling), unit] as const)));

/**
 * The singular of a plain English plural: "rolls" -> "roll", "boxes" ->
 * "box", "batches" -> "batch". Only Latin words of four letters or more that
 * end in one "s" ("gross" and "pcs" stay as they are).
 */
function singular(unit: string): string {
  if (!/^[a-z]{3,}s$/.test(unit) || unit.endsWith("ss")) return unit;
  return /(?:x|z|ch|sh|ss)es$/.test(unit) ? unit.slice(0, -2) : unit.slice(0, -1);
}

/**
 * One key per unit of measure, or null when no unit is written: the unit's
 * name from UNIT_ALIASES, or else the folded spelling without a plain plural
 * ending, so "roll" and "rolls" count the same thing.
 */
export function unitKey(value: string | null): string | null {
  const folded = foldUnit(value ?? "");
  if (!folded) return null;
  const one = singular(folded);
  return UNIT_KEYS.get(folded) ?? UNIT_KEYS.get(one) ?? one;
}

/** The distinct units of the lines that state a quantity, sorted. */
function unitsOf(lines: readonly { quantity: CitedDecimal; unit: CitedText }[]): string[] {
  const units = lines.flatMap((line) => {
    const unit = line.quantity.value === null ? null : unitKey(line.unit.value);
    return unit ? [unit] : [];
  });
  return [...new Set(units)].sort();
}

/**
 * Quantities are comparable when they count the same thing: the units are
 * equal, or one side names none. 400 pieces and 40 cartons are not compared.
 */
function sameUnits(a: string[], b: string[]): boolean {
  return a.length === 0 || b.length === 0 || a.join("|") === b.join("|");
}

/** CUR-01: one currency across invoices and contracts. */
export const currencies: Rule = {
  id: "CUR-01",
  run({ invoices, contracts }) {
    // A currency that is not a code ("€") is an extraction issue, not a second currency.
    const docs = [...invoices, ...contracts].filter((d) => currencyCode(d.currency));
    const distinct = new Set(docs.map((d) => d.currency.value));
    if (distinct.size < 2) return [];
    return [
      {
        rule: "CUR-01",
        severity: "error",
        key: "CUR-01.mismatch",
        params: { currencies: encode(docs.map((d) => [d.type, d.currency.value])) },
        evidence: docs.map((d) => evidence(d, "currency", d.currency)),
      },
    ];
  },
};

type ModelLine = { model: CitedText; quantity: CitedDecimal; unit: CitedText };

/** One model's lines on a document: a model split over several lines counts once, with the summed quantity. */
type ModelGroup = { model: string; lines: { line: ModelLine; i: number }[]; quantity: Decimal | null; shown: string; units: string[] };

function groupByModel(lines: readonly ModelLine[]): Map<string, ModelGroup> {
  const groups = new Map<string, ModelGroup>();
  lines.forEach((line, i) => {
    const key = normalizeRef(line.model.value!);
    const group = groups.get(key) ?? { model: line.model.value!, lines: [], quantity: null, shown: "", units: [] };
    group.lines.push({ line, i });
    groups.set(key, group);
  });
  for (const group of groups.values()) {
    group.units = unitsOf(group.lines.map(({ line }) => line));
    const quantities = group.lines.map(({ line }) => num(line.quantity));
    if (!quantities.every((q): q is Decimal => q !== null)) continue;
    group.quantity = sum(quantities);
    // One line: the figure as printed; several: their sum.
    group.shown = group.lines.length === 1 ? group.lines[0]!.line.quantity.value! : show(group.quantity);
  }
  return groups;
}

/**
 * QTY-01: quantities per model (or in total) and package counts agree.
 * Quantities in different units, and package counts of different packing
 * methods, are not compared.
 */
export const quantities: Rule = {
  id: "QTY-01",
  run({ invoices, packingLists, cmrs }) {
    const findings: Finding[] = [];
    const invoice = invoices[0];
    const pl = packingLists[0];
    const cmr = cmrs[0];

    if (invoice && pl) {
      const byModel = (lines: { model: { value: string | null } }[]) =>
        lines.length > 0 && lines.every((l) => l.model.value) ? lines : null;
      const invLines = byModel(invoice.lines);
      const plLines = byModel(pl.lines);
      if (invLines && plLines && pl.lines.every((l) => l.quantity.value)) {
        const plIndex = groupByModel(pl.lines);
        const invIndex = groupByModel(invoice.lines);
        const missing = (doc: TradeDocument, group: ModelGroup, present: TradeDocument["type"], absent: TradeDocument["type"]): Finding => ({
          rule: "QTY-01",
          severity: "error",
          key: "QTY-01.missing-line",
          params: { model: group.model, present, missing: absent },
          evidence: group.lines.map(({ line, i }) => evidence(doc, `lines[${i}].model`, line.model)),
        });
        for (const [model, group] of invIndex) {
          const match = plIndex.get(model);
          if (!match) {
            findings.push(missing(invoice, group, "commercial_invoice", "packing_list"));
            continue;
          }
          // One model in two units on one document (pieces and sets) has no single quantity.
          const comparable = group.units.length <= 1 && match.units.length <= 1 && sameUnits(group.units, match.units);
          if (comparable && group.quantity && match.quantity && !equals(group.quantity, match.quantity)) {
            findings.push({
              rule: "QTY-01",
              severity: "error",
              key: "QTY-01.line",
              params: { model: group.model, invoice: group.shown, packingList: match.shown },
              evidence: [
                ...group.lines.map(({ line, i }) => evidence(invoice, `lines[${i}].quantity`, line.quantity)),
                ...match.lines.map(({ line, i }) => evidence(pl, `lines[${i}].quantity`, line.quantity)),
              ],
            });
          }
        }
        for (const [model, group] of plIndex) {
          if (!invIndex.has(model)) findings.push(missing(pl, group, "packing_list", "commercial_invoice"));
        }
      } else {
        const invQty = statedOrSum(invoice, "lines", undefined, invoice.lines, "lines", (l) => l.quantity);
        const plQty = statedOrSum(pl, "totalQuantity", pl.totalQuantity, pl.lines, "lines", (l) => l.quantity);
        if (invQty && plQty && sameUnits(unitsOf(invoice.lines), unitsOf(pl.lines)) && !equals(invQty.value, plQty.value)) {
          findings.push({
            rule: "QTY-01",
            severity: "error",
            key: "QTY-01.quantity",
            params: { invoice: invQty.field.value!, packingList: plQty.field.value! },
            evidence: [cite(invQty), cite(plQty)],
          });
        }
      }
    }

    // Package counts, each with the packing method its document names.
    const counts: [Observed | null, string | null][] = [
      [observe(invoice, "packages", invoice?.packages), packingKind([invoice?.packages.quote ?? null])],
      [
        statedOrSum(pl, "totalPackages", pl?.totalPackages, pl?.lines, "lines", (l) => l.packages),
        packingKind([
          pl?.packingMethod.value ?? null,
          pl?.totalPackages.quote ?? null,
          ...(pl?.lines ?? []).flatMap((l) => [l.packingMethod.value, l.packages.quote]),
        ]),
      ],
      [
        statedOrSum(cmr, "totalPackages", cmr?.totalPackages, cmr?.goods, "goods", (g) => g.packages),
        packingKind([
          cmr?.totalPackages.quote ?? null,
          ...(cmr?.goods ?? []).flatMap((g) => [g.packingMethod.value, g.packages.quote]),
        ]),
      ],
    ];
    const present = counts.filter((c): c is [Observed, string | null] => c[0] !== null);
    const kinds = [...new Set(present.flatMap(([, kind]) => (kind ? [kind] : [])))];
    // 12 pallets and 82 cartons are not a mismatch: with different packing
    // methods, only counts of the same method are compared, and a count
    // without a stated method is left out (it could be either).
    const groups = kinds.length > 1 ? kinds.map((kind) => present.filter(([, k]) => k === kind)) : [present];
    for (const group of groups) {
      findings.push(
        ...agree(
          group.map(([o]) => o),
          (o) => roundingTolerance(o.value),
          (values, ev) => ({ rule: "QTY-01", severity: "error", key: "QTY-01.packages", params: { values }, evidence: ev }),
        ),
      );
    }
    return findings;
  },
};

/** WGT-01: gross weight is never below net weight. */
export const grossVsNet: Rule = {
  id: "WGT-01",
  run({ invoices, packingLists }) {
    const findings: Finding[] = [];
    const check = (doc: TradeDocument, where: string, netPath: string, net: CitedDecimal, grossPath: string, gross: CitedDecimal) => {
      const n = num(net);
      const g = num(gross);
      if (!n || !g || compare(g, n) >= 0) return;
      findings.push({
        rule: "WGT-01",
        severity: "error",
        key: "WGT-01.gross-below-net",
        params: { where, net: net.value!, gross: gross.value! },
        evidence: [evidence(doc, grossPath, gross), evidence(doc, netPath, net)],
      });
    };
    for (const invoice of invoices) {
      check(invoice, "commercial_invoice", "netWeightKg", invoice.netWeightKg, "grossWeightKg", invoice.grossWeightKg);
    }
    for (const pl of packingLists) {
      pl.lines.forEach((line, i) =>
        check(pl, `packing_list:line:${i + 1}`, `lines[${i}].netWeightKg`, line.netWeightKg, `lines[${i}].grossWeightKg`, line.grossWeightKg),
      );
      check(pl, "packing_list:total", "totalNetWeightKg", pl.totalNetWeightKg, "totalGrossWeightKg", pl.totalGrossWeightKg);
    }
    return findings;
  },
};

/** WGT-02: the same weights on invoice, packing list and CMR. */
export const weightsAgree: Rule = {
  id: "WGT-02",
  run({ invoices, packingLists, cmrs, options }) {
    const invoice = invoices[0];
    const pl = packingLists[0];
    const cmr = cmrs[0];
    const tolerance = () => options.weightToleranceKg;
    return [
      ...agree(
        [
          statedOrSum(pl, "totalGrossWeightKg", pl?.totalGrossWeightKg, pl?.lines, "lines", (l) => l.grossWeightKg),
          statedOrSum(cmr, "totalGrossWeightKg", cmr?.totalGrossWeightKg, cmr?.goods, "goods", (g) => g.grossWeightKg),
          observe(invoice, "grossWeightKg", invoice?.grossWeightKg),
        ],
        tolerance,
        (values, ev) => ({ rule: "WGT-02", severity: "error", key: "WGT-02.gross", params: { values }, evidence: ev }),
      ),
      ...agree(
        [
          statedOrSum(pl, "totalNetWeightKg", pl?.totalNetWeightKg, pl?.lines, "lines", (l) => l.netWeightKg),
          observe(invoice, "netWeightKg", invoice?.netWeightKg),
        ],
        tolerance,
        (values, ev) => ({ rule: "WGT-02", severity: "error", key: "WGT-02.net", params: { values }, evidence: ev }),
      ),
    ];
  },
};

/** REF-01: documents refer to each other by the right numbers and dates. */
export const references: Rule = {
  id: "REF-01",
  run({ invoices, packingLists, cmrs, contracts }) {
    const findings: Finding[] = [];
    const invoice = invoices[0];
    const pl = packingLists[0];
    const cmr = cmrs[0];
    const contract = contracts[0];

    const sameRef = (a: string, b: string) => normalizeRef(a) === normalizeRef(b);

    if (invoice && pl) {
      const expected = text(invoice.number);
      const found = text(pl.invoiceRef.number);
      if (expected && found && !sameRef(expected, found)) {
        findings.push({
          rule: "REF-01",
          severity: "error",
          key: "REF-01.invoice-number",
          params: { expected, found },
          evidence: [evidence(pl, "invoiceRef.number", pl.invoiceRef.number), evidence(invoice, "number", invoice.number)],
        });
      }
      const expectedDate = isoDate(invoice.date);
      const foundDate = isoDate(pl.invoiceRef.date);
      if (expectedDate && foundDate && expectedDate !== foundDate) {
        findings.push({
          rule: "REF-01",
          severity: "error",
          key: "REF-01.invoice-date",
          params: { expected: expectedDate, found: foundDate },
          evidence: [evidence(pl, "invoiceRef.date", pl.invoiceRef.date), evidence(invoice, "date", invoice.date)],
        });
      }
    }

    if (invoice && contract) {
      const expected = text(contract.number);
      const found = text(invoice.contractRef.number);
      if (expected && found && !sameRef(expected, found)) {
        findings.push({
          rule: "REF-01",
          severity: "error",
          key: "REF-01.contract-number",
          params: { expected, found },
          evidence: [evidence(invoice, "contractRef.number", invoice.contractRef.number), evidence(contract, "number", contract.number)],
        });
      }
      const expectedDate = isoDate(contract.date);
      const foundDate = isoDate(invoice.contractRef.date);
      if (expectedDate && foundDate && expectedDate !== foundDate) {
        findings.push({
          rule: "REF-01",
          severity: "error",
          key: "REF-01.contract-date",
          params: { expected: expectedDate, found: foundDate },
          evidence: [evidence(invoice, "contractRef.date", invoice.contractRef.date), evidence(contract, "date", contract.date)],
        });
      }
    }

    if (cmr && cmr.attachedDocuments.length > 0) {
      const listed = cmr.attachedDocuments.map((d) => d.value ?? "");
      for (const doc of [invoice, pl]) {
        const number = doc ? text(doc.number) : null;
        if (!doc || !number) continue;
        if (listed.some((entry) => containsRef(entry, number))) continue;
        findings.push({
          rule: "REF-01",
          severity: "warning",
          key: "REF-01.cmr-missing-document",
          params: { document: doc.type, number },
          evidence: cmr.attachedDocuments.map((d, i) => evidence(cmr, `attachedDocuments[${i}]`, d)),
        });
      }
    }
    return findings;
  },
};

/** DATE-01: contract ≤ invoice ≤ taking over of the goods. */
export const dateOrder: Rule = {
  id: "DATE-01",
  run({ invoices, cmrs, contracts }) {
    const findings: Finding[] = [];
    const invoice = invoices[0];
    const cmr = cmrs[0];
    const contract = contracts[0];
    const invoiceDate = invoice ? isoDate(invoice.date) : null;
    if (!invoice || !invoiceDate) return findings;

    const contractDate = contract ? isoDate(contract.date) : null;
    if (contract && contractDate && contractDate > invoiceDate) {
      findings.push({
        rule: "DATE-01",
        severity: "error",
        key: "DATE-01.contract-after-invoice",
        params: { contract: contractDate, invoice: invoiceDate },
        evidence: [evidence(contract, "date", contract.date), evidence(invoice, "date", invoice.date)],
      });
    }
    if (cmr) {
      const [path, field] = cmr.dateOfTakingOver.value ? ["dateOfTakingOver", cmr.dateOfTakingOver] : ["date", cmr.date];
      const shipment = isoDate(field);
      if (shipment && invoiceDate > shipment) {
        findings.push({
          rule: "DATE-01",
          severity: "warning",
          key: "DATE-01.invoice-after-shipment",
          params: { invoice: invoiceDate, shipment },
          evidence: [evidence(invoice, "date", invoice.date), evidence(cmr, path, field)],
        });
      }
    }
    return findings;
  },
};

/** PTY-01: seller, buyer and consignee are the same parties everywhere. */
export const parties: Rule = {
  id: "PTY-01",
  run({ invoices, packingLists, cmrs, contracts }) {
    const findings: Finding[] = [];
    const invoice = invoices[0];
    const pl = packingLists[0];
    const cmr = cmrs[0];
    const contract = contracts[0];
    if (!invoice) return findings;

    type Side = { doc: TradeDocument; path: string; party: Party } | null;
    const side = (doc: TradeDocument | undefined, path: string, party: Party | undefined): Side =>
      doc && party && text(party.name) ? { doc, path, party } : null;

    const consignee = text(invoice.consignee.name) ? side(invoice, "consignee", invoice.consignee) : side(invoice, "buyer", invoice.buyer);
    const pairs: [Role, Side, Side][] = [
      ["seller", side(invoice, "seller", invoice.seller), side(contract, "seller", contract?.seller)],
      ["seller", side(invoice, "seller", invoice.seller), side(pl, "shipper", pl?.shipper)],
      ["seller", side(invoice, "seller", invoice.seller), side(cmr, "sender", cmr?.sender)],
      ["buyer", side(invoice, "buyer", invoice.buyer), side(contract, "buyer", contract?.buyer)],
      ["consignee", consignee, side(pl, "consignee", pl?.consignee)],
      ["consignee", consignee, side(cmr, "consignee", cmr?.consignee)],
    ];
    for (const [role, a, b] of pairs) {
      if (!a || !b) continue;
      const nameA = text(a.party.name)!;
      const nameB = text(b.party.name)!;
      if (sameParty(nameA, nameB) !== false) continue;
      findings.push({
        rule: "PTY-01",
        severity: "warning",
        key: "PTY-01.name",
        params: { role, a: nameA, aDocument: a.doc.type, b: nameB, bDocument: b.doc.type },
        evidence: [evidence(a.doc, `${a.path}.name`, a.party.name), evidence(b.doc, `${b.path}.name`, b.party.name)],
      });
    }
    return findings;
  },
};

export const INCOTERMS_2020 = new Set(["EXW", "FCA", "CPT", "CIP", "DAP", "DPU", "DDP", "FAS", "FOB", "CFR", "CIF"]);
export const SEA_ONLY = new Set(["FAS", "FOB", "CFR", "CIF"]);
export const SELLER_INSURES = new Set(["CIF", "CIP"]);

/** Incoterms 2020 rules by name, in English and common Russian and Turkish spellings. */
export const INCOTERM_NAMES: Record<string, string> = {
  "Ex Works": "EXW",
  "Free Carrier": "FCA",
  "Carriage Paid To": "CPT",
  "Carriage and Insurance Paid To": "CIP",
  "Delivered at Place": "DAP",
  "Delivered at Place Unloaded": "DPU",
  "Delivered Duty Paid": "DDP",
  "Free Alongside Ship": "FAS",
  "Free on Board": "FOB",
  "Cost and Freight": "CFR",
  "Cost Insurance and Freight": "CIF",
  "Франко завод": "EXW",
  "Франко перевозчик": "FCA",
  "Перевозка оплачена до": "CPT",
  "Перевозка и страхование оплачены до": "CIP",
  "Поставка в месте назначения": "DAP",
  "Поставка в месте назначения с разгрузкой": "DPU",
  "Поставка с оплатой пошлин": "DDP",
  "Поставка с оплатой пошлины": "DDP",
  "Франко вдоль борта судна": "FAS",
  "Франко борт": "FOB",
  "Стоимость и фрахт": "CFR",
  "Стоимость страхование и фрахт": "CIF",
  "İşyerinde Teslim": "EXW",
  "Taşıyıcıya Teslim": "FCA",
  "Taşıma Ödenmiş Olarak Teslim": "CPT",
  "Taşıma ve Sigorta Ödenmiş Olarak Teslim": "CIP",
  "Belirlenen Yerde Teslim": "DAP",
  "Belirlenen Yerde Boşaltılmış Olarak Teslim": "DPU",
  "Gümrük Vergisi Ödenmiş Olarak Teslim": "DDP",
  "Gümrük Vergileri Ödenmiş Olarak Teslim": "DDP",
  "Gemi Doğrultusunda Teslim": "FAS",
  "Gemi Yanında Teslim": "FAS",
  "Gemide Teslim": "FOB",
  "Masraflar ve Navlun Ödenmiş Olarak Teslim": "CFR",
  "Masraflar Sigorta ve Navlun Ödenmiş Olarak Teslim": "CIF",
};

const lettersOnly = (value: string) => foldName(value).replace(/[^\p{L}]/gu, "");
const INCOTERM_NAME_KEYS = Object.entries(INCOTERM_NAMES)
  .map(([name, code]) => [lettersOnly(name), code] as const)
  .sort((a, b) => b[0].length - a[0].length);

/**
 * The Incoterms 2020 code of a written rule, or null when it is not one:
 * "FCA", "C.I.F.", "D-A-P Tbilisi", "Ex Works", "Франко завод", "Gemide Teslim".
 */
export function incotermCode(value: string | null): string | null {
  const folded = foldName(value ?? "").trim();
  if (!folded) return null;
  // Three letters, maybe dotted or spaced, then a non-letter: the code itself.
  const match = /^([a-z])[.\s-]*([a-z])[.\s-]*([a-z])/u.exec(folded);
  if (match && !/\p{L}/u.test(folded.charAt(match[0].length))) {
    const code = `${match[1]}${match[2]}${match[3]}`.toUpperCase();
    if (INCOTERMS_2020.has(code)) return code;
  }
  const letters = lettersOnly(folded);
  return INCOTERM_NAME_KEYS.find(([name]) => letters.startsWith(name))?.[1] ?? null;
}

/** INC-01: one known Incoterms rule on invoice and contract. */
export const incoterms: Rule = {
  id: "INC-01",
  run({ invoices, contracts }) {
    const findings: Finding[] = [];
    const docs = [...invoices, ...contracts].filter((d) => text(d.incoterm.code));
    for (const doc of docs) {
      if (incotermCode(doc.incoterm.code.value)) continue;
      findings.push({
        rule: "INC-01",
        severity: "warning",
        key: "INC-01.unknown",
        params: { code: doc.incoterm.code.value! },
        evidence: [evidence(doc, "incoterm.code", doc.incoterm.code)],
      });
    }
    // Unrecognized rules have their own warning and are left out here.
    const known = docs.filter((d) => incotermCode(d.incoterm.code.value));
    if (new Set(known.map((d) => incotermCode(d.incoterm.code.value))).size > 1) {
      findings.push({
        rule: "INC-01",
        severity: "error",
        key: "INC-01.mismatch",
        params: { codes: encode(known.map((d) => [d.type, d.incoterm.code.value])) },
        evidence: known.map((d) => evidence(d, "incoterm.code", d.incoterm.code)),
      });
    }
    return findings;
  },
};

function agreedIncoterm(context: Parameters<Rule["run"]>[0]) {
  const doc = [...context.invoices, ...context.contracts].find((d) => incotermCode(d.incoterm.code.value));
  return doc ? { doc, code: incotermCode(doc.incoterm.code.value)! } : null;
}

/** INC-02: sea-only rules (FAS, FOB, CFR, CIF) used for a road shipment. */
export const seaTermOnRoad: Rule = {
  id: "INC-02",
  run(context) {
    const agreed = agreedIncoterm(context);
    if (!agreed || !SEA_ONLY.has(agreed.code) || context.cmrs.length === 0) return [];
    return [
      {
        rule: "INC-02",
        severity: "warning",
        key: "INC-02.sea-term-road",
        params: { code: agreed.code },
        evidence: [evidence(agreed.doc, "incoterm.code", agreed.doc.incoterm.code)],
      },
    ];
  },
};

export const INSURANCE_TITLE = /insur|assur|страх|sigort|დაზღვ/iu;

/** INC-03: CIF/CIP need proof of insurance. */
export const insurance: Rule = {
  id: "INC-03",
  run(context) {
    const agreed = agreedIncoterm(context);
    if (!agreed || !SELLER_INSURES.has(agreed.code)) return [];
    // "SİGORTA": JS case folding misses the dotted capital İ, so test a Turkish-lowercased copy too.
    const isInsurance = (title: string) => INSURANCE_TITLE.test(title) || INSURANCE_TITLE.test(title.toLocaleLowerCase("tr"));
    const hasDocument = context.others.some((d) => isInsurance(d.title.value ?? ""));
    const hasCharge = context.invoices.some((i) => i.insurance.value !== null);
    if (hasDocument || hasCharge) return [];
    return [
      {
        rule: "INC-03",
        severity: "warning",
        key: "INC-03.no-insurance",
        params: { code: agreed.code },
        evidence: [evidence(agreed.doc, "incoterm.code", agreed.doc.incoterm.code)],
      },
    ];
  },
};
