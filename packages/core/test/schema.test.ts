import { describe, expect, it } from "vitest";
import {
  blankDocument,
  extractionJsonSchema,
  parseExtraction,
  SCHEMA_VERSION,
  type CommercialInvoice,
  type Extraction,
} from "../src/index.ts";

/** Invoice from the synthetic KA pack (LH-TEST-20260920-01), trimmed. */
function kaInvoice(): CommercialInvoice {
  const invoice = blankDocument("commercial_invoice", "invoice-1");
  invoice.sourceFile = "logisticshub-test-01-commercial-invoice.pdf";
  invoice.language = "ka";
  invoice.number = { value: "AOS-INV-2026-0918-01", quote: "AOS-INV-2026-0918-01", page: 1 };
  invoice.date = { value: "2026-09-18", quote: "18.09.2026", page: 1 };
  invoice.currency = { value: "EUR", quote: "EUR / 18.10.2026", page: 1 };
  invoice.lines = [
    {
      description: { value: "საოფისე ლითონის ტუმბო, 3 უჯრით", quote: "საოფისე ლითონის ტუმბო, 3 უჯრით", page: 1 },
      model: { value: "AOS-MP3", quote: "AOS-MP3", page: 1 },
      hsCode: { value: null, quote: null, page: null },
      quantity: { value: "60", quote: "60", page: 1 },
      unit: { value: "ცალი", quote: "ცალი", page: 1 },
      unitPrice: { value: "145.00", quote: "145.00", page: 1 },
      lineTotal: { value: "8700.00", quote: "8,700.00", page: 1 },
    },
  ];
  invoice.total = { value: "13300.00", quote: "EUR 13,300.00", page: 1 };
  invoice.totalInWords = {
    value: "ცამეტი ათას სამასი ევრო და ნული ცენტი",
    quote: "ცამეტი ათას სამასი ევრო და ნული ცენტი",
    page: 1,
  };
  return invoice;
}

function extraction(...documents: Extraction["documents"]): Extraction {
  return { schemaVersion: SCHEMA_VERSION, documents };
}

describe("parseExtraction", () => {
  it("accepts a well-formed extraction without issues", () => {
    const result = parseExtraction(extraction(kaInvoice(), blankDocument("cmr", "cmr-1")));
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("reports format problems per field instead of failing", () => {
    const invoice = kaInvoice();
    invoice.total.value = "13,300.00";
    invoice.date.value = "2026-02-30";
    invoice.currency.value = "€";
    invoice.lines[0]!.unitPrice.quote = null;
    const result = parseExtraction(extraction(invoice));
    expect(result.ok).toBe(true);
    expect(result.issues.map((i) => [i.code, i.path])).toEqual([
      ["EXT_DATE_FORMAT", "documents[0].date"],
      ["EXT_CURRENCY_FORMAT", "documents[0].currency"],
      ["EXT_UNCITED", "documents[0].lines[0].unitPrice"],
      ["EXT_DECIMAL_FORMAT", "documents[0].total"],
    ]);
  });

  it("accepts dates in years 0000-0099 and leap days correctly", async () => {
    const { isIsoDate } = await import("../src/validate.ts");
    expect(isIsoDate("0099-01-01")).toBe(true);
    expect(isIsoDate("2024-02-29")).toBe(true);
    expect(isIsoDate("2026-02-29")).toBe(false);
    expect(isIsoDate("1900-02-29")).toBe(false);
    expect(isIsoDate("2000-02-29")).toBe(true);
    expect(isIsoDate("2026-13-01")).toBe(false);
  });

  it("flags duplicate document ids", () => {
    const result = parseExtraction(extraction(kaInvoice(), kaInvoice()));
    expect(result.issues.map((i) => i.code)).toEqual(["EXT_DUPLICATE_ID"]);
  });

  it("rejects wrong shapes with paths", () => {
    const invoice = kaInvoice() as unknown as Record<string, unknown>;
    delete invoice.total;
    const result = parseExtraction({ schemaVersion: SCHEMA_VERSION, documents: [invoice] });
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      { code: "EXT_SHAPE", path: "documents[0].total", message: 'Missing. Write { "value": null, "quote": null, "page": null } when the document does not print it.' },
    ]);
  });
});

describe("extractionJsonSchema", () => {
  const schema = extractionJsonSchema();

  function nodes(node: unknown, visit: (n: Record<string, unknown>) => void): void {
    if (Array.isArray(node)) return node.forEach((n) => nodes(n, visit));
    if (node && typeof node === "object") {
      visit(node as Record<string, unknown>);
      Object.values(node).forEach((n) => nodes(n, visit));
    }
  }

  it("uses only keywords Claude structured outputs support", () => {
    const forbidden = ["oneOf", "minimum", "maximum", "minLength", "maxLength", "pattern", "$schema"];
    nodes(schema, (n) => {
      for (const key of forbidden) expect(n, `found ${key}`).not.toHaveProperty(key);
    });
  });

  it("closes every object and requires all of its properties", () => {
    let objects = 0;
    nodes(schema, (n) => {
      if (n.type === "object") {
        objects += 1;
        expect(n.additionalProperties).toBe(false);
        expect(n.required).toEqual(Object.keys(n.properties as object));
      }
    });
    expect(objects).toBeGreaterThan(10);
  });

  it("stays compact (shared parts are $defs)", () => {
    expect(JSON.stringify(schema).length).toBeLessThan(20_000);
    expect(Object.keys((schema.$defs ?? {}) as object).length).toBeGreaterThan(5);
  });

  it("offers all five document types", () => {
    const text = JSON.stringify(schema);
    for (const type of ["commercial_invoice", "packing_list", "cmr", "contract", "other"]) {
      expect(text).toContain(`"${type}"`);
    }
  });
});
