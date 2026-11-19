import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { blankDocument, checkDocuments, declarationsFromRs, type Cmr, type CommercialInvoice, type CustomsDeclaration, type Extraction, type PackingList } from "../src/index.ts";
import { c } from "./support/ka-pack.ts";

const fixture = (variant: string, file = "extraction.json") =>
  readFileSync(new URL(`../../../fixtures/ka-office-furniture/${variant}/${file}`, import.meta.url), "utf8");
const rs = fixture("declaration-rs-clean", "rs-response.json");

function clean() {
  const extraction = JSON.parse(fixture("declaration-clean")) as Extraction;
  const [invoice, pl, cmr, , declaration] = extraction.documents as [CommercialInvoice, PackingList, Cmr, unknown, CustomsDeclaration];
  return { extraction, invoice, pl, cmr, declaration, item: declaration.items[0]! };
}

const declared = (extraction: Extraction) => checkDocuments(extraction).findings.filter((f) => f.rule.startsWith("DEC-"));

describe("saved Revenue Service declarations", () => {
  it("groups repeated headers by office, number and date, selects the registration and keeps literal number digits", () => {
    const template = JSON.parse(rs).DATA[0];
    const raw = JSON.stringify({
      STATUS: { ID: 0, TEXT: "" },
      DATA: [
        template, { ...template, ItemNumber: 2 },
        { ...template, CustomsCode: "99098" },
        { ...template, RegistrationDate: "20.09.2025" },
        { ...template, RegistrationNumber: "C-DEMO-2042" },
      ],
    }).replaceAll('"BruttoWeight":1250', '"BruttoWeight":9007199254740993.0000000000001234500')
      .replaceAll('"ValueInGEL":40582.96', '"ValueInGEL":9.00719925474099350e+15');
    const docs = declarationsFromRs(raw, "response.json");
    expect(docs.map((d) => [d.customsOfficeCode.value, d.number.value, d.date.value, d.items.length])).toEqual([
      ["99099", "C-DEMO-2041", "2026-09-20", 2],
      ["99098", "C-DEMO-2041", "2026-09-20", 1],
      ["99099", "C-DEMO-2041", "2025-09-20", 1],
      ["99099", "C-DEMO-2042", "2026-09-20", 1],
    ]);
    const [first] = docs;
    expect(first!.items[0]).toMatchObject({
      grossWeightKg: { value: "9007199254740993.0000000000001234500", quote: "9007199254740993.0000000000001234500", page: null },
      rsValueInGel: { value: "9007199254740993.50", quote: "9.00719925474099350e+15", page: null },
      customsValueGel: { value: null },
    });
    expect(first).toMatchObject({
      sourceKind: "rs_json", sourceFile: "response.json", exporter: { name: { value: null } },
      importer: { taxId: { value: "900000001", quote: "900000001", page: null } },
      currency: { value: null }, totalInvoiceAmount: { value: null }, exchangeRate: { value: null },
      totalPackages: { value: null }, attachedDocuments: [],
    });
    expect(checkDocuments({ schemaVersion: "3", documents: docs }).extractionIssues).toEqual([]);
    expect(declarationsFromRs(raw, "response.json", "C-DEMO-2042")).toEqual([{ ...docs[3], id: "declaration" }]);
    expect(() => declarationsFromRs(raw, "response.json", "C-DEMO-2041")).toThrow("several offices or dates");
    expect(() => declarationsFromRs(raw, "response.json", "C-DEMO-2000")).toThrow("was not found");
  });

  it("rejects nonzero status, a wrong envelope, conflicting headers and duplicate item numbers", () => {
    const row = JSON.parse(rs).DATA[0];
    const response = (data: unknown, id: unknown = 0) => JSON.stringify({ DATA: data, STATUS: { ID: id, TEXT: "სატესტო პასუხი" } });
    for (const [input, expected] of [
      [response({}, -1306), "STATUS.ID is -1306"],
      [response([], "0"), "numeric STATUS.ID"],
      [response({}), "DATA array"],
      [response([{ ...row, RegistrationDate: "29.02.2026" }]), "RegistrationDate: expected a valid DD.MM.YYYY"],
      [response([{ ...row, BruttoWeight: "1250" }]), "BruttoWeight: expected a JSON number"],
      [response([row, { ...row, ItemNumber: 2, AssessmentNumber: "A-DEMO-2053" }]), "same header values"],
      [response([row, row]), "unique item number"],
    ] as const) expect(() => declarationsFromRs(input, "response.json")).toThrow(expected);
    expect(declarationsFromRs(response([]), "response.json")).toEqual([]);
  });

  it("rejects a JSON date or number that was altered in the extraction", () => {
    const [doc] = declarationsFromRs(rs, "response.json");
    doc!.date.value = "2026-09-19";
    doc!.items[0]!.grossWeightKg.quote = "12.50e+0";
    const result = checkDocuments({ schemaVersion: "3", documents: [doc] });
    expect(result.extractionIssues.map(({ code, path }) => [code, path])).toEqual([
      ["EXT_QUOTE_MISMATCH", "documents[0].date"], ["EXT_QUOTE_MISMATCH", "documents[0].items[0].grossWeightKg"],
    ]);
    expect(result.findings.map((f) => f.rule)).toEqual(["DOC-01", "DOC-01", "DOC-01"]);
  });
});

