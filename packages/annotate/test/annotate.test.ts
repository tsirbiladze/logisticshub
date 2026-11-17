import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildReport, checkDocuments } from "@logisticshub/core";
import { PDFArray, PDFDocument, PDFName, PDFString } from "pdf-lib";
import { describe, expect, it } from "vitest";
import {
  annotateDocuments,
  checkNotes,
  checkQuotes,
  locateField,
  locateInItems,
  markingNotes,
  marksBySourceFile,
  otherFileNotes,
  pdfProblem,
  placeBadge,
  quoteNotes,
  quoteOnPage,
} from "../src/index.ts";

const FIXTURES = fileURLToPath(new URL("../../../fixtures/", import.meta.url));
interface Layout {
  invoiceBreakBefore?: number;
  scanned?: string[];
  combined?: string[];
}
const index = JSON.parse(readFileSync(`${FIXTURES}index.json`, "utf8")) as {
  packs: { id: string; variants: { id: string; expected: string[]; layout?: Layout; files?: string[] }[] }[];
};
const DEFAULT_FILES = ["invoice.pdf", "packing-list.pdf", "cmr.pdf", "contract.pdf"];
/** The PDFs of a variant: one per document, unless its index entry lists others (a second invoice, two documents in one file). */
const filesOf = new Map(index.packs.flatMap((p) => p.variants.map((v): [string, string[]] => [`${p.id}/${v.id}`, v.files ?? DEFAULT_FILES])));
const withFindings = index.packs.flatMap((p) => p.variants.filter((v) => v.expected.length > 0).map((v) => `${p.id}/${v.id}`));
const allVariants = index.packs.flatMap((p) => p.variants.map((v) => `${p.id}/${v.id}`));
const layouts = new Map(index.packs.flatMap((p) => p.variants.map((v): [string, Layout] => [`${p.id}/${v.id}`, v.layout ?? {}])));
/** What a variant's layout says about one of its files: how many pages, and whether it is a scan. */
const fileLayout = (variant: string, file: string) => {
  const layout = layouts.get(variant)!;
  // A file that holds several documents has a page for each.
  const documents = layout.combined && file === `${layout.combined.join("-and-")}.pdf` ? layout.combined.length : 1;
  return { pages: file === "invoice.pdf" && layout.invoiceBreakBefore !== undefined ? 2 : documents, scanned: layout.scanned?.includes(file.replace(/\.pdf$/, "")) ?? false };
};
const item = (str: string, x: number, y = 700, hasEOL = false) => ({ str, transform: [9, 0, 0, 9, x, y], width: str.length * 5, height: 9, hasEOL });

describe("locateInItems", () => {
  it("matches whole tokens only", () => {
    const items = [item("1,600", 10), item(" ", 35), item("60", 40), item(" ", 60), item("600", 100)];
    expect(locateInItems(items, "60")).toHaveLength(1);
    expect(locateInItems(items, "600")).toHaveLength(1);
    expect(locateInItems(items, "1,600")).toHaveLength(1);
  });

  it("joins quotes wrapped over two lines into one box per line", () => {
    const items = [item("Gorgiladze Cad. No:60,", 10, 700, true), item("Batum", 10, 688)];
    const [rects] = locateInItems(items, "Gorgiladze Cad. No:60, Batum");
    expect(rects).toHaveLength(2);
  });

  it("keeps boxes in place when case-insensitive matching meets a Turkish İ", () => {
    // "İ".toLowerCase() is two characters; the box must still start at "ALICI", 5 units per character.
    const items = [item("İİİ ALICI", 10)];
    const [rects] = locateInItems(items, "alici");
    expect(rects).toEqual([{ x: 10 + 4 * 5 - 1.5, y: expect.any(Number), width: 5 * 5 + 3, height: expect.any(Number) }]);
    const [dotted] = locateInItems([item("Adres: İSTANBUL", 10)], "İstanbul");
    expect(dotted?.[0]?.x).toBe(10 + 7 * 5 - 1.5);
    expect(dotted?.[0]?.width).toBe(8 * 5 + 3);
  });
});

