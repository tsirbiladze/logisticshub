/**
 * A synthetic shipment and the four documents built from it.
 *
 * The built documents are the "ideal extraction": every cited quote is the
 * exact string the HTML template prints, so the PDF and the extraction can
 * never drift apart. Variants mutate these documents before rendering.
 */
import {
  blankDocument,
  dec,
  documentSchema,
  mul,
  sum,
  toFixed,
  walkCited,
  type Cmr,
  type CommercialInvoice,
  type Contract,
  type MessageKey,
  type PackingList,
  type Party,
} from "@logisticshub/core";
import { formatter, type Formatter, type NumberStyle } from "./format.ts";

export type PackLanguage = "ka" | "en" | "ru" | "tr";

export interface PartySpec {
  name: string;
  address: string;
  country: string;
  registration: string;
}

export interface LineSpec {
  model: string;
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  packages: string;
  packing: string;
  netKg: string;
  grossKg: string;
  volumeM3: string;
  marks: string;
}

export interface ShipmentSpec {
  id: string;
  language: PackLanguage;
  style: NumberStyle;
  title: { ka: string; en: string };
  currency: string;
  seller: PartySpec;
  buyer: PartySpec;
  carrier: PartySpec;
  incoterm: { code: string; place: string; version: string };
  origin: string;
  /** Unit word printed after the package total, e.g. "ყუთი", "cartons". */
  packagesUnit: string;
  /** Whether the packing list prints a quantity per line. */
  packingListQuantities: boolean;
  invoice: { number: string; date: string };
  packingList: { number: string; date: string };
  contract: { number: string; date: string; goodsDescription: string };
  cmr: {
    number: string;
    date: string;
    placeOfIssue: string;
    takingOverPlace: string;
    takingOverDate: string;
    deliveryPlace: string;
    charges: string;
    instructions: string;
    convention: string;
    /** Box 5 entries; {invoice} and {packingList} are replaced by numbers. */
    attached: string[];
  };
  lines: LineSpec[];
  /** Total in words, as printed on invoice and contract. Must equal the total. */
  totalInWords: string;
}

export interface ShipmentDocuments {
  invoice: CommercialInvoice;
  packingList: PackingList;
  cmr: Cmr;
  contract: Contract;
  /** A second invoice in the set ("invoice-2"), when the variant adds one. It is the last document of the extraction. */
  secondInvoice?: CommercialInvoice;
}

export type DocumentName = "invoice" | "packing-list" | "cmr" | "contract" | "invoice-2";

/** The four documents every variant has, in the order of the extraction. */
export const DOCUMENT_NAMES: readonly DocumentName[] = ["invoice", "packing-list", "cmr", "contract"];

/** How a variant's files differ from one page of text per document. */
export interface Layout {
  /**
   * The invoice's table breaks before this line (0-based): page 1 ends with a
   * "carried forward" row, page 2 repeats the table header, opens with a
   * "brought forward" row and holds that line and all after it, the totals,
   * the packages and the amount in words.
   */
  invoiceBreakBefore?: number;
  /** Documents delivered as scans: image-only PDFs with no text layer. */
  scanned?: DocumentName[];
  /**
   * Documents delivered in one PDF, one after the other, each starting on a
   * new page: ["invoice", "packing-list"] is invoice-and-packing-list.pdf with
   * the invoice on page 1 and the packing list on page 2. Both entries of the
   * extraction name that file, and `page` is counted in the file.
   */
  combined?: DocumentName[];
}

export interface Variant {
  id: string;
  title: { ka: string; en: string };
  /** Exact set of finding keys the checker must report. */
  expected: MessageKey[];
  /**
   * Extraction issues the checker must report on the reference extraction,
   * each as "CODE path". Only for a document the checker cannot read for
   * certain although the extraction is right (mixed number conventions);
   * every other variant has none.
   */
  expectedIssues?: string[];
  /** How this variant's documents print numbers and dates, where it differs from the pack. */
  style?: Partial<NumberStyle>;
  mutate?: (docs: ShipmentDocuments, f: Formatter) => void;
  layout?: Layout;
}

export interface Pack {
  spec: ShipmentSpec;
  variants: Variant[];
}

/** A cited value on page 1. A variant's layout moves what it prints on page 2 (see applyLayout). */
export function cite(value: string | null, quote: string | null = value) {
  return { value, quote: value === null ? null : quote, page: value === null ? null : 1 };
}

function party(spec: PartySpec): Party {
  return { name: cite(spec.name), address: cite(spec.address), country: cite(spec.country) };
}

export function lineTotal(line: LineSpec): string {
  return toFixed(mul(dec(line.quantity), dec(line.unitPrice)), 2);
}

