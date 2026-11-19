/**
 * The built skill (skills/logisticshub) is what users install. These tests
 * run the bundled check.mjs as a separate process, like an agent would.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkNotes, pdfProblem, type AnnotatedFile, type Mark, type Marking, type QuoteCheck, type QuoteProblem } from "@logisticshub/annotate";
import {
  blankDocument,
  checkDocuments,
  DECLARATION_GUIDE,
  EXTRACTION_CHECKS,
  EXTRACTION_GUIDE,
  extractionBlank,
  extractionJsonSchema,
  ISSUES_GUIDE,
  MESSAGES,
  NOT_CHECKED,
  RULE_IDS,
  SCHEMA_VERSION,
  type TradeDocument,
} from "@logisticshub/core";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SKILL = join(ROOT, "skills/logisticshub");
const SCRIPT = join(SKILL, "scripts/check.mjs");

function check(...args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
}

/** A copy of a fixture folder (extraction.json and PDFs) to change. */
function copyFixture(path: string): string {
  const dir = mkdtempSync(join(tmpdir(), "lh-skill-"));
  for (const file of readdirSync(join(ROOT, "fixtures", path))) copyFileSync(join(ROOT, "fixtures", path, file), join(dir, file));
  return dir;
}

describe("built skill", () => {
  it("has Agent Skills frontmatter matching its folder", () => {
    const skill = readFileSync(join(SKILL, "SKILL.md"), "utf8");
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? "";
    expect(frontmatter).toMatch(/^name: logisticshub$/m);
    const description = /^description: (.+)$/m.exec(frontmatter)?.[1] ?? "";
    expect(description.length).toBeGreaterThan(50);
    expect(description.length).toBeLessThanOrEqual(1024);
  });

  it("is up to date (run `pnpm build:skill` after changes)", () => {
    expect(readFileSync(join(SKILL, "SKILL.md"), "utf8")).toBe(readFileSync(join(ROOT, "packages/skill/SKILL.md"), "utf8"));
    expect(JSON.parse(readFileSync(join(SKILL, "references/extraction-schema.json"), "utf8"))).toEqual(extractionJsonSchema());
    expect(readFileSync(join(SKILL, "references/extraction.md"), "utf8")).toBe(EXTRACTION_GUIDE);
    expect(JSON.parse(readFileSync(join(SKILL, "references/extraction-blank.json"), "utf8"))).toEqual(extractionBlank());
    expect(readFileSync(join(SKILL, "references/issues.md"), "utf8")).toBe(ISSUES_GUIDE);
    expect(readFileSync(join(SKILL, "references/declaration.md"), "utf8")).toBe(DECLARATION_GUIDE);
    for (const line of EXTRACTION_CHECKS) expect(readFileSync(join(SKILL, "references/rules.md"), "utf8")).toContain(line);
  });

  it("ships the blank with one fact per line, so its shape can be read", () => {
    const blank = readFileSync(join(SKILL, "references/extraction-blank.json"), "utf8");
    expect(blank).toContain('"number": { "value": null, "quote": null, "page": null },');
    // Spread over five lines per fact it was 626 lines; a document's keys now fit on a screen.
    expect(blank.split("\n").length).toBeLessThan(270);
  });

  it("ships a blank whose documents and items make a well-shaped extraction", () => {
    const blank = JSON.parse(readFileSync(join(SKILL, "references/extraction-blank.json"), "utf8"));
    const documents = Object.entries(blank.documents as Record<string, Record<string, unknown>>).map(([type, doc]) => {
      const filled = { ...doc };
      // One copy of each item in its list, as the guide says to do for each printed line.
      for (const [list, item] of Object.entries((blank.items[type] ?? {}) as Record<string, unknown>)) filled[list] = [item];
      return filled;
    });
    expect(documents.map((doc) => doc.type)).toEqual(["commercial_invoice", "packing_list", "cmr", "contract", "customs_declaration", "other"]);
    const result = checkDocuments({ ...blank.file, documents });
    expect(result.extractionIssues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("states every rule and every finding key in references/rules.md, and what is not checked", () => {
    const rules = readFileSync(join(SKILL, "references/rules.md"), "utf8");
    for (const id of RULE_IDS) expect(rules).toContain(`### ${id} · `);
    for (const key of Object.keys(MESSAGES.en)) expect(rules).toContain(`\`${key}\``);
    expect(rules).toContain("## Not checked");
    for (const line of NOT_CHECKED) expect(rules).toContain(line);
  });

  it("names every file SKILL.md points to", () => {
    const skill = readFileSync(join(SKILL, "SKILL.md"), "utf8");
    const named = [...skill.matchAll(/`((?:references|scripts)\/[A-Za-z0-9.-]+)`/g)].map((match) => match[1]!);
    expect(named.length).toBeGreaterThan(4);
    for (const path of new Set(named)) expect(existsSync(join(SKILL, path)), path).toBe(true);
  });

  it("checks a fixture and writes all three reports", () => {
    const out = mkdtempSync(join(tmpdir(), "lh-skill-"));
    const result = check(join(ROOT, "fixtures/en-led-lighting/line-arithmetic/extraction.json"), "--lang", "en", "--out", out);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Line 2: 1,500 × 2.90 = 4,350.00 USD, but the line total is 4,530.00 USD.");
    expect(result.stdout).toContain("invoice BL-INV-26-0412 (invoice.pdf), p. 1 · line 2, total: “4,530.00”");
    const json = JSON.parse(readFileSync(join(out, "report.json"), "utf8"));
    expect(json.findings.map((f: { key: string }) => f.key).sort()).toEqual(["SUM-01.line", "SUM-02.subtotal"]);
    expect(readFileSync(join(out, "report.html"), "utf8")).toContain("<html lang=\"en\">");
    expect(readFileSync(join(out, "report.md"), "utf8")).toContain("# Document check report");
    expect(result.stdout).toContain("invoice.marked.pdf");
    expect(readFileSync(join(out, "invoice.marked.pdf")).subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("prints the schema, rejects bad input and bad options", () => {
    expect(JSON.parse(check("--schema").stdout)).toEqual(extractionJsonSchema());
    const out = mkdtempSync(join(tmpdir(), "lh-skill-"));
    const bad = join(out, "bad.json");
    spawnSync("sh", ["-c", `echo '{"documents": 1}' > ${bad}`]);
    expect(check(bad, "--out", out).status).toBe(1);
    expect(check("--lang", "xx", bad).status).toBe(2);
    const format = check(join(ROOT, "fixtures/en-led-lighting/clean/extraction.json"), "--out", out, "--format", "md,pdf");
    expect(format.status).toBe(2);
    expect(format.stderr).toContain('got "pdf"');
    expect(check(join(ROOT, "fixtures/en-led-lighting/clean/extraction.json"), "--out", out, "--format", " md , json").status).toBe(0);
  });

  describe("input it cannot use ends in one line and exit code 2", () => {
    const clean = join(ROOT, "fixtures/en-led-lighting/clean/extraction.json");
    const scratch = () => mkdtempSync(join(tmpdir(), "lh-skill-"));
    /** Exit 2, nothing on stdout, exactly this one line on stderr: no usage text, no stack trace. */
    const stopped = (result: ReturnType<typeof check>, line: string) => {
      expect(result.stderr).toBe(`${line}\n`);
      expect(result.stdout).toBe("");
      expect(result.status).toBe(2);
    };

    it("--out below a file, --out naming a file, --out in a folder that cannot be written to", () => {
      const dir = scratch();
      const blocker = join(dir, "notes.txt");
      writeFileSync(blocker, "a file");
      stopped(check(clean, "--out", join(blocker, "reports")), `Cannot write to ${join(blocker, "reports")}: a file stands where a folder is needed (ENOTDIR). Give --out a folder that can be written to.`);
      stopped(check(clean, "--out", blocker), `Cannot write to ${blocker}: a file with that name is in the way (EEXIST). Give --out a folder that can be written to.`);
      const locked = join(dir, "locked");
      mkdirSync(locked);
      chmodSync(locked, 0o555);
      // Root writes anywhere, so there is nothing to refuse.
      if (process.getuid?.() !== 0) {
        stopped(check(clean, "--out", locked), `Cannot write ${join(locked, "report.md")}: permission denied (EACCES). Give --out a folder that can be written to.`);
        stopped(check(clean, "--out", join(locked, "deeper")), `Cannot write to ${join(locked, "deeper")}: permission denied (EACCES). Give --out a folder that can be written to.`);
      }
      chmodSync(locked, 0o755);
    });

    it("a report that cannot be written because a folder has its name", () => {
      const dir = scratch();
      mkdirSync(join(dir, "report.json"));
      stopped(check(clean, "--out", dir), `Cannot write ${join(dir, "report.json")}: it is a folder, not a file (EISDIR). Give --out a folder that can be written to.`);
    });

    it("a file that is missing, is a folder, is empty or is not JSON", () => {
      const dir = scratch();
      stopped(check(join(dir, "missing.json")), `Cannot read ${join(dir, "missing.json")}: no such file or folder (ENOENT).`);
      stopped(check(dir), `Cannot read ${dir}: it is a folder, not a file (EISDIR).`);
      const file = join(dir, "extraction.json");
      writeFileSync(file, "");
      stopped(check(file), `Cannot read ${file}: the file is empty. Fix the file and run the check again.`);
      writeFileSync(file, '{\n  "schemaVersion": "1",\n  "documents": [],\n}\n');
      stopped(check(file), `Cannot read ${file}: not valid JSON at line 4, column 1 (unexpected "}"). Fix the file and run the check again.`);
      writeFileSync(file, '{"schemaVersion": "1", "documents": [');
      stopped(check(file), `Cannot read ${file}: not valid JSON: it ends too early at line 1, column 38. Fix the file and run the check again.`);
      expect(readdirSync(dir)).toEqual(["extraction.json"]);
    });

    it("a wrong option still comes with the usage text", () => {
      const result = check(clean, "--lang", "xx");
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/^--lang must be one of en, ka, ru, tr\.\n\nLogisticshub .*\n\nUsage:\n/);
      expect(result.stderr).toContain("2  nothing was checked");
    });
  });

  it("reads an extraction saved with a byte order mark, UTF-8 or UTF-16", () => {
    const dir = copyFixture("tr-ceramics/words-mismatch");
    const file = join(dir, "extraction.json");
    const plain = check(file, "--no-annotate");
    expect(plain.status).toBe(0);
    expect(plain.stdout).toContain("# Belge kontrol raporu");
    const text = readFileSync(file, "utf8");
    writeFileSync(file, `\uFEFF${text}`);
    expect(check(file, "--no-annotate")).toMatchObject({ status: 0, stdout: plain.stdout, stderr: "" });
    // What Windows PowerShell writes with ">": UTF-16, little-endian, with a mark.
    writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]));
    expect(check(file, "--no-annotate")).toMatchObject({ status: 0, stdout: plain.stdout, stderr: "" });
    writeFileSync(file, Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, "utf16le").swap16()]));
    expect(check(file, "--no-annotate")).toMatchObject({ status: 0, stdout: plain.stdout, stderr: "" });
  });

  it("reports an extraction of the wrong shape, exit code 1, one line per problem", () => {
    const dir = copyFixture("en-led-lighting/clean");
    const file = join(dir, "extraction.json");
    const extraction = JSON.parse(readFileSync(file, "utf8"));
    extraction.documents[0].type = "bill_of_lading";
    delete extraction.documents[1].totalPackages;
    extraction.documents[2].number.page = 1e300;
    delete extraction.documents[3].type;
    writeFileSync(file, JSON.stringify(extraction));
    const result = check(file, "--lang", "en", "--out", join(dir, "out"));
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    const issues = result.stdout.split("\n").filter((line) => line.includes("(EXT_SHAPE)"));
    // On the terminal the values are as an agent has to type them: no Markdown escapes.
    expect(issues).toEqual([
      '- `documents[0].type` (EXT_SHAPE): Unknown type "bill_of_lading". Use commercial_invoice, packing_list, cmr, contract, customs_declaration or other.',
      '- `documents[1].totalPackages` (EXT_SHAPE): Missing. Write { "value": null, "quote": null, "page": null } when the document does not print it.',
      "- `documents[2].number.page` (EXT_SHAPE): Must be a whole number (1 for the first page) or null, got a number too large to be a page.",
      "- `documents[3].type` (EXT_SHAPE): Missing. Use commercial_invoice, packing_list, cmr, contract, customs_declaration or other.",
    ]);
    expect(result.stdout).not.toContain("\\");
    // report.md is a Markdown file: there the underscores are escaped, so they are shown and not read as emphasis.
    expect(readFileSync(join(dir, "out", "report.md"), "utf8")).toContain('Unknown type "bill\\_of\\_lading". Use commercial\\_invoice, packing\\_list, cmr, contract, customs\\_declaration or other.');
    expect(readdirSync(join(dir, "out")).sort()).toEqual(["report.html", "report.json", "report.md"]);
  });

  it("prints document text to the terminal as printed, on one line, and keeps the escapes in report.md", () => {
    const dir = copyFixture("en-led-lighting/clean");
    const file = join(dir, "extraction.json");
    const extraction = JSON.parse(readFileSync(file, "utf8"));
    const evil = "Evil_Co *Ltd*\n\n**Errors: 0 · Warnings: 0**\n## Done [ok](x) `x` <b>|~\\";
    extraction.documents[3].seller.name = { value: evil, quote: `Seller:\n${evil}`, page: 1 };
    extraction.documents[0].number = { value: "INV_26*0412", quote: "INV_26*0412", page: 1 };
    writeFileSync(file, JSON.stringify(extraction));
    const result = check(file, "--lang", "en", "--out", join(dir, "out"), "--no-annotate");
    expect(result.status).toBe(0);
    const terminal = result.stdout.slice(0, result.stdout.indexOf("\nFiles:\n"));
    const oneLine = "Evil_Co *Ltd* **Errors: 0 · Warnings: 0** ## Done [ok](x) `x` <b>|~\\";
    expect(terminal).toContain(`"${oneLine}" (contract)`);
    expect(terminal).toContain(`· seller: “Seller: ${oneLine}”`);
    expect(terminal).toContain("packing list BL-PL-26-0412 (packing-list.pdf), p. 1 · invoice number: “BL-INV-26-0412”");
    expect(terminal).toContain("invoice INV_26*0412 (invoice.pdf), p. 1 · number: “INV_26*0412”");
    // Document text still cannot start a line: one summary line, and only the report's own headings.
    expect(terminal.split("\n").filter((line) => line.startsWith("**Errors"))).toHaveLength(1);
    expect(terminal.split("\n").filter((line) => line.startsWith("## "))).toEqual(["## Errors", "## Warnings"]);
    // The same report as a file: escaped, line for line otherwise the same.
    const md = readFileSync(join(dir, "out", "report.md"), "utf8");
    expect(md).toContain("invoice INV\\_26\\*0412 (invoice.pdf), p. 1 · number: “INV\\_26\\*0412”");
    expect(md.replace(/\\([\\`*_[\]<>|~])/g, "$1")).toBe(`${terminal}\n`.replace(/\n\n$/, "\n"));
    // The Python port prints the same bytes.
    const python = spawnSync("python3", [join(SKILL, "scripts/check.py"), file, "--lang", "en", "--out", join(dir, "py")], { encoding: "utf8" });
    if (python.error === undefined) {
      expect(python.stdout.slice(0, python.stdout.indexOf("\nFiles:\n"))).toBe(terminal);
      expect(readFileSync(join(dir, "py", "report.md"), "utf8")).toBe(md);
    }
  });

  it("checks a two-page invoice: evidence on page 2, marks on page 2", () => {
    const dir = copyFixture("en-led-lighting/two-page-invoice");
    const result = check(join(dir, "extraction.json"), "--lang", "en", "--out", join(dir, "out"));
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Line 3: 600 × 6.25 = 3,750.00 USD, but the line total is 3,570.00 USD.");
    expect(result.stdout).toContain("- invoice BL-INV-26-0412 (invoice.pdf), p. 2 · line 3, total: “3,570.00”");
    expect(result.stdout).toContain("- invoice BL-INV-26-0412 (invoice.pdf), p. 2 · subtotal: “USD 15,500.00”");
    expect(result.stdout).not.toContain("Notes:");
    const expected = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8"));
    const report = JSON.parse(readFileSync(join(dir, "out", "report.json"), "utf8"));
    expect(report.findings.map(({ rule, severity, key, params }: Record<string, unknown>) => ({ rule, severity, key, params }))).toEqual(expected);
    expect(readdirSync(join(dir, "out")).sort()).toEqual(["invoice.marked.pdf", "report.html", "report.json", "report.md"]);
  });

  it("checks a set whose CMR is a scan, and says what could not be looked up in it", () => {
    const dir = copyFixture("ka-office-furniture/scanned-cmr");
    const result = check(join(dir, "extraction.json"), "--out", join(dir, "out"));
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("ბრუტო წონა განსხვავდება: შეფუთვის ფურცელში 1\u00a0880 კგ, CMR-ში 1\u00a0800 კგ.");
    const notes = result.stdout.slice(result.stdout.indexOf("Notes:\n")).trim().split("\n");
    expect(notes).toEqual([
      "Notes:",
      "- cmr.pdf: 1 of 1 marks not located: page 1 has no text, likely a scan; no marked copy",
      expect.stringMatching(/^- cmr\.pdf: page 1 has no text, likely a scan: \d+ quotes not checked$/),
    ]);
    const expected = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8"));
    const report = JSON.parse(readFileSync(join(dir, "out", "report.json"), "utf8"));
    expect(report.findings.map(({ rule, severity, key, params }: Record<string, unknown>) => ({ rule, severity, key, params }))).toEqual(expected);
    expect(readdirSync(join(dir, "out")).sort()).toEqual(["packing-list.marked.pdf", "report.html", "report.json", "report.md"]);
  });

  it("refuses an extraction written for the older schema in one line that says what to do", () => {
    const dir = copyFixture("en-led-lighting/clean");
    const file = join(dir, "extraction.json");
    const extraction = JSON.parse(readFileSync(file, "utf8"));
    expect(extraction.schemaVersion).toBe("3");
    // As schema version 1 had it: without the fields version 2 added.
    extraction.schemaVersion = "1";
    for (const key of ["tax", "otherCharges", "discountPercent"]) delete extraction.documents[0][key];
    delete extraction.documents[1].packingMethod;
    for (const line of extraction.documents[1].lines) delete line.packingMethod;
    writeFileSync(file, JSON.stringify(extraction));
    const result = check(file, "--lang", "en", "--no-annotate");
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout.split("\n").filter((line) => line.startsWith("- `"))).toEqual([
      '- `schemaVersion` (EXT_SHAPE): This extraction is written for schema version "1"; this checker reads version "3". Extract the documents again with the guide that comes with this checker.',
    ]);
    expect(result.stdout).toContain("The extraction could not be read, so no rules ran.");
  });

  it("stays silent on stderr when a PDF is damaged or password-protected", () => {
    const dir = copyFixture("en-led-lighting/line-arithmetic");
    // Cut off in the middle: pdf-lib parses what is left and used to warn about every object it could not read.
    writeFileSync(join(dir, "invoice.pdf"), readFileSync(join(dir, "invoice.pdf")).subarray(0, 9000));
    const result = check(join(dir, "extraction.json"), "--out", join(dir, "out"));
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    // In plain words, not the parser's ("Failed to parse PDF document (line:89 col:1692 offset=399)").
    expect(result.stdout.slice(result.stdout.indexOf("Notes:\n"))).toBe("Notes:\n- invoice.pdf: not marked: the PDF cannot be read: it is damaged or not a PDF\n");
    // Encrypted with a password (made with Ghostscript): not marked, and said once.
    copyFileSync(fileURLToPath(new URL("./support/password-protected.pdf", import.meta.url)), join(dir, "invoice.pdf"));
    const locked = check(join(dir, "extraction.json"), "--out", join(dir, "out"));
    expect(locked.status).toBe(0);
    expect(locked.stderr).toBe("");
    expect(locked.stdout).toContain("Notes:\n- invoice.pdf: not marked: the PDF is encrypted\n");
  });

  it("marks the other PDFs when one is corrupt, and says which", () => {
    const dir = copyFixture("en-led-lighting/wrong-invoice-ref");
    writeFileSync(join(dir, "packing-list.pdf"), "%PDF-1.7\nnot really");
    const result = check(join(dir, "extraction.json"), "--out", join(dir, "out"));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Notes:\n- packing-list.pdf: not marked: the PDF cannot be read: it is damaged or not a PDF\n");
    expect(existsSync(join(dir, "out", "invoice.marked.pdf"))).toBe(true);
    expect(existsSync(join(dir, "out", "packing-list.marked.pdf"))).toBe(false);
  });

  it("lists the quotes the PDFs do not print, with the reason, under Notes", () => {
    const dir = copyFixture("en-led-lighting/clean");
    const clean = check(join(dir, "extraction.json"), "--out", join(dir, "out"));
    expect(clean.status).toBe(0);
    expect(clean.stdout).not.toContain("Notes:");

    const extraction = JSON.parse(readFileSync(join(dir, "extraction.json"), "utf8"));
    const [invoice, , cmr] = extraction.documents;
    invoice.total.page = 7;
    invoice.subtotal.quote = "USD 15,550.00";
    writeFileSync(join(dir, "extraction.json"), JSON.stringify(extraction));
    // The CMR as a scan: a page with no text layer.
    writeFileSync(join(dir, "cmr.pdf"), "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\ntrailer<</Root 1 0 R>>\n");
    const wrong = check(join(dir, "extraction.json"), "--out", join(dir, "out"));
    expect(wrong.status).toBe(0);
    const notes = wrong.stdout.slice(wrong.stdout.indexOf("Notes:\n")).trim().split("\n");
    expect(notes).toEqual([
      "Notes:",
      '- invoice.pdf: page 1: 1 quote not found in the page text: documents[0].subtotal "USD 15,550.00"',
      "- invoice.pdf: page 7 does not exist (1 page): documents[0].total",
      expect.stringMatching(/^- cmr\.pdf: page 1 has no text, likely a scan: \d+ quotes not checked$/),
    ]);
    expect(cmr.sourceFile).toBe("cmr.pdf");
    // --no-annotate leaves the PDFs unread.
    expect(check(join(dir, "extraction.json"), "--out", join(dir, "out"), "--no-annotate").stdout).not.toContain("Notes:");
  });

  it("checks the sets the guide's hard cases describe: mixed numbers, month-first dates, a second invoice, two documents in one PDF", () => {
    const run = (variant: string) => {
      const dir = copyFixture(`en-led-lighting/${variant}`);
      const result = check(join(dir, "extraction.json"), "--lang", "en", "--out", join(dir, "out"));
      expect(result.stderr, variant).toBe("");
      expect(result.status, variant).toBe(0);
      expect(result.stdout, variant).not.toContain("Notes:");
      return { stdout: result.stdout, files: readdirSync(join(dir, "out")).sort() };
    };
    // A number the checker cannot read for certain: one issue, the value left out, nothing guessed and nothing marked.
    const mixed = run("mixed-number-conventions");
    expect(mixed.stdout).toContain("**Errors: 0 · Warnings: 0**");
    expect(mixed.stdout).toContain('- `documents[1].lines[1].quantity` (EXT_QUOTE_MISMATCH): "1500" does not match the quote "1.500": this document writes decimals with "." (as in "2.4"), so the quote reads 1.500.');
    expect(mixed.stdout).not.toContain("No problems found");
    expect(mixed.files).toEqual(["report.html", "report.json", "report.md"]);
    // Month-first dates are read as the documents write them: a clean set.
    const monthFirst = run("month-first-dates");
    expect(monthFirst.stdout).toContain("Extraction: no issues");
    expect(monthFirst.stdout).toContain("✓ No problems found.");
    // Two invoices: said once, with what to check, and each invoice marked at its number.
    const second = run("second-invoice");
    expect(second.stdout).toContain("**Errors: 0 · Warnings: 1** · Checked: 5 documents, 18 rules");
    expect(second.stdout).toContain("- invoice BL-INV-26-0413 (invoice-2.pdf), p. 1 · number: “BL-INV-26-0413”");
    expect(second.stdout).toContain("→ See whether the first of them is the one that belongs to this shipment");
    expect(second.files).toEqual(["invoice-2.marked.pdf", "invoice.marked.pdf", "report.html", "report.json", "report.md"]);
    // One PDF with two documents: the evidence names the file and the page in it, and one marked copy holds both marks.
    const combined = run("two-documents-in-one-pdf");
    expect(combined.stdout).toContain("- packing list BL-PL-26-0412 (invoice-and-packing-list.pdf), p. 2 · invoice number: “BL-INV-26-0421”");
    expect(combined.stdout).toContain("- invoice BL-INV-26-0412 (invoice-and-packing-list.pdf), p. 1 · number: “BL-INV-26-0412”");
    expect(combined.files).toEqual(["invoice-and-packing-list.marked.pdf", "report.html", "report.json", "report.md"]);
  });

  it("says under Notes that a source file which is an image was not marked and its quotes not checked", () => {
    const dir = copyFixture("ka-office-furniture/packages-mismatch");
    const extraction = JSON.parse(readFileSync(join(dir, "extraction.json"), "utf8"));
    const cmr = extraction.documents[2];
    cmr.sourceFile = "cmr.jpg";
    const quotes = JSON.stringify(cmr).match(/"quote":"/g)!.length;
    writeFileSync(join(dir, "extraction.json"), JSON.stringify(extraction));
    const result = check(join(dir, "extraction.json"), "--out", join(dir, "out"));
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const notes = result.stdout.slice(result.stdout.indexOf("Notes:\n")).trim().split("\n");
    expect(notes).toEqual(["Notes:", `- cmr.jpg: an image: not marked, ${quotes} quotes not checked`]);
    // The PDFs of the same finding are marked as before.
    expect(existsSync(join(dir, "out", "invoice.marked.pdf"))).toBe(true);
    expect(existsSync(join(dir, "out", "cmr.marked.pdf"))).toBe(false);
  });

  it("writes the reports and skips marking on a Node.js without the global Iterator (before 22)", () => {
    const dir = mkdtempSync(join(tmpdir(), "lh-skill-"));
    const preload = join(dir, "node20.mjs");
    writeFileSync(preload, "delete globalThis.Iterator;\n");
    const out = join(dir, "out");
    const result = spawnSync(
      process.execPath,
      ["--import", pathToFileURL(preload).href, SCRIPT, join(ROOT, "fixtures/en-led-lighting/line-arithmetic/extraction.json"), "--out", out],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Line 2: 1,500 × 2.90 = 4,350.00 USD");
    expect(result.stdout).toContain("- marked PDFs skipped: marking needs Node.js 22 or newer");
    expect(result.stdout).toContain("- quotes not checked in the PDFs: reading PDFs needs Node.js 22 or newer");
    expect(readdirSync(out).sort()).toEqual(["report.html", "report.json", "report.md"]);
  });

  it("ships the licenses of everything check.mjs bundles", () => {
    const notices = readFileSync(join(SKILL, "scripts/THIRD-PARTY-NOTICES.txt"), "utf8");
    for (const name of ["pdf-lib", "unpdf", "zod", "pako"]) expect(notices).toMatch(new RegExp(`^- ${name} \\d`, "m"));
    expect(notices).toContain("--- dist/licenses/LICENSE_PDFJS");
    expect(notices).toContain("Apache License");
  });
});

describe("references/issues.md", () => {
  const issues = readFileSync(join(SKILL, "references/issues.md"), "utf8");
  /** The rows of the table under the given line: each row's cells. */
  const table = (after: string) => {
    const lines = issues.slice(issues.indexOf(after)).split("\n");
    const start = lines.findIndex((line) => line.startsWith("|---"));
    const rows: string[][] = [];
    for (const line of lines.slice(start + 1)) {
      if (!line.startsWith("|")) break;
      rows.push(line.slice(1, -1).split(" | ").map((cell) => cell.trim()));
    }
    return rows;
  };
  const spans = (cell: string) => [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1]!);
  const fact = (value: string, quote: string) => ({ value, quote, page: 1 });
  /** The messages of the issues an invoice gets after `change`. */
  const messages = (change: (doc: Extract<TradeDocument, { type: "commercial_invoice" }>) => void) => {
    const doc = { ...blankDocument("commercial_invoice", "invoice"), sourceFile: "invoice.pdf", language: "en" as const };
    change(doc);
    return checkDocuments({ schemaVersion: SCHEMA_VERSION, documents: [doc] }).extractionIssues;
  };

  it("has a row for every issue code the checker raises", () => {
    const source = readFileSync(join(ROOT, "packages/core/src/validate.ts"), "utf8");
    // EXT_MODEL is the CLI's: a model call that failed. The skill's scripts never raise it.
    const codes = [...new Set(source.match(/EXT_[A-Z_]+/g))].filter((code) => code !== "EXT_MODEL").sort();
    expect(codes).toHaveLength(9);
    expect(table("| Code | Means | Fix |").map((row) => spans(row[0]!)[0]).sort()).toEqual(codes);
  });

  it("words each EXT_QUOTE_MISMATCH message as the checker does", () => {
    const produced = [
      messages((doc) => void (doc.grossWeightKg = fact("1500", "1,880 kg"))),
      messages((doc) => {
        doc.netWeightKg = fact("2.4", "2.4");
        doc.grossWeightKg = fact("1500", "1.500");
      }),
      messages((doc) => void (doc.date = fact("2026-11-05", "05/10/2026"))),
      messages((doc) => {
        doc.contractRef.date = fact("2026-09-18", "18.09.2026");
        doc.date = fact("2026-05-10", "05.10.2026");
      }),
      messages((doc) => void (doc.date = fact("2026-11-14", "14 Oct 2026"))),
      messages((doc) => void (doc.freight = fact("500.00", "(500.00)"))),
      messages((doc) => void (doc.currency = fact("EUR", "USD 15,500.00"))),
    ];
    for (const list of produced) expect(list.map((issue) => issue.code)).toEqual(["EXT_QUOTE_MISMATCH"]);
    const rows = table("| The message ends |");
    const tails = rows.map((row) => spans(row[0]!)[0]!.replace(/^…/, ""));
    expect(tails).toHaveLength(produced.length);
    // Row by row: the message the checker gives ends as the table says.
    produced.forEach((list, index) => expect(list[0]!.message.endsWith(tails[index]!), `${list[0]!.message} / ${tails[index]}`).toBe(true));
    // And the table's own examples of a charge and a document that mixes conventions are true of the code.
    expect(messages((doc) => void (doc.tax = fact("500.00", "-500.00")))[0]!.message).toContain("so the quote reads -500.00.");
    expect(issues).toContain('`as in "2.4"`');
  });

  it("lists every note the script can print, worded as it prints it", () => {
    const mark = (page: number, quote = "USD 15,500.00"): Mark => ({ page, quote, label: "2", severity: "error" }) as Mark;
    const file = (results: AnnotatedFile["results"], extra: Partial<AnnotatedFile> = {}): AnnotatedFile => ({ sourceFile: "invoice.pdf", bytes: new Uint8Array(1), results, pages: 1, error: null, ...extra });
    const marking = (files: AnnotatedFile[], extra: Partial<Marking> = {}): Marking => ({ files, skipped: null, ...extra });
    const problem = (reason: QuoteProblem["reason"], page: number): QuoteProblem => ({ path: "documents[0].total", quote: "USD 15,550.00", page, reason });
    const quotes = (problems: QuoteProblem[], error: string | null = null): QuoteCheck => ({ files: [{ sourceFile: "invoice.pdf", pages: 1, quotes: 46, problems, error }], skipped: null });
    const none: QuoteCheck = { files: [], skipped: null };
    const encrypted = pdfProblem(new Error("No password given"));
    const damaged = pdfProblem(new Error("Failed to parse PDF document (line:89 col:1692 offset=399)"));
    const denied = pdfProblem(Object.assign(new Error("EACCES: permission denied, open"), { code: "EACCES" }));
    const printed = [
      ...checkNotes(marking([]), quotes([problem("no-page", 7), problem("no-page", 7)])),
      ...checkNotes(marking([]), quotes([problem("not-found", 1), problem("not-found", 1)])),
      ...checkNotes(marking([file([{ mark: mark(1), rects: [], reason: "not-found" }, { mark: mark(1), rects: [{ x: 0, y: 0, width: 1, height: 1 }] }])]), none),
      ...checkNotes(marking([file([], { bytes: null, error: "file not found" })]), none),
      ...checkNotes(marking([]), quotes([], "file not found")),
      ...checkNotes(marking([file([{ mark: mark(1), rects: [], reason: "no-text" }], { bytes: null })]), quotes([problem("no-text", 1), problem("no-text", 1)])),
      ...checkNotes(marking([], { others: ["cmr.jpg"] }), { ...none, others: [{ sourceFile: "cmr.jpg", quotes: 46 }] }),
      ...checkNotes(marking([]), { ...none, others: [{ sourceFile: "cmr.jpg", quotes: 46 }] }),
      ...checkNotes(marking([], { others: ["invoice.docx"] }), { ...none, others: [{ sourceFile: "invoice.docx", quotes: 12 }] }),
      ...[encrypted, damaged, denied].flatMap((reason) => [
        ...checkNotes(marking([file([], { bytes: null, error: reason })]), none),
        ...checkNotes(marking([]), quotes([], reason)),
      ]),
      ...checkNotes(marking([file([{ mark: mark(1, "16 Oct 2026"), rects: [{ x: 0, y: 0, width: 1, height: 1 }], copies: 3 }])]), none),
      ...checkNotes(marking([], { skipped: "marking needs Node.js 22 or newer (this is v20.11.0)" }), { ...none, skipped: "reading PDFs needs Node.js 22 or newer (this is v20.11.0)" }),
    ];
    expect(printed).toHaveLength(19);
    expect([encrypted, damaged, denied]).toEqual(["the PDF is encrypted", "the PDF cannot be read: it is damaged or not a PDF", "the file cannot be read: permission denied (EACCES)"]);

    /** A note of the table as a pattern: its placeholders stand for any file, number, path, quote or reason. */
    const pattern = (span: string) =>
      span
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(/<file>/g, "[^:]+")
        // "an image" stands for "not a PDF" too, as the row says.
        .replace(/^(\[\^:\]\+: )an image:/, "$1(?:an image|not a PDF):")
        .replace(/<(?:paths|path|quote|reason)>/g, ".+")
        .replace(/\b[NMK]\b/g, "[0-9]+")
        .replace(/page [0-9]+/g, "page [0-9]+")
        .replace(/\\\([0-9]+ page\\\)/g, "\\([0-9]+ pages?\\)")
        .replace(/v20\\\.…/g, "v20.*")
        .replace(/; …|: …/g, (cut) => `${cut.slice(0, 1)}.*`);
    const noteSpans = table("| Note | Do |").flatMap((row) => spans(row[0]!));
    expect(noteSpans.length).toBeGreaterThan(12);
    // Every note the script prints is a row of the table…
    for (const note of printed) expect(noteSpans.some((span) => new RegExp(`^${pattern(span)}$`).test(note)), note).toBe(true);
    // …and the table has no row, and no reason, that the script does not print.
    for (const span of noteSpans) expect(printed.some((note) => new RegExp(pattern(span)).test(note)), span).toBe(true);
  });

  it("is where SKILL.md and the guide send an agent after the check, and nowhere before it", () => {
    const skill = readFileSync(join(SKILL, "SKILL.md"), "utf8");
    expect(skill).toContain("When either is there, open `references/issues.md`");
    expect(EXTRACTION_GUIDE).toContain("When the report lists an issue or the script prints `Notes:`, open `issues.md`");
    // The table of notes moved out of SKILL.md with the table of codes: neither is needed before the check.
    expect(skill).not.toContain("| Note | Do |");
    expect(issues).toContain("| Note | Do |");
  });
});