describe("locateField", () => {
  const cited = (path: string, quote: string) => ({ documentIndex: 0, path, quote });
  const at = (path: string) => ({ documentIndex: 0, path });
  // A currency box, two lines of a table, the totals, and the marks of the cartons.
  const items = [
    item("Currency", 10, 700),
    item(" ", 50, 700),
    item("USD", 60, 700, true),
    item("Qty Unit", 200, 660, true),
    item("400", 200, 650),
    item(" ", 215, 650),
    item("pcs", 220, 650, true),
    item("100", 200, 640),
    item(" ", 215, 640),
    item("pcs", 220, 640, true),
    item("Subtotal", 10, 600),
    item(" ", 50, 600),
    item("USD 15,500.00", 300, 600, true),
    item("Total due", 10, 588),
    item(" ", 50, 588),
    item("USD 15,500.00", 300, 588, true),
    item("Marks: BL/1-100", 10, 500, true),
  ];
  const fields = [
    cited("currency", "USD"),
    cited("lines[0].quantity", "400"),
    cited("lines[0].unit", "pcs"),
    cited("lines[1].quantity", "100"),
    cited("lines[1].unit", "pcs"),
    cited("subtotal", "USD 15,500.00"),
    cited("total", "USD 15,500.00"),
  ];
  const line = (found: { y: number }[][]) => found.map((rects) => Math.round(rects[0]!.y));
  const y = (baseline: number) => Math.round(baseline - 9 * 0.28 - 1.5);

  it("boxes the subtotal's copy for the subtotal and the total's for the total", () => {
    expect(locateInItems(items, "USD 15,500.00")).toHaveLength(2);
    const subtotal = locateField(items, "USD 15,500.00", at("subtotal"), fields);
    const total = locateField(items, "USD 15,500.00", at("total"), fields);
    expect(subtotal.copies).toBeUndefined();
    expect(line(subtotal.found)).toEqual([y(600)]);
    expect(line(total.found)).toEqual([y(588)]);
  });

  it("leaves the copies inside another field's longer quote to that field", () => {
    expect(locateInItems(items, "USD")).toHaveLength(3);
    const currency = locateField(items, "USD", at("currency"), fields);
    expect(currency.copies).toBeUndefined();
    expect(line(currency.found)).toEqual([y(700)]);
  });

  it("pairs the copies with the fields in order, line by line", () => {
    expect(line(locateField(items, "pcs", at("lines[0].unit"), fields).found)).toEqual([y(650)]);
    expect(line(locateField(items, "pcs", at("lines[1].unit"), fields).found)).toEqual([y(640)]);
  });

  it("prefers a copy that stands alone to one inside a code or range", () => {
    expect(locateInItems(items, "100")).toHaveLength(2);
    const quantity = locateField(items, "100", at("lines[1].quantity"), fields);
    expect(quantity.copies).toBeUndefined();
    expect(line(quantity.found)).toEqual([y(640)]);
  });

  it("boxes every copy and counts them when the field's own copy cannot be told apart", () => {
    // The amounts quoted without their currency: "USD" stands free three times for one field.
    const bare = fields.map((field) => (field.quote === "USD 15,500.00" ? { ...field, quote: "15,500.00" } : field));
    const currency = locateField(items, "USD", at("currency"), bare);
    expect(currency.copies).toBe(3);
    expect(currency.found).toHaveLength(3);
    // A field the extraction does not cite on this page, and no fields at all.
    expect(locateField(items, "pcs", at("packages"), fields).copies).toBe(2);
    expect(locateField(items, "pcs", at("lines[0].unit"), []).copies).toBe(2);
  });

  it("uses the copies inside longer quotes when the quote stands nowhere else", () => {
    const amounts = [item("Subtotal USD 500.00", 10, 600, true), item("Total USD 500.00", 10, 588, true)];
    const quoted = [cited("subtotal", "500.00"), cited("total", "500.00"), cited("seller.name", "Subtotal USD 500.00"), cited("buyer.name", "Total USD 500.00")];
    expect(line(locateField(amounts, "500.00", at("total"), quoted).found)).toEqual([y(588)]);
    expect(locateField(amounts, "500.00", at("total"), quoted.slice(1)).copies).toBe(2);
  });

  describe("a date the CMR prints in its header, in box 4 and in box 21", () => {
    // The header, box 4 (place and date of taking over, on two lines) and box 21 (place and date of issue, on one).
    const cmr = (header: boolean) => [
      item("No. VCL-0915226", 400, 800, true),
      ...(header ? [item("Date 16 Oct 2026", 400, 790, true)] : []),
      item("4. Place and date of taking over", 10, 700, true),
      item("Tööstuse 14, Tallinn, Estonia", 10, 690, true),
      item("16 Oct 2026", 10, 680, true),
      item("5. Documents attached", 300, 700, true),
      item("21. Established in", 10, 500, true),
      item("Tallinn · 16 Oct 2026", 10, 490, true),
    ];
    // Schema order: the CMR's own date (box 21) comes first, the date of taking over (box 4) later.
    const cited3 = [
      cited("number", "VCL-0915226"),
      cited("date", "16 Oct 2026"),
      cited("placeOfIssue", "Tallinn"),
      cited("carrier.name", "Via Caucasus Logistics LLC"),
      cited("placeOfTakingOver", "Tööstuse 14, Tallinn, Estonia"),
      cited("dateOfTakingOver", "16 Oct 2026"),
      cited("placeOfDelivery", "12 Aghmashenebeli Ave, Tbilisi, Georgia"),
    ];

    it("boxes the copy after the place of taking over for the date of taking over, and the one after the place of issue for the date", () => {
      expect(locateInItems(cmr(true), "16 Oct 2026")).toHaveLength(3);
      const takingOver = locateField(cmr(true), "16 Oct 2026", at("dateOfTakingOver"), cited3);
      const issued = locateField(cmr(true), "16 Oct 2026", at("date"), cited3);
      expect([takingOver.copies, issued.copies]).toEqual([undefined, undefined]);
      expect(line(takingOver.found)).toEqual([y(680)]);
      expect(line(issued.found)).toEqual([y(490)]);
    });

    it("does not swap the two when the header prints no date: box 4 comes first on the page, the CMR's date first in the schema", () => {
      expect(locateInItems(cmr(false), "16 Oct 2026")).toHaveLength(2);
      expect(line(locateField(cmr(false), "16 Oct 2026", at("dateOfTakingOver"), cited3).found)).toEqual([y(680)]);
      expect(line(locateField(cmr(false), "16 Oct 2026", at("date"), cited3).found)).toEqual([y(490)]);
    });

    it("still boxes every copy, and says so, for a field no neighbour settles", () => {
      // No place of issue was extracted: nothing says which copy is the CMR's own date.
      const without = cited3.filter((field) => field.path !== "placeOfIssue");
      expect(line(locateField(cmr(true), "16 Oct 2026", at("dateOfTakingOver"), without).found)).toEqual([y(680)]);
      const issued = locateField(cmr(true), "16 Oct 2026", at("date"), without);
      expect(issued.copies).toBe(3);
      expect(issued.found).toHaveLength(3);
    });

    it("gives a copy that two fields would claim to neither", () => {
      // Both dates stand next to the same place name: the neighbours settle nothing, and two fields cannot share three copies in order.
      const twins = [cited("date", "16 Oct 2026"), cited("placeOfIssue", "Tallinn"), cited("dateOfTakingOver", "16 Oct 2026")];
      expect(locateField(cmr(true), "16 Oct 2026", at("date"), twins).copies).toBe(3);
      expect(locateField(cmr(true), "16 Oct 2026", at("dateOfTakingOver"), twins).copies).toBe(3);
    });

    it("looks only at a neighbour that stands right next to the copy", () => {
      // A label between the place and the date: not next to each other, so the copies are paired in order as before.
      const labelled = [item("Place: Tallinn", 10, 700, true), item("Date: 16 Oct 2026", 10, 690, true), item("Taken over: 16 Oct 2026", 10, 600, true)];
      const fields2 = [cited("date", "16 Oct 2026"), cited("placeOfIssue", "Tallinn"), cited("dateOfTakingOver", "16 Oct 2026")];
      expect(line(locateField(labelled, "16 Oct 2026", at("date"), fields2).found)).toEqual([y(690)]);
      expect(line(locateField(labelled, "16 Oct 2026", at("dateOfTakingOver"), fields2).found)).toEqual([y(600)]);
    });
  });

  it("finds a quote printed once without looking at the other fields", () => {
    expect(locateField(items, "Total due", at("anything"), [])).toEqual({ found: locateInItems(items, "Total due") });
    expect(locateField(items, "not printed", at("anything"), fields)).toEqual({ found: [] });
  });
});

