import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { jsonDecimal, rsDate } from "./quote.ts";
import { decodeText, ioProblem, parseJson } from "./input.ts";
import { blankDocument } from "./introspect.ts";
import { SCHEMA_VERSION, type CustomsDeclaration, type DeclarationItem, type Extraction } from "./schema.ts";
import { parseExtraction } from "./validate.ts";

const HEADER_TEXT = {
  CustomsCode: "customsOfficeCode", CustomsName: "customsOfficeName", Regime: "regime",
  RegistrationNumber: "number", AssessmentNumber: "assessmentNumber",
  SenderCountryCode: "countryOfDispatch", DestinationCountryCode: "countryOfDestination",
} as const;
const ITEM_TEXT = {
  HSCode: "hsCode", CustomsProcedure: "procedure", OriginCountryCode: "countryOfOrigin",
  GoodsDescription: "description", SupplementaryUnit: "supplementaryUnit",
} as const;
const ITEM_NUMBER = {
  ItemNumber: "itemNumber", BruttoWeight: "grossWeightKg", NettoWeight: "netWeightKg",
  SupplementaryQuantity: "supplementaryQuantity", ValueInGEL: "rsValueInGel",
} as const;

export const RS_FIELDS = { header: HEADER_TEXT, item: ITEM_TEXT, numeric: ITEM_NUMBER };

class JsonNumber {
  readonly raw: string;

  constructor(raw: string) {
    this.raw = raw;
  }
}

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

const cited = (value: string | null, quote = value) => ({ value, quote, page: null });

/** Parse the saved GetAsycudaDeclarationsResponse, using the original numeric tokens. */
export function declarationsFromRs(raw: string, sourceFile: string, registration?: string): CustomsDeclaration[] {
  let input: unknown;
  try {
    input = JSON.parse(raw, (_key: string, value: unknown, context?: { source: string }) => {
      if (typeof value !== "number") return value;
      if (!context?.source) throw new Error("Node.js 22 or newer is required for exact JSON numbers.");
      return new JsonNumber(context.source);
    });
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("The Revenue Service response is not valid JSON.");
    throw error;
  }
  const response = object(input);
  const status = object(response?.STATUS);
  if (!(status?.ID instanceof JsonNumber) || typeof status.TEXT !== "string") {
    throw new Error("Expected Revenue Service response with numeric STATUS.ID and string STATUS.TEXT.");
  }
  const statusId = jsonDecimal(status.ID.raw);
  if (!statusId || !/^-?0(?:\.0+)?$/.test(statusId)) throw new Error(`Revenue Service STATUS.ID is ${status.ID.raw}.`);
  if (!Array.isArray(response?.DATA)) throw new Error("Expected Revenue Service response with a DATA array.");

  const groups = new Map<string, { doc: CustomsDeclaration; header: string; items: Set<string> }>();
  for (const [index, data] of response.DATA.entries()) {
    const row = object(data);
    const bad = (field: string, expected: string): never => { throw new Error(`DATA[${index}]${field ? "." + field : ""}: expected ${expected}.`); };
    if (!row) return bad("", "an object");
    const getText = (key: string) => {
      const value = row[key];
      if (value === undefined) return null;
      if (typeof value !== "string") return bad(key, "a string");
      return value.trim() ? value : null;
    };
    const getDate = (key: string) => {
      const quote = getText(key);
      if (quote === null) return cited(null);
      const value = rsDate(quote);
      return value ? cited(value, quote) : bad(key, "a valid DD.MM.YYYY date");
    };
    const getNumber = (key: string) => {
      const number = row[key];
      if (number === undefined) return cited(null);
      if (!(number instanceof JsonNumber)) return bad(key, "a JSON number");
      const value = jsonDecimal(number.raw);
      return value === null ? bad(key, "a usable JSON decimal") : cited(value, number.raw);
    };

    const header = blankDocument("customs_declaration", "declaration");
    header.sourceFile = sourceFile;
    header.sourceKind = "rs_json";
    for (const [key, field] of Object.entries(HEADER_TEXT)) header[field] = cited(getText(key));
    header.date = getDate("RegistrationDate");
    header.assessmentDate = getDate("AssessmentDate");
    header.exporter.taxId = cited(getText("ExporterCode"));
    header.importer.taxId = cited(getText("ImporterCode"));
    if (!header.customsOfficeCode.value) bad("CustomsCode", "a nonempty customs office code");
    if (!header.number.value) bad("RegistrationNumber", "a nonempty registration number");
    if (!header.date.value) bad("RegistrationDate", "a valid DD.MM.YYYY date");

    const item = {} as DeclarationItem;
    for (const [key, field] of Object.entries(ITEM_TEXT)) item[field] = cited(getText(key));
    for (const [key, field] of Object.entries(ITEM_NUMBER)) item[field] = getNumber(key);
    const itemNumber = item.itemNumber.value?.match(/^([1-9][0-9]*)(?:\.0+)?$/)?.[1];
    if (!itemNumber) return bad("ItemNumber", "a positive whole number");
    item.packages = cited(null);
    item.packingMethod = cited(null);
    item.invoiceValue = cited(null);
    item.customsValueGel = cited(null);

    const key = JSON.stringify([header.customsOfficeCode.value, header.number.value, header.date.value]);
    const serialized = JSON.stringify(header);
    let group = groups.get(key);
    if (!group) {
      group = { doc: header, header: serialized, items: new Set() };
      groups.set(key, group);
    }
    if (group.header !== serialized) bad("", "the same header values on every row of this declaration");
    if (group.items.has(itemNumber)) bad("ItemNumber", "a unique item number within this declaration");
    group.items.add(itemNumber);
    group.doc.items.push(item);
  }
  const docs = [...groups.values()].map(({ doc }) => doc).filter((doc) => registration === undefined || doc.number.value === registration);
  if (registration !== undefined && docs.length !== 1) {
    throw new Error(docs.length ? `Registration number ${registration} matches several offices or dates.` : `Registration number ${registration} was not found.`);
  }
  return docs.map((doc, index) => ({ ...doc, id: index ? `declaration-${index + 1}` : "declaration" }));
}