function total(values: string[], fractionDigits: number): string {
  return toFixed(sum(values.map(dec)), fractionDigits);
}

/** The packing methods of a shipment's lines, each once: "cartons", "cartons, pallets". */
function packingMethods(spec: ShipmentSpec): string {
  return spec.lines.map((l) => l.packing).filter((v, i, a) => a.indexOf(v) === i).join(", ");
}

function scaleOf(values: string[]): number {
  return Math.max(0, ...values.map((v) => v.split(".")[1]?.length ?? 0));
}

export function buildDocuments(spec: ShipmentSpec): ShipmentDocuments {
  const f = formatter(spec.style);
  const money = (v: string) => `${spec.currency} ${f.number(v)}`;
  const subtotal = total(spec.lines.map(lineTotal), 2);
  const packages = total(spec.lines.map((l) => l.packages), 0);
  const quantity = total(spec.lines.map((l) => l.quantity), scaleOf(spec.lines.map((l) => l.quantity)));
  const net = total(spec.lines.map((l) => l.netKg), scaleOf(spec.lines.map((l) => l.netKg)));
  const gross = total(spec.lines.map((l) => l.grossKg), scaleOf(spec.lines.map((l) => l.grossKg)));
  const volume = total(spec.lines.map((l) => l.volumeM3), scaleOf(spec.lines.map((l) => l.volumeM3)));
  const date = (iso: string) => cite(iso, f.date(iso));
  const num = (v: string) => cite(v, f.number(v));

  const invoice = blankDocument("commercial_invoice", "invoice");
  Object.assign(invoice, {
    sourceFile: "invoice.pdf",
    language: spec.language,
    number: cite(spec.invoice.number),
    date: date(spec.invoice.date),
    seller: party(spec.seller),
    buyer: party(spec.buyer),
    contractRef: { number: cite(spec.contract.number), date: date(spec.contract.date) },
    incoterm: { code: cite(spec.incoterm.code), place: cite(spec.incoterm.place), version: cite(spec.incoterm.version) },
    currency: cite(spec.currency),
    lines: spec.lines.map((l) => ({
      description: cite(l.description),
      model: cite(l.model),
      hsCode: cite(null),
      quantity: num(l.quantity),
      unit: cite(l.unit),
      unitPrice: num(l.unitPrice),
      lineTotal: num(lineTotal(l)),
    })),
    subtotal: cite(subtotal, money(subtotal)),
    total: cite(subtotal, money(subtotal)),
    totalInWords: cite(spec.totalInWords),
    packages: cite(packages, `${f.number(packages)} ${spec.packagesUnit}`),
    countryOfOrigin: cite(spec.origin),
  } satisfies Partial<CommercialInvoice>);

  const packingList = blankDocument("packing_list", "packing-list");
  Object.assign(packingList, {
    sourceFile: "packing-list.pdf",
    language: spec.language,
    number: cite(spec.packingList.number),
    date: date(spec.packingList.date),
    shipper: party(spec.seller),
    consignee: party(spec.buyer),
    invoiceRef: { number: cite(spec.invoice.number), date: date(spec.invoice.date) },
    // Printed once in the header, not per line.
    packingMethod: cite(packingMethods(spec)),
    lines: spec.lines.map((l) => ({
      description: cite(l.description),
      model: cite(l.model),
      quantity: spec.packingListQuantities ? num(l.quantity) : cite(null),
      unit: spec.packingListQuantities ? cite(l.unit) : cite(null),
      packages: num(l.packages),
      packingMethod: cite(null),
      netWeightKg: num(l.netKg),
      grossWeightKg: num(l.grossKg),
      volumeM3: num(l.volumeM3),
    })),
    totalQuantity: spec.packingListQuantities ? num(quantity) : cite(null),
    totalPackages: num(packages),
    totalNetWeightKg: num(net),
    totalGrossWeightKg: num(gross),
    totalVolumeM3: num(volume),
  } satisfies Partial<PackingList>);

  const attached = spec.cmr.attached.map((entry) =>
    cite(entry.replace("{invoice}", spec.invoice.number).replace("{packingList}", spec.packingList.number)),
  );
  const cmr = blankDocument("cmr", "cmr");
  Object.assign(cmr, {
    sourceFile: "cmr.pdf",
    language: spec.language,
    number: cite(spec.cmr.number),
    date: date(spec.cmr.date),
    placeOfIssue: cite(spec.cmr.placeOfIssue),
    sender: party(spec.seller),
    carrier: party(spec.carrier),
    placeOfTakingOver: cite(spec.cmr.takingOverPlace),
    dateOfTakingOver: date(spec.cmr.takingOverDate),
    placeOfDelivery: cite(spec.cmr.deliveryPlace),
    consignee: party(spec.buyer),
    goods: spec.lines.map((l) => ({
      marksAndNumbers: cite(l.marks),
      packages: num(l.packages),
      packingMethod: cite(l.packing),
      description: cite(l.description),
      grossWeightKg: num(l.grossKg),
      volumeM3: num(l.volumeM3),
    })),
    totalPackages: num(packages),
    totalGrossWeightKg: num(gross),
    carriageCharges: cite(spec.cmr.charges),
    customsInstructions: cite(spec.cmr.instructions),
    convention: cite(spec.cmr.convention),
    attachedDocuments: attached,
  } satisfies Partial<Cmr>);

  const contract = blankDocument("contract", "contract");
  Object.assign(contract, {
    sourceFile: "contract.pdf",
    language: spec.language,
    number: cite(spec.contract.number),
    date: date(spec.contract.date),
    seller: party(spec.seller),
    buyer: party(spec.buyer),
    incoterm: { code: cite(spec.incoterm.code), place: cite(spec.incoterm.place), version: cite(spec.incoterm.version) },
    currency: cite(spec.currency),
    totalAmount: cite(subtotal, money(subtotal)),
    totalInWords: cite(spec.totalInWords),
    goodsDescription: cite(spec.contract.goodsDescription),
  } satisfies Partial<Contract>);

  return { invoice, packingList, cmr, contract };
}

