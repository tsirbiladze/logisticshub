/**
 * Extraction schema: what the LLM (or the host agent) fills in from the
 * documents. Every fact carries the exact quote and page it came from, so
 * each finding in the report can point back to the source.
 *
 * Model-facing rules (Claude structured outputs and similar):
 * - every field is required; "not in the document" is expressed as null;
 * - no numeric/string length constraints and no recursion;
 * - number formats are validated after extraction (see validate.ts), so a
 *   malformed value becomes a visible issue instead of a rejected response.
 */
import { z } from "zod";

/**
 * Version of the extraction schema, written into every extraction.json. It
 * changes whenever a required key is added or a key changes meaning, so an
 * extraction written for another version is refused in one line (see
 * shape.ts) instead of failing key by key.
 *
 * 2: commercial_invoice gained tax, otherCharges and discountPercent;
 *    packing_list and its lines gained packingMethod.
 */
export const SCHEMA_VERSION = "2";

export const LANGUAGES = ["en", "ru", "tr", "ka", "other"] as const;
export const languageSchema = z.enum(LANGUAGES);
export type Language = z.infer<typeof languageSchema>;

export const DOCUMENT_TYPES = [
  "commercial_invoice",
  "packing_list",
  "cmr",
  "contract",
  "other",
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

const quote = z
  .string()
  .nullable()
  .describe(
    "Exact text copied from the document, character for character (same spelling, digits, separators and script): the text of this field only, without its label, wrapped lines joined with one space. Null when the value is null.",
  )
  .meta({ id: "quote" });
const page = z
  .number()
  .int()
  .nullable()
  .describe("Page of the source file where the quote is printed, counted from 1. Null when the value is null.")
  .meta({ id: "page" });

function cited<T extends z.ZodType>(value: T) {
  return z.object({ value, quote, page });
}

/*
 * The inner value schemas are shared instances. validate.ts recognises the
 * kind of a cited field (decimal, date, currency…) by these identities, which
 * survive `.describe()` on the surrounding object.
 */
export const textValue = z.string().nullable().describe("The value as written in the document, on one line, or null if absent.").meta({ id: "textValue" });
export const decimalValue = z
  .string()
  .nullable()
  .describe(
    "Canonical decimal: optional '-', digits, optional '.' and digits. No thousands separators, no currency, no units. '13,300.00' becomes '13300.00'; '1 880,5' becomes '1880.5'. The decimal sign is the one the same document's other numbers show: next to '9.684,00', '16.560' becomes '16560'. Keep the printed decimals. Never a sum or a conversion of your own. Null if absent.",
  )
  .meta({ id: "decimalValue" });
export const dateValue = z
  .string()
  .nullable()
  .describe("Date as YYYY-MM-DD. '18.09.2026' becomes '2026-09-18'; day first unless the document's own dates show the month first. Null if absent.")
  .meta({ id: "dateValue" });
export const currencyValue = z
  .string()
  .nullable()
  .describe("ISO 4217 code: 'EUR', 'USD', 'GEL', 'TRY', 'RUB'… '€' becomes 'EUR', 'ლარი' becomes 'GEL'. Null if absent.")
  .meta({ id: "currencyValue" });
export const wordsValue = z
  .string()
  .nullable()
  .describe("The full amount-in-words phrase, copied exactly, including currency words. Null if absent.")
  .meta({ id: "wordsValue" });

/** Free text as written (names, addresses, descriptions, references). */
export const citedText = cited(textValue).meta({ id: "citedText" });
/** Money, quantity, weight or volume. */
export const citedDecimal = cited(decimalValue).meta({ id: "citedDecimal" });
export const citedDate = cited(dateValue).meta({ id: "citedDate" });
export const citedCurrency = cited(currencyValue).meta({ id: "citedCurrency" });

export const partySchema = z.object({
  name: citedText.describe("Company or person name, with its legal form."),
  address: citedText.describe("Street, building, postal code and city, without the country. Null when only a name and a country are printed."),
  country: citedText.describe("Country as written in the document, also when it is the last word of the address."),
}).meta({ id: "party" });

export const referenceSchema = z.object({
  number: citedText,
  date: citedDate,
}).meta({ id: "reference" });

export const incotermSchema = z.object({
  code: citedText.describe("Incoterms rule code as written, e.g. 'FCA', 'CIF', 'EXW'."),
  place: citedText.describe("Named place after the rule, e.g. 'Kayseri, Türkiye'."),
  version: citedText.describe("Edition if stated, e.g. 'Incoterms 2020'."),
}).meta({ id: "incoterm" });

/** Amount written out in words, e.g. "thirteen thousand three hundred euro". */
export const amountInWordsSchema = cited(wordsValue).meta({ id: "amountInWords" });

const baseFields = {
  id: z.string().describe("Unique id of this document within the set: 'invoice', 'packing-list', 'cmr', 'contract', or a short name for another document; 'invoice-2' for a second document of a type."),
  sourceFile: z.string().nullable().describe("Name of the file the document came from, without folders. For a document spread over several image files, the first file."),
  language: languageSchema.nullable().describe("Main language of the document text. An amount in words is read in it, and a month name in a date is checked in it or in English."),
  number: citedText.describe("The document's own number, e.g. invoice number or CMR number."),
  date: citedDate.describe("The document's issue date."),
};

export const invoiceLineSchema = z.object({
  description: citedText,
  model: citedText.describe("Article, model or SKU code. Null when the document prints none."),
  hsCode: citedText.describe("HS / tariff code exactly as printed, if present."),
  quantity: citedDecimal.describe("Number of goods units. Quote the number alone ('400'); the unit goes in unit."),
  unit: citedText.describe("Unit as written, e.g. 'pcs', 'ცალი', 'adet', 'шт'."),
  unitPrice: citedDecimal,
  lineTotal: citedDecimal,
}).meta({ id: "invoiceLine" });

export const commercialInvoiceSchema = z.object({
  type: z.literal("commercial_invoice"),
  ...baseFields,
  seller: partySchema,
  buyer: partySchema,
  consignee: partySchema.describe("Delivery party, only when one is printed apart from the buyer; otherwise all values null."),
  contractRef: referenceSchema.describe("Contract or order the invoice refers to."),
  incoterm: incotermSchema,
  currency: citedCurrency,
  lines: z.array(invoiceLineSchema),
  subtotal: citedDecimal.describe("Goods value before discounts and charges. Null when the invoice prints one total only."),
  discount: citedDecimal.describe(
    "Discount taken off on this invoice, as an amount of money: 'Discount 5%: 775.00' becomes '775.00'. Never a percentage. Null when no amount is printed.",
  ),
  discountPercent: citedDecimal.describe(
    "Discount rate in percent, when one is printed: '5%' becomes '5'. Null if none. When only the rate is printed (no amount), fill this and leave discount null.",
  ),
  freight: citedDecimal.describe("Freight charged ON this invoice. Null if freight is only mentioned as paid separately."),
  insurance: citedDecimal.describe("Insurance charged ON this invoice."),
  otherCharges: z
    .array(citedDecimal)
    .describe(
      "Every other amount this invoice adds between the subtotal and the total (packing, handling, bank charges, a second tax), one entry per printed amount. An amount it takes off (an advance already paid) is negative. Quote the amount with the currency printed next to it ('USD 120.00'). [] if none.",
    ),
  tax: citedDecimal.describe(
    "Tax added on this invoice (VAT, GST, sales tax), as an amount: 'VAT 18%: 2,790.00' becomes '2790.00'. Quote the amount without the rate, with the currency printed next to it ('EUR 2,394.00'). Null when the prices already include the tax or only a rate is printed.",
  ),
  total: citedDecimal.describe("Final amount payable on this invoice."),
  totalInWords: amountInWordsSchema,
  packages: citedDecimal.describe("Number of packages stated on the invoice. Keep a packing word printed next to it in the quote: '82 cartons'."),
  netWeightKg: citedDecimal,
  grossWeightKg: citedDecimal,
  countryOfOrigin: citedText,
}).meta({ id: "commercialInvoice" });

export const packingListLineSchema = z.object({
  description: citedText,
  model: citedText,
  quantity: citedDecimal.describe("Number of goods units. Quote the number alone; the unit goes in unit."),
  unit: citedText,
  packages: citedDecimal.describe("Number of packages for this line. Quote the number alone when the line prints its packing method; that goes in packingMethod."),
  packingMethod: citedText.describe("Packing method printed for this line in its own cell, e.g. 'carton', 'pallet'. Null if none."),
  netWeightKg: citedDecimal,
  grossWeightKg: citedDecimal,
  volumeM3: citedDecimal,
}).meta({ id: "packingListLine" });

export const packingListSchema = z.object({
  type: z.literal("packing_list"),
  ...baseFields,
  shipper: partySchema,
  consignee: partySchema,
  invoiceRef: referenceSchema.describe("Invoice this packing list belongs to."),
  packingMethod: citedText.describe(
    "Packing method printed once for the whole list, e.g. 'Packing: cartons' becomes 'cartons'. Null if none.",
  ),
  lines: z.array(packingListLineSchema),
  totalQuantity: citedDecimal.describe("Total quantity as printed. Null when the list prints no total; never a sum of the lines."),
  totalPackages: citedDecimal.describe("Total number of packages as printed, with a packing word printed next to it in the quote ('82 cartons'). Null when no total is printed."),
  totalNetWeightKg: citedDecimal.describe("Total net weight as printed. Null when no total is printed."),
  totalGrossWeightKg: citedDecimal.describe("Total gross weight as printed. Null when no total is printed."),
  totalVolumeM3: citedDecimal.describe("Total volume as printed. Null when no total is printed."),
}).meta({ id: "packingList" });

export const cmrGoodsLineSchema = z.object({
  marksAndNumbers: citedText,
  packages: citedDecimal.describe("Number of packages (box 7). Quote the number alone; the packing word goes in packingMethod."),
  packingMethod: citedText.describe("Method of packing (box 8), e.g. 'cartons', 'pallets', 'ყუთი'."),
  description: citedText,
  grossWeightKg: citedDecimal,
  volumeM3: citedDecimal,
}).meta({ id: "cmrGoodsLine" });

/** Field letters refer to CMR Convention Art. 6(1). */
export const cmrSchema = z.object({
  type: z.literal("cmr"),
  ...baseFields,
  number: citedText.describe("The consignment note number, printed in the header."),
  date: citedDate.describe("(a) Date the CMR was made out (box 21). The date in the header has no field: take it only when box 21 is empty."),
  placeOfIssue: citedText.describe("(a) Place where the CMR was made out (box 21)."),
  sender: partySchema.describe("(b) Sender (box 1)."),
  carrier: partySchema.describe("(c) Carrier (box 16)."),
  placeOfTakingOver: citedText.describe("(d) Place of taking over the goods (box 4)."),
  dateOfTakingOver: citedDate.describe("(d) Date of taking over the goods (box 4)."),
  placeOfDelivery: citedText.describe("(d) Place designated for delivery (box 3)."),
  consignee: partySchema.describe("(e) Consignee (box 2)."),
  goods: z.array(cmrGoodsLineSchema).describe("(f)(g)(h) Goods lines (boxes 6-12)."),
  dangerousGoods: citedText.describe("(f) Dangerous goods description if any."),
  totalPackages: citedDecimal.describe("(g) Total number of packages, when printed apart from the goods lines; otherwise null."),
  totalGrossWeightKg: citedDecimal.describe("(h) Total gross weight, when printed apart from the goods lines; otherwise null."),
  carriageCharges: citedText.describe("(i) Charges relating to carriage, as written."),
  customsInstructions: citedText.describe("(j) Instructions for customs and other formalities."),
  convention: citedText.describe("(k) Statement that the carriage is subject to the CMR Convention; quote the whole sentence."),
  attachedDocuments: z
    .array(citedText)
    .describe("Documents listed as attached (box 5), one text entry per document, as printed with its number, e.g. 'Invoice AOS-INV-2026-0918-01'."),
}).meta({ id: "cmr" });

export const contractSchema = z.object({
  type: z.literal("contract"),
  ...baseFields,
  seller: partySchema,
  buyer: partySchema,
  incoterm: incotermSchema,
  currency: citedCurrency,
  totalAmount: citedDecimal.describe("The contract value."),
  totalInWords: amountInWordsSchema,
  goodsDescription: citedText.describe("The goods as the contract names them, to the end of that sentence and without its heading, on one line."),
}).meta({ id: "contract" });

export const otherDocumentSchema = z.object({
  type: z.literal("other"),
  ...baseFields,
  title: citedText.describe("What the document is, as titled, e.g. 'Freight statement'."),
}).meta({ id: "otherDocument" });

export const documentSchema = z.discriminatedUnion("type", [
  commercialInvoiceSchema,
  packingListSchema,
  cmrSchema,
  contractSchema,
  otherDocumentSchema,
]);

export const extractionSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  documents: z.array(documentSchema),
});

export type CitedText = z.infer<typeof citedText>;
export type CitedDecimal = z.infer<typeof citedDecimal>;
export type CitedDate = z.infer<typeof citedDate>;
export type Party = z.infer<typeof partySchema>;
export type CommercialInvoice = z.infer<typeof commercialInvoiceSchema>;
export type PackingList = z.infer<typeof packingListSchema>;
export type Cmr = z.infer<typeof cmrSchema>;
export type Contract = z.infer<typeof contractSchema>;
export type OtherDocument = z.infer<typeof otherDocumentSchema>;
export type TradeDocument = z.infer<typeof documentSchema>;
export type Extraction = z.infer<typeof extractionSchema>;