describe("declaration comparisons", () => {
  it("uses all invoice totals in one currency with exact arithmetic", () => {
    const { extraction, invoice, declaration, item } = clean();
    const second = blankDocument("commercial_invoice", "invoice-2");
    second.currency = c("EUR");
    invoice.total = c("0.10");
    second.total = c("0.20");
    declaration.totalInvoiceAmount = item.invoiceValue = c("0.30");
    extraction.documents.push(second);
    expect(declared(extraction)).toEqual([]);
    second.total = c("0.20000000000000001");
    expect(declared(extraction).map((f) => [f.key, f.params.expected])).toEqual([["DEC-05.invoice-total", "0.30000000000000001"]]);
    second.currency = c("USD");
    expect(declared(extraction)).toEqual([]);
  });

  it("takes the highest precedence usable totals and skips incompatible packing", () => {
    const { extraction, pl, declaration, item } = clean();
    item.grossWeightKg = c("1249.50");
    declaration.totalPackages = c("12", "12 პალეტი");
    expect(declared(extraction)).toEqual([]);
    item.grossWeightKg = c("1249.49");
    expect(declared(extraction).map((f) => f.key)).toEqual(["DEC-03.gross"]);
    pl.totalGrossWeightKg = c(null);
    expect(declared(extraction)[0]?.evidence.at(-1)?.documentType).toBe("cmr");
    item.grossWeightKg.page = null;
    expect(declared(extraction)).toEqual([]);
    expect(checkDocuments(extraction).extractionIssues).toMatchObject([{ code: "EXT_PAGE", path: "documents[4].items[0].grossWeightKg" }]);
  });

  it("uses the first declaration for cross-checks and checks the second by itself", () => {
    const { extraction, declaration } = clean();
    const second = structuredClone(declaration);
    second.id = "declaration-2";
    second.items[0]!.hsCode = c("94031099999");
    second.items[0]!.grossWeightKg = c("1205.00");
    second.items[0]!.countryOfOrigin = c("999");
    second.importer.taxId = c("900000009");
    extraction.documents.push(second);
    expect(checkDocuments(extraction).findings.map((f) => f.key)).toEqual([
      "DEC-02.unknown-national", "DOC-01.multiple", "DEC-06.unestablished",
    ]);
  });

  it("stays silent for unknown origins, cross-script names and incomplete prefixes", () => {
    const { extraction, declaration, item, invoice } = clean();
    declaration.importer.taxId = c(null);
    declaration.importer.name = c("Test Company");
    item.countryOfOrigin = c("792");
    item.hsCode = c("94033011000");
    invoice.lines[1]!.hsCode = c(null);
    expect(declared(extraction)).toEqual([]);
  });
});