/** The document of a variant by its name; undefined for a second invoice the variant does not have. */
export function documentOf(docs: ShipmentDocuments, name: DocumentName): ShipmentDocuments[keyof ShipmentDocuments] {
  return { invoice: docs.invoice, "packing-list": docs.packingList, cmr: docs.cmr, contract: docs.contract, "invoice-2": docs.secondInvoice }[name];
}

/** The documents a variant has, in the order of its extraction: the four of every pack, then a second invoice. */
export function documentNames(docs: ShipmentDocuments): DocumentName[] {
  return [...DOCUMENT_NAMES, ...(docs.secondInvoice ? (["invoice-2"] as const) : [])];
}

/** The PDF files of a variant, each with the documents it holds in page order. */
export function variantFiles(layout: Layout | undefined, names: readonly DocumentName[] = DOCUMENT_NAMES): { file: string; documents: DocumentName[] }[] {
  const combined = layout?.combined ?? [];
  const files: { file: string; documents: DocumentName[] }[] = [];
  for (const name of names) {
    if (!combined.includes(name)) files.push({ file: `${name}.pdf`, documents: [name] });
    else if (name === combined[0]) files.push({ file: `${combined.join("-and-")}.pdf`, documents: [...combined] });
  }
  return files;
}

/**
 * Gives every fact the page its layout prints it on, and every document the
 * file it is in. Run after the variant's changes, so the extraction's page
 * numbers cannot drift from the PDF.
 */
export function applyLayout(docs: ShipmentDocuments, layout: Layout | undefined): void {
  invoicePages(docs, layout);
  for (const { file, documents } of variantFiles(layout, documentNames(docs))) {
    if (documents.length < 2) continue;
    let before = 0;
    for (const name of documents) {
      const doc = documentOf(docs, name)!;
      doc.sourceFile = file;
      // The page is counted in the file: the second document's first page is the page after the first document's last.
      if (before > 0) walkCited(documentSchema, doc, ({ field }) => void (field.page = field.page === null ? null : field.page + before));
      before += pageCount(layout, name);
    }
  }
}

function invoicePages(docs: ShipmentDocuments, layout: Layout | undefined): void {
  const from = layout?.invoiceBreakBefore;
  if (from === undefined) return;
  const { invoice } = docs;
  const onPageTwo = [
    ...invoice.lines.slice(from).flatMap((line) => Object.values(line)),
    invoice.subtotal,
    invoice.discount,
    invoice.discountPercent,
    invoice.freight,
    invoice.insurance,
    ...invoice.otherCharges,
    invoice.tax,
    invoice.total,
    invoice.totalInWords,
    invoice.packages,
  ];
  for (const field of onPageTwo) if (field.value !== null) field.page = 2;
}

/** Number of pages each of a variant's documents takes. */
export function pageCount(layout: Layout | undefined, document: DocumentName): number {
  return document === "invoice" && layout?.invoiceBreakBefore !== undefined ? 2 : 1;
}

/** Sets a decimal field with the pack's printed format, e.g. setNumber(f, line.packages, "30"). */
export function printed(f: Formatter, value: string, suffix = "") {
  return cite(value, `${f.number(value)}${suffix}`);
}