describe("placeBadge", () => {
  const box = { x: 100, y: 50, width: 40, height: 14 };

  it("puts the number left of the box, and a second number left of the first", () => {
    const first = placeBadge(box, 9, 10.5, []);
    expect(first).toEqual({ x: 90, y: 51.75, width: 9, height: 10.5 });
    const second = placeBadge(box, 9, 10.5, [first]);
    expect(second.x).toBe(80);
    expect(placeBadge(box, 13, 10.5, [first, second]).x).toBe(66);
    // A badge on another line is not in the way.
    expect(placeBadge(box, 9, 10.5, [{ ...first, y: 80 }]).x).toBe(90);
    // The order the badges were drawn in does not matter.
    expect(placeBadge(box, 13, 10.5, [second, first]).x).toBe(66);
  });

  it("stays on the page, and stays quick, when very many findings point at one text", () => {
    const drawn: { x: number; y: number; width: number; height: number }[] = [];
    const started = performance.now();
    for (let i = 0; i < 3000; i++) drawn.push(placeBadge(box, 9, 10.5, drawn));
    expect(performance.now() - started).toBeLessThan(5000);
    expect(drawn.every((badge) => badge.x >= 0)).toBe(true);
    // Ten fit between the box and the page edge; the rest go back next to the box.
    expect(new Set(drawn.map((badge) => badge.x)).size).toBe(10);
    expect(drawn.at(-1)!.x).toBe(90);
  });
});

describe("quoteOnPage", () => {
  // A table row whose cells the PDF stores column by column, and an address that wraps around another box.
  const items = [
    item("LED-PNL-60", 10),
    item(" ", 60),
    item("LED-TUBE-120", 70, 688, true),
    item("400", 200),
    item(" ", 215),
    item("1,500", 220, 688, true),
    item("pcs", 300),
    item(" ", 315),
    item("pcs", 320, 688, true),
    item("Tööstuse 14,", 10, 600, true),
    item("Reg. code EE-TEST-100200", 300, 600, true),
    item("10416 TALLİNN", 10, 588),
  ];

  it("finds a quote printed in one piece, in any letter case", () => {
    expect(quoteOnPage(items, "LED-PNL-60")).toBe(true);
    expect(quoteOnPage(items, "led-tube-120")).toBe(true);
    expect(quoteOnPage(items, "1,500")).toBe(true);
  });

  it("finds a quote the page stores in pieces: columns apart, a wrapped cell", () => {
    expect(locateInItems(items, "400 pcs")).toEqual([]);
    expect(quoteOnPage(items, "400 pcs")).toBe(true);
    expect(locateInItems(items, "Tööstuse 14, 10416 Tallinn")).toEqual([]);
    expect(quoteOnPage(items, "Tööstuse 14, 10416 Tallinn")).toBe(true);
  });

  it("does not find a quote with a word or number the page does not print", () => {
    expect(quoteOnPage(items, "450 pcs")).toBe(false);
    expect(quoteOnPage(items, "500")).toBe(false);
    expect(quoteOnPage(items, "1,50")).toBe(false);
    expect(quoteOnPage(items, "Tööstuse 14, 10416 Tartu")).toBe(false);
    expect(quoteOnPage([], "400")).toBe(false);
  });
});

/** A one-page PDF with no text layer, like a scan. */
async function blankPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage();
  return doc.save();
}

/** A PDF whose trailer names an encryption dictionary. */
async function encryptedPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage();
  const encrypt = doc.context.obj({ Filter: "Standard", V: 2, R: 3, Length: 128, P: -3904, O: PDFString.of("o"), U: PDFString.of("u") });
  doc.context.trailerInfo.Encrypt = doc.context.register(encrypt);
  return doc.save({ useObjectStreams: false });
}

