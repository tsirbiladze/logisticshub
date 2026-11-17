/**
 * The v1 quality bar: on every synthetic pack the checker finds exactly the
 * planted problems — all of them, and nothing else.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkDocuments } from "@logisticshub/core";
import { describe, expect, it } from "vitest";
import { buildAll } from "../src/build.ts";
import { documentNames, variantFiles } from "../src/model.ts";
import { renderCmr, renderContract, renderInvoice, renderPackingList } from "../src/render.ts";

const ROOT = fileURLToPath(new URL("../../../fixtures/", import.meta.url));
const read = (path: string) => JSON.parse(readFileSync(ROOT + path, "utf8"));

interface IndexFile {
  packs: {
    id: string;
    documents: string[];
    variants: { id: string; expected: string[]; expectedIssues?: string[]; layout?: { invoiceBreakBefore?: number; scanned?: string[]; combined?: string[] }; files?: string[] }[];
  }[];
}

const index: IndexFile = read("index.json");
const variants = index.packs.flatMap((pack) => pack.variants.map((variant) => ({ pack, variant })));

describe("stored fixtures", () => {
  it("cover four languages with a clean set each", () => {
    expect(index.packs.map((p) => p.id)).toEqual(["ka-office-furniture", "en-led-lighting", "ru-textile", "tr-ceramics"]);
    for (const pack of index.packs) expect(pack.variants[0]?.id).toBe("clean");
    expect(variants.length).toBe(29);
  });

  it("include a table that goes on over the page and a document that is a scan", () => {
    const layouts = variants.filter(({ variant }) => variant.layout).map(({ pack, variant }) => [`${pack.id}/${variant.id}`, variant.layout]);
    expect(layouts).toEqual([
      ["ka-office-furniture/scanned-cmr", { scanned: ["cmr"] }],
      ["en-led-lighting/two-page-invoice", { invoiceBreakBefore: 2 }],
      ["en-led-lighting/two-documents-in-one-pdf", { combined: ["invoice", "packing-list"] }],
    ]);

    // Two pages: each line cites its own page, the totals and the amount in words the last one.
    const [invoice] = read("en-led-lighting/two-page-invoice/extraction.json").documents;
    const page = (field: { page: number | null }) => field.page;
    expect(invoice.lines.map((line: { lineTotal: { page: number } }) => page(line.lineTotal))).toEqual([1, 1, 2]);
    expect([invoice.number, invoice.date, invoice.seller.name, invoice.currency, invoice.incoterm.code].map(page)).toEqual([1, 1, 1, 1, 1]);
    expect([invoice.subtotal, invoice.total, invoice.totalInWords, invoice.packages].map(page)).toEqual([2, 2, 2, 2]);
    expect([invoice.tax, invoice.discount].map(page)).toEqual([null, null]);
    // The rows that only carry the running sum over the page are not part of the extraction.
    const html = renderInvoice(buildAll().find((b) => b.variant.id === "two-page-invoice")!.documents.invoice, buildAll().find((b) => b.variant.id === "two-page-invoice")!.pack.spec, { breakBefore: 2 });
    expect(html.match(/USD 11,750\.00/g)).toHaveLength(2);
    expect(html).toContain("Carried forward");
    expect(html).toContain("Brought forward");
    expect(JSON.stringify(invoice)).not.toContain("11,750.00");
    expect(html.match(/<thead>/g)).toHaveLength(2);
    expect(read("en-led-lighting/two-page-invoice/expected.json").map((f: { key: string }) => f.key)).toEqual(["SUM-01.line", "SUM-02.subtotal"]);

    // A scan is one more way to deliver the same document: its extraction is like any other.
    const cmr = read("ka-office-furniture/scanned-cmr/extraction.json").documents[2];
    expect(cmr).toMatchObject({ type: "cmr", sourceFile: "cmr.pdf", totalGrossWeightKg: { value: "1800", quote: "1,800", page: 1 } });
    expect(read("ka-office-furniture/scanned-cmr/expected.json")).toMatchObject([{ rule: "WGT-02", severity: "error", key: "WGT-02.gross" }]);
  });

  it("include a document the checker cannot read for certain: one extraction issue, no finding", () => {
    // Only one variant expects an extraction issue; every other reference extraction is free of them.
    expect(variants.filter(({ variant }) => variant.expectedIssues).map(({ pack, variant }) => `${pack.id}/${variant.id}`)).toEqual(["en-led-lighting/mixed-number-conventions"]);
    const result = checkDocuments(read("en-led-lighting/mixed-number-conventions/extraction.json"));
    expect(result.findings).toEqual([]);
    // The extraction is right (1500 pieces, printed "1.500"); the document's other numbers write the point as the decimal sign.
    expect(result.extractionIssues).toEqual([
      {
        code: "EXT_QUOTE_MISMATCH",
        path: "documents[1].lines[1].quantity",
        message: '"1500" does not match the quote "1.500": this document writes decimals with "." (as in "2.4"), so the quote reads 1.500.',
      },
    ]);
    // Without that value neither the item's quantity nor the packing list's total quantity is compared, so nothing is guessed.
    expect(read("en-led-lighting/mixed-number-conventions/expected.json")).toEqual([]);
    const pl = read("en-led-lighting/mixed-number-conventions/extraction.json").documents[1];
    expect([pl.lines[1].quantity, pl.totalQuantity.quote, pl.lines[0].volumeM3.quote]).toEqual([{ value: "1500", quote: "1.500", page: 1 }, "2,500", "2.4"]);
  });

  it("include dates written month first, read without an issue", () => {
    const docs = read("en-led-lighting/month-first-dates/extraction.json").documents;
    const dates = (doc: Record<string, { value: string; quote: string }>) => [doc.date!.value, doc.date!.quote];
    expect(docs.map(dates)).toEqual([
      ["2026-10-14", "10/14/2026"],
      ["2026-10-15", "10/15/2026"],
      ["2026-10-16", "10/16/2026"],
      ["2026-10-02", "10/02/2026"],
    ]);
    // The invoice cites the contract's date, which alone could be read either way: the invoice's own date settles the order.
    expect(docs[0].contractRef.date).toMatchObject({ value: "2026-10-02", quote: "10/02/2026" });
    const result = checkDocuments(read("en-led-lighting/month-first-dates/extraction.json"));
    expect([result.findings, result.extractionIssues]).toEqual([[], []]);
    // Read day first, the same quote is an issue and no finding: the checker knows the document's order.
    const wrong = read("en-led-lighting/month-first-dates/extraction.json");
    wrong.documents[0].contractRef.date.value = "2026-02-10";
    const misread = checkDocuments(wrong);
    expect(misread.findings).toEqual([]);
    expect(misread.extractionIssues.map((i) => [i.code, i.path])).toEqual([["EXT_QUOTE_MISMATCH", "documents[0].contractRef.date"]]);
  });

  it("include a second invoice, and two documents in one PDF", () => {
    expect(variants.filter(({ variant }) => variant.files).map(({ pack, variant }) => [`${pack.id}/${variant.id}`, variant.files])).toEqual([
      ["en-led-lighting/second-invoice", ["invoice.pdf", "packing-list.pdf", "cmr.pdf", "contract.pdf", "invoice-2.pdf"]],
      ["en-led-lighting/two-documents-in-one-pdf", ["invoice-and-packing-list.pdf", "cmr.pdf", "contract.pdf"]],
    ]);
    // A second invoice: its own id and file, last in the extraction, so the four documents keep their places.
    const second = read("en-led-lighting/second-invoice/extraction.json").documents;
    expect(second.map((d: { id: string; type: string; sourceFile: string }) => [d.id, d.type, d.sourceFile])).toEqual([
      ["invoice", "commercial_invoice", "invoice.pdf"],
      ["packing-list", "packing_list", "packing-list.pdf"],
      ["cmr", "cmr", "cmr.pdf"],
      ["contract", "contract", "contract.pdf"],
      ["invoice-2", "commercial_invoice", "invoice-2.pdf"],
    ]);
    expect(read("en-led-lighting/second-invoice/expected.json")).toEqual([
      { rule: "DOC-01", severity: "warning", key: "DOC-01.multiple", params: { document: "commercial_invoice", count: "2" } },
    ]);
    // Two documents in one file: both name it, and the packing list's pages are counted in the file.
    const [invoice, pl, cmr] = read("en-led-lighting/two-documents-in-one-pdf/extraction.json").documents;
    expect([invoice.sourceFile, pl.sourceFile, cmr.sourceFile]).toEqual(["invoice-and-packing-list.pdf", "invoice-and-packing-list.pdf", "cmr.pdf"]);
    const pages = (doc: unknown) => [...new Set([...JSON.stringify(doc).matchAll(/"page":(\d+)/g)].map((m) => Number(m[1])))];
    expect([pages(invoice), pages(pl), pages(cmr)]).toEqual([[1], [2], [1]]);
    expect(read("en-led-lighting/two-documents-in-one-pdf/expected.json").map((f: { key: string }) => f.key)).toEqual(["REF-01.invoice-number"]);
  });

  it("print the freight terms of the variant's own Incoterms rule on the CMR", () => {
    // The charges box names the rule; a variant that changes the rule must not leave the pack's rule there.
    for (const built of buildAll()) {
      const { invoice, contract, cmr } = built.documents;
      const named = /\(([A-Z]{3})\)\s*$/.exec(cmr.carriageCharges.value ?? "")?.[1];
      if (!named) continue;
      expect([invoice.incoterm.code.value, contract.incoterm.code.value], `${built.pack.spec.id}/${built.variant.id}`).toEqual([named, named]);
    }
    const cip = read("tr-ceramics/cip-without-insurance/extraction.json").documents[2];
    expect(cip.carriageCharges.value).toBe("Navlun göndericiye aittir (CIP)");
    expect(read("en-led-lighting/sea-term-on-road/extraction.json").documents[2].carriageCharges.value).toBe("Freight payable by consignee (FOB)");
  });

  it.each(variants.map(({ pack, variant }) => [`${pack.id}/${variant.id}`, pack, variant] as const))(
    "%s: exactly the planted findings",
    (path, pack, variant) => {
      const result = checkDocuments(read(`${path}/extraction.json`));
      expect(result.ok).toBe(true);
      expect(result.extractionIssues.map((issue) => `${issue.code} ${issue.path}`)).toEqual(variant.expectedIssues ?? []);
      const actual = result.findings.map((f) => f.key).sort();
      expect(actual).toEqual([...variant.expected].sort());
      expect(read(`${path}/expected.json`).map((f: { key: string }) => f.key).sort()).toEqual(actual);
      for (const file of variant.files ?? pack.documents.map((doc) => `${doc}.pdf`)) expect(existsSync(`${ROOT}${path}/${file}`), file).toBe(true);
    },
  );

  it("mark every quoted piece of evidence in the documents' HTML (marked-PDF source)", () => {
    for (const built of buildAll()) {
      const d = built.documents;
      const breakBefore = built.variant.layout?.invoiceBreakBefore;
      const html: Record<string, string> = {
        invoice: renderInvoice(d.invoice, built.pack.spec, breakBefore === undefined ? {} : { breakBefore }),
        "packing-list": renderPackingList(d.packingList, built.pack.spec),
        cmr: renderCmr(d.cmr, built.pack.spec),
        contract: renderContract(d.contract, built.pack.spec),
        ...(d.secondInvoice ? { "invoice-2": renderInvoice(d.secondInvoice, built.pack.spec) } : {}),
      };
      for (const finding of built.findings) {
        for (const e of finding.evidence.filter((ev) => ev.quote !== null)) {
          expect(html[e.documentId], `${built.variant.id}: ${e.documentId} ${e.path}`).toContain(`data-f="${e.path}"`);
        }
      }
    }
  });

  it("are up to date with the generator (run `pnpm fixtures` after changes)", () => {
    for (const built of buildAll()) {
      // The files the index names are the ones the generator writes for the variant.
      const listed = index.packs.find((p) => p.id === built.pack.spec.id)!.variants.find((v) => v.id === built.variant.id)!;
      expect(listed.files ?? ["invoice.pdf", "packing-list.pdf", "cmr.pdf", "contract.pdf"], built.variant.id).toEqual(variantFiles(built.variant.layout, documentNames(built.documents)).map(({ file }) => file));
      expect(listed.expectedIssues ?? [], built.variant.id).toEqual(built.actualIssues);
      const stored = read(`${built.pack.spec.id}/${built.variant.id}/extraction.json`);
      expect(stored, `${built.pack.spec.id}/${built.variant.id}`).toEqual(JSON.parse(JSON.stringify(built.extraction)));
    }
  });
});
