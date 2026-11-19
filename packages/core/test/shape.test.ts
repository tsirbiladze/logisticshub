import { describe, expect, it } from "vitest";
import { blankDocument, checkDocuments, EXTRACTION_GUIDE, extractionJsonSchema, parseExtraction, renderReports, SCHEMA_VERSION, shapeIssues, type TradeDocument } from "../src/index.ts";

type Loose = Record<string, any>;

/** A well-shaped extraction with one invoice, to break in one place. */
function withInvoice(change: (invoice: Loose, extraction: Loose) => void): unknown {
  const invoice = blankDocument("commercial_invoice", "invoice") as Loose;
  invoice.lines = [{ description: cited("Desk"), model: cited(null), hsCode: cited(null), quantity: cited("2"), unit: cited("pcs"), unitPrice: cited("10.00"), lineTotal: cited("20.00") }];
  const extraction: Loose = { schemaVersion: SCHEMA_VERSION, documents: [invoice] };
  change(invoice, extraction);
  return extraction;
}

function cited(value: string | null) {
  return { value, quote: value, page: value === null ? null : 1 };
}

const TYPES = "commercial_invoice, packing_list, cmr, contract or other";
const BLANK = '{ "value": null, "quote": null, "page": null }';

describe("shapeIssues", () => {
  it("finds nothing wrong with a well-shaped extraction, whatever extra keys it carries", () => {
    expect(shapeIssues(withInvoice(() => {}))).toEqual([]);
    expect(shapeIssues(withInvoice((invoice) => void (invoice.note = "extra")))).toEqual([]);
    expect(shapeIssues({ schemaVersion: SCHEMA_VERSION, documents: [] })).toEqual([]);
  });

  it.each<[string, (invoice: Loose, extraction: Loose) => void, string, string]>([
    ["an unknown type", (d) => void (d.type = "bill_of_lading"), "documents[0].type", `Unknown type "bill_of_lading". Use ${TYPES}.`],
    ["a missing type", (d) => void delete d.type, "documents[0].type", `Missing. Use ${TYPES}.`],
    ["a type that is not a string", (d) => void (d.type = 7), "documents[0].type", `Must be one of ${TYPES}, got a number.`],
    ["a missing cited field", (d) => void delete d.total, "documents[0].total", `Missing. Write ${BLANK} when the document does not print it.`],
    ["a bare value for a cited field", (d) => void (d.total = "13300.00"), "documents[0].total", 'Must be { "value": …, "quote": …, "page": … }, got a string.'],
    ["a number for a value", (d) => void (d.total.value = 13300), "documents[0].total.value", "Must be a string or null, got a number: write it in quotes."],
    ["a missing quote", (d) => void delete d.total.quote, "documents[0].total.quote", "Missing. Write null when there is none."],
    ["a page beyond any document", (d) => void (d.total.page = 1e300), "documents[0].total.page", "Must be a whole number (1 for the first page) or null, got a number too large to be a page."],
    ["a page just past the largest whole number", (d) => void (d.total.page = 2 ** 53), "documents[0].total.page", "Must be a whole number (1 for the first page) or null, got a number too large to be a page."],
    ["half a page", (d) => void (d.total.page = 1.5), "documents[0].total.page", "Must be a whole number (1 for the first page) or null, got 1.5."],
    ["a page in quotes", (d) => void (d.total.page = "1"), "documents[0].total.page", "Must be a whole number (1 for the first page) or null, got a string."],
    ["a missing list", (d) => void delete d.otherCharges, "documents[0].otherCharges", "Missing. Write an empty array when there are none."],
    ["a list that is not one", (d) => void (d.lines = "none"), "documents[0].lines", "Must be an array, got a string."],
    ["a line that is not an object", (d) => void (d.lines[0] = null), "documents[0].lines[0]", "Must be an object with the keys description, model, hsCode, quantity, unit, unitPrice, lineTotal, got null."],
    ["a missing key inside a line", (d) => void delete d.lines[0].unit, "documents[0].lines[0].unit", `Missing. Write ${BLANK} when the document does not print it.`],
    ["a missing party", (d) => void delete d.seller, "documents[0].seller", "Missing. Write an object with the keys name, address, country, taxId."],
    ["a missing id", (d) => void delete d.id, "documents[0].id", "Missing. A string is required."],
    ["an id that is a number", (d) => void (d.id = 1), "documents[0].id", "Must be a string, got a number: write it in quotes."],
    ["a missing sourceFile", (d) => void delete d.sourceFile, "documents[0].sourceFile", "Missing. Write null when there is none."],
    ["an unknown language", (d) => void (d.language = "de"), "documents[0].language", 'Unknown language "de". Use en, ru, tr, ka or other, or null.'],
    ["a language that is not a string", (d) => void (d.language = true), "documents[0].language", "Must be one of en, ru, tr, ka or other, or null, got a boolean."],
    ["a document that is not an object", (_, e) => void (e.documents[0] = "invoice.pdf"), "documents[0]", "Must be an object, got a string."],
    ["documents that are not a list", (_, e) => void (e.documents = 1), "documents", "Must be an array with one object per document, got a number."],
    ["no documents key", (_, e) => void delete e.documents, "documents", "Missing. Write an array with one object per document."],
    ["no schemaVersion", (_, e) => void delete e.schemaVersion, "schemaVersion", `Missing. Write "schemaVersion": "${SCHEMA_VERSION}" when the extraction follows the guide that comes with this checker.`],
    ["a schemaVersion that is a number", (_, e) => void (e.schemaVersion = Number(SCHEMA_VERSION)), "schemaVersion", `Must be the string "${SCHEMA_VERSION}", got a number.`],
  ])("%s is one line that says what to write", (_name, change, path, message) => {
    expect(shapeIssues(withInvoice(change))).toEqual([{ path, message }]);
  });

  it("says what the file must be when it is not an object", () => {
    for (const [input, got] of [[[], "an array"], ["x", "a string"], [null, "null"], [undefined, "nothing"], [3, "a number"]] as const) {
      expect(shapeIssues(input)).toEqual([{ path: "(top level)", message: `Must be one JSON object with the keys schemaVersion and documents, got ${got}.` }]);
    }
  });

  it("lists every problem, in the order of the schema", () => {
    const issues = shapeIssues(
      withInvoice((invoice, extraction) => {
        delete invoice.tax;
        delete invoice.number;
        invoice.lines[0].quantity = 2;
        extraction.documents.push({ type: "cmr" }, { type: "waybill" });
      }),
    );
    expect(issues.slice(0, 3).map((i) => i.path)).toEqual(["documents[0].number", "documents[0].lines[0].quantity", "documents[0].tax"]);
    expect(issues.filter((i) => i.path.startsWith("documents[1]")).length).toBe(Object.keys(blankDocument("cmr", "cmr")).length - 1);
    expect(issues.at(-1)).toEqual({ path: "documents[2].type", message: `Unknown type "waybill". Use ${TYPES}.` });
  });

  it("accepts every document type with every fact null", () => {
    const documents: TradeDocument[] = (["commercial_invoice", "packing_list", "cmr", "contract", "other"] as const).map((type) => blankDocument(type, type));
    expect(shapeIssues({ schemaVersion: SCHEMA_VERSION, documents })).toEqual([]);
    expect(parseExtraction({ schemaVersion: SCHEMA_VERSION, documents }).ok).toBe(true);
  });

  describe("an extraction written for another schema version", () => {
    /** What version 1 looked like: no tax, otherCharges or discountPercent on the invoice, no packingMethod on the packing list. */
    const versionOne = () => {
      const invoice = blankDocument("commercial_invoice", "invoice") as Loose;
      const packingList = blankDocument("packing_list", "packing-list") as Loose;
      for (const key of ["tax", "otherCharges", "discountPercent"]) delete invoice[key];
      delete packingList.packingMethod;
      return { schemaVersion: "1", documents: [invoice, packingList] };
    };
    const line = (version: string) =>
      `This extraction is written for schema version "${version}"; this checker reads version "${SCHEMA_VERSION}". Extract the documents again with the guide that comes with this checker.`;

    it("fails with one line that says so and what to do, not with a line per missing key", () => {
      expect(SCHEMA_VERSION).not.toBe("1");
      expect(shapeIssues(versionOne())).toEqual([{ path: "schemaVersion", message: line("1") }]);
      // With the current version written on it, the same file shows what the bump is for.
      expect(shapeIssues({ ...versionOne(), schemaVersion: SCHEMA_VERSION }).map((i) => i.path)).toEqual([
        "documents[0].discountPercent",
        "documents[0].otherCharges",
        "documents[0].tax",
        "documents[1].packingMethod",
      ]);
    });

    it("says the same about a newer version, and runs no rule", () => {
      const result = checkDocuments({ schemaVersion: "99", documents: "whatever" });
      expect(result).toMatchObject({ ok: false, findings: [], extractionIssues: [{ code: "EXT_SHAPE", path: "schemaVersion", message: line("99") }] });
      const md = renderReports(result, "en").md;
      expect(md).toContain("The extraction could not be read");
      expect(md).toContain(`- \`schemaVersion\` (EXT_SHAPE): ${line("99")}`);
    });

    it("the guide's example and the JSON Schema name the version the checker reads", () => {
      expect(EXTRACTION_GUIDE).toContain(`"schemaVersion": "${SCHEMA_VERSION}"`);
      expect(JSON.stringify(extractionJsonSchema())).toContain(`"schemaVersion":{"type":"string","const":"${SCHEMA_VERSION}"}`);
    });
  });

  it("reaches the report as EXT_SHAPE issues with the same paths as field issues", () => {
    const result = checkDocuments(withInvoice((invoice) => void (invoice.type = "bill_of_lading")));
    expect(result.ok).toBe(false);
    expect(result.extractionIssues).toEqual([{ code: "EXT_SHAPE", path: "documents[0].type", message: `Unknown type "bill_of_lading". Use ${TYPES}.` }]);
  });
});