describe("annotateDocuments", () => {
  const path = "ka-office-furniture/packages-mismatch";
  const view = buildReport(checkDocuments(JSON.parse(readFileSync(`${FIXTURES}${path}/extraction.json`, "utf8"))), "en");
  const sources = [...marksBySourceFile(view).keys()];

  it("skips a corrupt, an encrypted, a scanned and a missing PDF, and marks the rest", async () => {
    expect(sources.length).toBeGreaterThanOrEqual(3);
    const [corrupt, encrypted, scanned] = sources as [string, string, string];
    const blank = await blankPdf();
    const locked = await encryptedPdf();
    const read = (file: string) =>
      file === corrupt ? new TextEncoder().encode("not a pdf") : file === encrypted ? locked : file === scanned ? blank : null;
    const marking = await annotateDocuments(view, read);
    expect(marking.skipped).toBeNull();
    const byFile = new Map(marking.files.map((f) => [f.sourceFile, f]));
    expect(byFile.get(corrupt)?.error).toBe("the PDF cannot be read: it is damaged or not a PDF");
    expect(byFile.get(encrypted)?.error).toBe("the PDF is encrypted");
    expect(byFile.get(scanned)).toMatchObject({ error: null, bytes: null });
    for (const file of sources.slice(3)) expect(byFile.get(file)?.error).toBe("file not found");

    const notes = markingNotes(marking);
    const marks = (file: string) => marksBySourceFile(view).get(file)!.length;
    expect(notes).toContain(`${encrypted}: not marked: the PDF is encrypted`);
    expect(notes).toContain(`${corrupt}: not marked: the PDF cannot be read: it is damaged or not a PDF`);
    expect(notes).toContain(`${scanned}: ${marks(scanned)} of ${marks(scanned)} marks not located: page 1 has no text, likely a scan; no marked copy`);
    // The quote check says the same of the same files, in the same words, when no marking note names them.
    const extraction = checkDocuments(JSON.parse(readFileSync(`${FIXTURES}${path}/extraction.json`, "utf8"))).extraction!;
    const check = await checkQuotes(extraction, read);
    const said = quoteNotes(check);
    expect(said).toContain(`${corrupt}: quotes not checked: the PDF cannot be read: it is damaged or not a PDF`);
    expect(said).toContain(`${encrypted}: quotes not checked: the PDF is encrypted`);
    expect(said.join("\n")).not.toMatch(/Exception|Failed to parse|offset|Invalid PDF/);
  });

  it("says in plain words why a file could not be opened", async () => {
    const denied = Object.assign(new Error("EACCES: permission denied, open '/somewhere/invoice.pdf'"), { code: "EACCES" });
    expect(pdfProblem(denied)).toBe("the file cannot be read: permission denied (EACCES)");
    expect(pdfProblem(new Error("Failed to parse PDF document (line:89 col:1692 offset=399): No PDF header found"))).toBe("the PDF cannot be read: it is damaged or not a PDF");
    expect(pdfProblem(Object.assign(new Error("No password given"), { name: "PasswordException", code: 1 }))).toBe("the PDF is encrypted");
    const marking = await annotateDocuments(view, () => {
      throw denied;
    });
    expect(markingNotes(marking)).toEqual(sources.map((file) => `${file}: not marked: the file cannot be read: permission denied (EACCES)`));
  });

  it("says why a mark was not located: the page, the text layer or the quote", async () => {
    const wrong = structuredClone(view);
    const [first, second] = [...wrong.errors, ...wrong.warnings].flatMap((f) => f.evidence).filter((e) => e.quote !== null) as [
      (typeof wrong.errors)[number]["evidence"][number],
      (typeof wrong.errors)[number]["evidence"][number],
    ];
    first.page = 7;
    second.quote = "999 999";
    const marking = await annotateDocuments(wrong, (file) => readFileSync(`${FIXTURES}${path}/${file}`));
    const reasons = marking.files.flatMap((f) => f.results.filter((r) => r.rects.length === 0).map((r) => r.reason));
    expect(reasons.sort()).toEqual(["no-page", "not-found"]);
    const notes = markingNotes(marking).join("\n");
    expect(notes).toContain("marks not located: page 7 does not exist (1 page)");
    expect(notes).toContain("quote not found on page 1");
    expect(notes).not.toContain("scan");
  });

  it("marks the good file next to a bad one", async () => {
    const [bad, good] = sources as [string, string];
    const marking = await annotateDocuments(view, (file) =>
      file === bad ? new TextEncoder().encode("%PDF-1.7\ngarbage") : readFileSync(`${FIXTURES}${path}/${file}`),
    );
    const byFile = new Map(marking.files.map((f) => [f.sourceFile, f]));
    expect(byFile.get(bad)?.bytes).toBeNull();
    expect(byFile.get(bad)?.error).toBeTruthy();
    expect(byFile.get(good)?.error).toBeNull();
    expect(byFile.get(good)?.bytes?.subarray(0, 5)).toEqual(new TextEncoder().encode("%PDF-"));
  });

  it("skips marking, without throwing, where PDF.js cannot run (no global Iterator before Node.js 22)", async () => {
    const globals = globalThis as { Iterator?: unknown };
    const saved = globals.Iterator;
    delete globals.Iterator;
    try {
      const marking = await annotateDocuments(view, (file) => readFileSync(`${FIXTURES}${path}/${file}`));
      expect(marking.files).toEqual([]);
      expect(markingNotes(marking)).toEqual([`marked PDFs skipped: marking needs Node.js 22 or newer (this is ${process.version})`]);
    } finally {
      globals.Iterator = saved;
    }
  });
});