export const DECLARATION_USAGE = "declaration-from-rs <response.json> [--registration <number>] [--append <extraction.json>]";

function readText(path: string): string {
  try {
    return decodeText(readFileSync(path));
  } catch (error) {
    throw new Error(`Cannot read ${path}: ${ioProblem(error)}.`);
  }
}

/** All output goes to stdout so the source files are left intact. */
export function declarationCommand(args: string[]): string {
  const { positionals, values } = parseArgs({
    args, allowPositionals: true, options: { registration: { type: "string" }, append: { type: "string" } },
  });
  if (positionals.length !== 1) throw new Error(`Usage: ${DECLARATION_USAGE}`);
  const [path] = positionals as [string];
  const docs = declarationsFromRs(readText(path), basename(path), values.registration);
  let extraction: Extraction = { schemaVersion: SCHEMA_VERSION, documents: [] };
  if (values.append !== undefined) {
    const json = parseJson(readText(values.append));
    if (!json.ok) throw new Error(`Cannot read ${values.append}: ${json.problem}.`);
    const parsed = parseExtraction(json.value);
    if (!parsed.ok) throw new Error(`Cannot append to ${values.append}: ${parsed.issues[0]?.message}`);
    // Keep the supplied extraction (including fields the checker does not interpret).
    extraction = json.value as Extraction;
  }
  const ids = new Set(extraction.documents.map(({ id }) => id));
  let index = 1;
  for (const doc of docs) {
    while (ids.has(doc.id = index === 1 ? "declaration" : `declaration-${index}`)) index++;
    ids.add(doc.id);
    extraction.documents.push(doc);
  }
  return `${JSON.stringify(extraction, null, 2)}\n`;
}