describe("checkQuotes", () => {
  const load = (variant: string) => JSON.parse(readFileSync(`${FIXTURES}${variant}/extraction.json`, "utf8"));
  const reader = (variant: string) => (file: string) => readFileSync(`${FIXTURES}${variant}/${file}`);

  it.each(allVariants)("%s: every quote is printed on its page", async (variant) => {
    const extraction = checkDocuments(load(variant)).extraction!;
    const check = await checkQuotes(extraction, reader(variant));
    expect(check.skipped).toBeNull();
    expect(check.files.map((f) => f.sourceFile).sort()).toEqual([...filesOf.get(variant)!].sort());
    expect(check.files.every((f) => f.quotes >= 10)).toBe(true);
    for (const file of check.files) {
      const { pages, scanned } = fileLayout(variant, file.sourceFile);
      expect(file.pages, file.sourceFile).toBe(pages);
      // A scan has no text to look the quotes up in: every one of them is left unchecked, and the note says so.
      expect(file.problems.map((p) => p.reason), file.sourceFile).toEqual(scanned ? Array(file.quotes).fill("no-text") : []);
    }
    const scans = check.files.filter((f) => fileLayout(variant, f.sourceFile).scanned);
    expect(quoteNotes(check)).toEqual(scans.map((f) => `${f.sourceFile}: page 1 has no text, likely a scan: ${f.quotes} quotes not checked`));
  });

  it("en-led-lighting/two-page-invoice: each quote is looked up on its own page", async () => {
    const variant = "en-led-lighting/two-page-invoice";
    const extraction = checkDocuments(load(variant)).extraction!;
    const [invoice] = extraction.documents;
    if (invoice?.type !== "commercial_invoice") throw new Error("fixture order");
    expect(invoice.lines.map((line) => line.lineTotal.page)).toEqual([1, 1, 2]);
    // The third line is printed on page 2 only, the first on page 1 only: swapped page numbers are caught.
    invoice.lines[2]!.model.page = 1;
    invoice.lines[0]!.description.page = 2;
    // The total stands on page 2; "page 3" does not exist.
    invoice.total.page = 3;
    const check = await checkQuotes(extraction, reader(variant));
    expect(quoteNotes(check)).toEqual([
      'invoice.pdf: page 2: 1 quote not found in the page text: documents[0].lines[0].description "LED ceiling panel 600×600 mm, 40 W"',
      'invoice.pdf: page 1: 1 quote not found in the page text: documents[0].lines[2].model "LED-DRV-40"',
      "invoice.pdf: page 3 does not exist (2 pages): documents[0].total",
    ]);
  });

  it("names the page that does not exist, the quote that is not printed and the page without text", async () => {
    const variant = "en-led-lighting/clean";
    const extraction = checkDocuments(load(variant)).extraction!;
    const [invoice, packingList, cmr] = extraction.documents;
    if (invoice?.type !== "commercial_invoice" || packingList?.type !== "packing_list" || cmr?.type !== "cmr") throw new Error("fixture order");
    invoice.total.page = 7;
    invoice.subtotal.page = 7;
    invoice.lines[0]!.quantity.quote = "450";
    invoice.seller.name.quote = "Baltic Lumen AS";
    packingList.totalPackages.page = null;
    packingList.totalNetWeightKg = { value: "695", quote: "696", page: null };
    const blank = await blankPdf();
    const check = await checkQuotes(extraction, (file) => (file === "cmr.pdf" ? blank : file === "contract.pdf" ? null : reader(variant)(file)));
    const scanned = check.files.find((f) => f.sourceFile === "cmr.pdf")!;
    expect(quoteNotes(check)).toEqual([
      "invoice.pdf: page 1: 2 quotes not found in the page text: documents[0].seller.name \"Baltic Lumen AS\"; documents[0].lines[0].quantity \"450\"",
      "invoice.pdf: page 7 does not exist (1 page): documents[0].subtotal, documents[0].total",
      "packing-list.pdf: any page: 1 quote not found in the page text: documents[1].totalNetWeightKg \"696\"",
      `cmr.pdf: page 1 has no text, likely a scan: ${scanned.quotes} quotes not checked`,
      "contract.pdf: quotes not checked: file not found",
    ]);
  });

  it("reads only PDFs, and names a file that cannot be read once", async () => {
    const variant = "ka-office-furniture/packages-mismatch";
    const result = checkDocuments(load(variant));
    const extraction = result.extraction!;
    extraction.documents[1]!.sourceFile = "packing-list.jpg";
    extraction.documents[3]!.sourceFile = null;
    const read = (file: string) => (file === "cmr.pdf" ? new TextEncoder().encode("%PDF-1.7\ngarbage") : reader(variant)(file));
    const check = await checkQuotes(extraction, read);
    expect(check.files.map((f) => f.sourceFile)).toEqual(["invoice.pdf", "cmr.pdf"]);
    expect(quoteNotes(check)).toEqual([expect.stringMatching(/^cmr\.pdf: quotes not checked: /)]);
    // With marking notes for the same run, the unreadable file is named once.
    const view = buildReport(result, "en");
    const notes = checkNotes(await annotateDocuments(view, read), check);
    expect(notes.filter((note) => note.startsWith("cmr.pdf:"))).toEqual([expect.stringMatching(/^cmr\.pdf: not marked: /)]);
    // The image is not passed over in silence: it has a finding, so it is said to be unmarked and unchecked.
    expect(notes.filter((note) => note.startsWith("packing-list.jpg:"))).toEqual([expect.stringMatching(/^packing-list\.jpg: an image: not marked, \d+ quotes not checked$/)]);
    expect(notes.at(-1)).toMatch(/^packing-list\.jpg: /);
  });

  it("says of a source file that is an image, or another format, that it was not marked and its quotes not checked", async () => {
    const variant = "ka-office-furniture/packages-mismatch";
    const result = checkDocuments(load(variant));
    const extraction = result.extraction!;
    const quotesOf = (index: number) => JSON.stringify(extraction.documents[index]).match(/"quote":"/g)!.length;
    // The CMR (cited by the finding) is a photo, the contract (no finding) a scan in another image format, the packing list a spreadsheet.
    extraction.documents[2]!.sourceFile = "CMR photo.JPG";
    extraction.documents[3]!.sourceFile = "contract.tiff";
    extraction.documents[1]!.sourceFile = "packing-list.xlsx";
    const view = buildReport(result, "en");
    const marking = await annotateDocuments(view, reader(variant));
    const check = await checkQuotes(extraction, reader(variant));
    expect(marking.others).toEqual(["packing-list.xlsx", "CMR photo.JPG"]);
    expect(check.others).toEqual([
      { sourceFile: "packing-list.xlsx", quotes: quotesOf(1) },
      { sourceFile: "CMR photo.JPG", quotes: quotesOf(2) },
      { sourceFile: "contract.tiff", quotes: quotesOf(3) },
    ]);
    expect(checkNotes(marking, check)).toEqual([
      `packing-list.xlsx: not a PDF: not marked, ${quotesOf(1)} quotes not checked`,
      `CMR photo.JPG: an image: not marked, ${quotesOf(2)} quotes not checked`,
      `contract.tiff: an image: ${quotesOf(3)} quotes not checked`,
    ]);
    // The invoice, a PDF, is still marked and checked.
    expect(marking.files.map((f) => [f.sourceFile, f.bytes !== null])).toEqual([["invoice.pdf", true]]);
    expect(check.files.map((f) => f.sourceFile)).toEqual(["invoice.pdf"]);
    // One quote, and a file nobody cites at all.
    expect(otherFileNotes({ files: [], skipped: null }, { files: [], skipped: null, others: [{ sourceFile: "a.png", quotes: 1 }, { sourceFile: "b.png", quotes: 0 }] })).toEqual(["a.png: an image: 1 quote not checked"]);
    expect(otherFileNotes({ files: [], skipped: null }, { files: [], skipped: null })).toEqual([]);
  });

  it("says so for images where no PDF can be read at all", async () => {
    const extraction = checkDocuments(load("ka-office-furniture/clean")).extraction!;
    for (const doc of extraction.documents) doc.sourceFile = `${doc.id}.png`;
    // Only images: PDF.js is not even loaded.
    const check = await checkQuotes(extraction, () => {
      throw new Error("no file is read");
    });
    expect(check).toMatchObject({ files: [], skipped: null });
    expect(checkNotes({ files: [], skipped: null }, check)).toHaveLength(4);
  });

  it("lists at most five fields per line", async () => {
    const variant = "en-led-lighting/clean";
    const extraction = checkDocuments(load(variant)).extraction!;
    const contract = extraction.documents[3]!;
    if (contract.type !== "contract") throw new Error("fixture order");
    for (const field of [contract.number, contract.date, contract.currency, contract.totalAmount, contract.totalInWords, contract.goodsDescription, contract.seller.name]) field.page = 2;
    const check = await checkQuotes(extraction, reader(variant));
    expect(quoteNotes(check)).toEqual([
      "contract.pdf: page 2 does not exist (1 page): documents[3].number, documents[3].date, documents[3].seller.name, documents[3].currency, documents[3].totalAmount, and 2 more",
    ]);
  });

  it("is skipped, without throwing, where PDF.js cannot run", async () => {
    const globals = globalThis as { Iterator?: unknown };
    const saved = globals.Iterator;
    delete globals.Iterator;
    try {
      const check = await checkQuotes(checkDocuments(load("en-led-lighting/clean")).extraction!, reader("en-led-lighting/clean"));
      expect(check.files).toEqual([]);
      expect(quoteNotes(check)).toEqual([`quotes not checked in the PDFs: reading PDFs needs Node.js 22 or newer (this is ${process.version})`]);
    } finally {
      globals.Iterator = saved;
    }
  });
});

describe("a quote printed more than once", () => {
  const load = (variant: string) => buildReport(checkDocuments(JSON.parse(readFileSync(`${FIXTURES}${variant}/extraction.json`, "utf8"))), "en");
  const reader = (variant: string) => (file: string) => readFileSync(`${FIXTURES}${variant}/${file}`);
  const invoiceMarks = async (variant: string, view = load(variant)) => {
    const marking = await annotateDocuments(view, reader(variant));
    return { marking, results: marking.files.find((f) => f.sourceFile === "invoice.pdf")!.results };
  };
  /** Top edges of the boxes, highest on the page first (PDF y grows upwards). */
  const tops = (rects: { y: number }[]) => rects.map((r) => Math.round(r.y)).sort((a, b) => b - a);

  it("en-led-lighting/line-arithmetic: the subtotal finding has one box, on the subtotal row", async () => {
    const { marking, results } = await invoiceMarks("en-led-lighting/line-arithmetic");
    const subtotal = results.find((r) => r.mark.field?.path === "subtotal")!;
    expect(subtotal.mark.quote).toBe("USD 15,500.00");
    expect(subtotal.rects).toHaveLength(1);
    // The same text is printed again as the total, one row lower.
    const { getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(reader("en-led-lighting/line-arithmetic")("invoice.pdf")), { verbosity: 0 });
    const items = (await (await pdf.getPage(1)).getTextContent()).items as Parameters<typeof locateInItems>[0];
    const copies = locateInItems(items, "USD 15,500.00").flat();
    expect(copies).toHaveLength(2);
    expect(tops(subtotal.rects)).toEqual(tops(copies).slice(0, 1));
    expect(markingNotes(marking)).toEqual([]);
  });

  it("en-led-lighting/currency-in-words: USD is boxed once, in the currency box", async () => {
    const { marking, results } = await invoiceMarks("en-led-lighting/currency-in-words");
    const currency = results.find((r) => r.mark.field?.path === "currency")!;
    expect(currency.mark.quote).toBe("USD");
    expect(currency.rects).toHaveLength(1);
    expect(currency.copies).toBeUndefined();
    expect(markingNotes(marking)).toEqual([]);
  });

  it("ka-office-furniture/vat-not-in-total: subtotal and total share a quote and get a box each", async () => {
    const { results } = await invoiceMarks("ka-office-furniture/vat-not-in-total");
    const subtotal = results.find((r) => r.mark.field?.path === "subtotal")!;
    const total = results.find((r) => r.mark.field?.path === "total")!;
    expect(subtotal.mark.quote).toBe(total.mark.quote);
    expect([subtotal.mark.label, subtotal.rects.length, total.rects.length]).toEqual([total.mark.label, 1, 1]);
    expect(subtotal.rects[0]!.y).toBeGreaterThan(total.rects[0]!.y);
  });

  it("ru-textile/invoice-after-shipment: the CMR prints its date three times, and the finding boxes the one in box 4", async () => {
    const variant = "ru-textile/invoice-after-shipment";
    const view = load(variant);
    expect([...view.errors, ...view.warnings].map((f) => f.key)).toEqual(["DATE-01.invoice-after-shipment"]);
    const marking = await annotateDocuments(view, reader(variant));
    const cmr = marking.files.find((f) => f.sourceFile === "cmr.pdf")!;
    expect(cmr.results.map((r) => [r.mark.field?.path, r.mark.quote, r.rects.length, r.copies])).toEqual([["dateOfTakingOver", "07.10.2026", 1, undefined]]);
    expect(markingNotes(marking)).toEqual([]);
    // Three copies on the page: the header's is the highest, box 21's the lowest, and the boxed one stands between them.
    const { getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(reader(variant)("cmr.pdf")), { verbosity: 0 });
    const items = (await (await pdf.getPage(1)).getTextContent()).items as Parameters<typeof locateInItems>[0];
    const copies = tops(locateInItems(items, "07.10.2026").flat());
    expect(copies).toHaveLength(3);
    expect(tops(cmr.results[0]!.rects)).toEqual([copies[1]]);
    // The CMR's own date (box 21) is the lowest copy.
    const cited = view.citations.filter((c) => c.sourceFile === "cmr.pdf");
    expect(tops(locateField(items, "07.10.2026", { documentIndex: 2, path: "date" }, cited).found.flat())).toEqual([copies[2]]);
  });

  it("en-led-lighting/two-documents-in-one-pdf: one file, a mark on the invoice's page and one on the packing list's", async () => {
    const variant = "en-led-lighting/two-documents-in-one-pdf";
    const view = load(variant);
    expect(view.documents.map((d) => d.sourceFile)).toEqual(["invoice-and-packing-list.pdf", "invoice-and-packing-list.pdf", "cmr.pdf", "contract.pdf"]);
    const marking = await annotateDocuments(view, reader(variant));
    expect(marking.files.map((f) => f.sourceFile)).toEqual(["invoice-and-packing-list.pdf"]);
    const [file] = marking.files;
    // The packing list's reference on page 2, the invoice's own number on page 1: each boxed once.
    expect(file!.results.map((r) => [r.mark.field?.documentIndex, r.mark.field?.path, r.mark.page, r.mark.quote, r.rects.length, r.copies])).toEqual([
      [1, "invoiceRef.number", 2, "BL-INV-26-0421", 1, undefined],
      [0, "number", 1, "BL-INV-26-0412", 1, undefined],
    ]);
    expect(markingNotes(marking)).toEqual([]);
    const doc = await PDFDocument.load(file!.bytes!);
    expect(doc.getPageCount()).toBe(2);
    for (const page of [0, 1]) expect(doc.getPage(page).node.lookupMaybe(PDFName.of("Annots"), PDFArray)?.size()).toBe(1);
    // The quote check reads the one file for both documents, each quote on its own page.
    const check = await checkQuotes(checkDocuments(JSON.parse(readFileSync(`${FIXTURES}${variant}/extraction.json`, "utf8"))).extraction!, reader(variant));
    expect(check.files.map((f) => [f.sourceFile, f.pages, f.problems.length])).toEqual([["invoice-and-packing-list.pdf", 2, 0], ["cmr.pdf", 1, 0], ["contract.pdf", 1, 0]]);
    // A page number counted in the document instead of the file is found out: the packing list is not on page 1.
    const wrong = JSON.parse(readFileSync(`${FIXTURES}${variant}/extraction.json`, "utf8"));
    wrong.documents[1].totalGrossWeightKg.page = 1;
    const notes = quoteNotes(await checkQuotes(checkDocuments(wrong).extraction!, reader(variant)));
    expect(notes).toEqual(['invoice-and-packing-list.pdf: page 1: 1 quote not found in the page text: documents[1].totalGrossWeightKg "785"']);
  });

  it("en-led-lighting/second-invoice: both invoices are marked at their numbers", async () => {
    const variant = "en-led-lighting/second-invoice";
    const view = load(variant);
    expect([...view.errors, ...view.warnings].map((f) => f.key)).toEqual(["DOC-01.multiple"]);
    const marking = await annotateDocuments(view, reader(variant));
    expect(marking.files.map((f) => [f.sourceFile, f.results.map((r) => [r.mark.quote, r.rects.length])])).toEqual([
      ["invoice.pdf", [["BL-INV-26-0412", 1]]],
      ["invoice-2.pdf", [["BL-INV-26-0413", 1]]],
    ]);
    expect(markingNotes(marking)).toEqual([]);
  });

  it("boxes every copy and says so when the field's own copy cannot be told apart", async () => {
    // The amounts quoted without their currency, as an extractor may do: "USD" now stands free three times.
    const view = load("en-led-lighting/currency-in-words");
    for (const cited of view.citations) if (cited.quote === "USD 15,500.00") cited.quote = "15,500.00";
    const { marking, results } = await invoiceMarks("en-led-lighting/currency-in-words", view);
    const currency = results.find((r) => r.mark.field?.path === "currency")!;
    expect(currency.copies).toBe(3);
    expect(currency.rects).toHaveLength(3);
    expect(markingNotes(marking)).toEqual(['invoice.pdf: page 1: "USD" is printed 3 times and finding 1 could not be tied to one of them; all 3 are boxed']);
  });
});

describe("annotated fixture PDFs", () => {
  it.each(withFindings)("%s: every quoted piece of evidence is marked", async (path) => {
    const result = checkDocuments(JSON.parse(readFileSync(`${FIXTURES}${path}/extraction.json`, "utf8")));
    const view = buildReport(result, "en");
    const expectedMarks = [...marksBySourceFile(view).values()].flat().length;
    const marking = await annotateDocuments(view, (file) => readFileSync(`${FIXTURES}${path}/${file}`));
    expect(marking.skipped).toBeNull();
    // A scan has no text to find a quote in: its marks are not located, and the note says why.
    const scans = marking.files.filter((f) => fileLayout(path, f.sourceFile).scanned);
    expect(markingNotes(marking)).toEqual(
      scans.map((f) => `${f.sourceFile}: ${f.results.length} of ${f.results.length} marks not located: page 1 has no text, likely a scan; no marked copy`),
    );
    const results = marking.files.filter((f) => !scans.includes(f)).flatMap((f) => f.results);
    expect(results.length).toBe(expectedMarks - scans.flatMap((f) => f.results).length);
    expect(results.filter((r) => r.rects.length === 0).map((r) => r.mark.quote)).toEqual([]);
    // Every mark is tied to one place: no quote is boxed at all its copies.
    expect(results.filter((r) => r.copies !== undefined).map((r) => r.mark.quote)).toEqual([]);

    for (const file of marking.files) {
      if (scans.includes(file)) {
        expect(file.bytes).toBeNull();
        continue;
      }
      // Each mark's annotation is on the page the extraction names.
      const doc = await PDFDocument.load(file.bytes!);
      expect(doc.getPageCount()).toBe(fileLayout(path, file.sourceFile).pages);
      for (let page = 1; page <= doc.getPageCount(); page++) {
        const annots = doc.getPage(page - 1).node.lookupMaybe(PDFName.of("Annots"), PDFArray);
        expect(annots?.size() ?? 0, `${file.sourceFile} page ${page}`).toBe(file.results.filter((r) => r.mark.page === page).length);
      }
    }
  });

  it("en-led-lighting/two-page-invoice: the marks are on page 2, where the wrong line and the subtotal are printed", async () => {
    const path = "en-led-lighting/two-page-invoice";
    const view = buildReport(checkDocuments(JSON.parse(readFileSync(`${FIXTURES}${path}/extraction.json`, "utf8"))), "en");
    const marking = await annotateDocuments(view, (file) => readFileSync(`${FIXTURES}${path}/${file}`));
    expect(marking.files.map((f) => f.sourceFile)).toEqual(["invoice.pdf"]);
    const [invoice] = marking.files;
    expect(invoice!.results.map((r) => [r.mark.label, r.mark.field?.path, r.mark.page, r.rects.length])).toEqual([
      ["1", "lines[2].quantity", 2, 1],
      ["1", "lines[2].unitPrice", 2, 1],
      ["1", "lines[2].lineTotal", 2, 1],
      ["2", "subtotal", 2, 1],
    ]);
    expect(markingNotes(marking)).toEqual([]);
  });

  it("ka-office-furniture/scanned-cmr: the packing list is marked, the scanned CMR cannot be", async () => {
    const path = "ka-office-furniture/scanned-cmr";
    const result = checkDocuments(JSON.parse(readFileSync(`${FIXTURES}${path}/extraction.json`, "utf8")));
    const read = (file: string) => readFileSync(`${FIXTURES}${path}/${file}`);
    const marking = await annotateDocuments(buildReport(result, "en"), read);
    const byFile = new Map(marking.files.map((f) => [f.sourceFile, f]));
    expect(byFile.get("packing-list.pdf")?.results.map((r) => [r.mark.quote, r.rects.length])).toEqual([["1,880", 1]]);
    expect(byFile.get("cmr.pdf")).toMatchObject({ bytes: null, error: null, results: [{ mark: { quote: "1,800" }, rects: [], reason: "no-text" }] });
    const quotes = await checkQuotes(result.extraction!, read);
    const scanned = quotes.files.find((f) => f.sourceFile === "cmr.pdf")!;
    expect(checkNotes(marking, quotes)).toEqual([
      "cmr.pdf: 1 of 1 marks not located: page 1 has no text, likely a scan; no marked copy",
      `cmr.pdf: page 1 has no text, likely a scan: ${scanned.quotes} quotes not checked`,
    ]);
  });
});
