/**
 * CLI pipeline and MCP server, with a mock model: no network, no keys.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DECLARATION_GUIDE, documentJsonSchema, EXTRACTION_GUIDE, extractionBlank, extractionJsonSchema, ISSUES_GUIDE, RULE_IDS } from "@logisticshub/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { AGENT_ONLY_SECTIONS, answerObject, correctionRequest, issueRows, MODEL_GUIDE, MODEL_INSTRUCTIONS } from "../src/extract.ts";
import { createServer, ISSUES_PREFACE, SERVER_INSTRUCTIONS } from "../src/mcp.ts";
import { ModelConfigError, parseModelId, resolveModel } from "../src/models.ts";
import { collectFiles, NoDocumentError, NothingChecked, OutputError, parseFormats, runCheck, UsageError } from "../src/run.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FIXTURES = join(ROOT, "fixtures/");
const fixture = (path: string) => readFileSync(join(FIXTURES, path), "utf8");
const out = () => mkdtempSync(join(tmpdir(), "lh-cli-"));
/** The skill's own checker, built and committed: the CLI must word and exit the same for the same input. */
const SKILL_SCRIPT = join(ROOT, "skills/logisticshub/scripts/check.mjs");

/** `format`: "json" when the call asks the provider for structured output, "text" when it asks for plain text. */
type Call = { prompt: string; format: "json" | "text" };
/** An answer the provider stopped at its output limit. */
type CutOff = { cutOff: string };
type Doc = { sourceFile: string; type: string; language: string | null };
type Kind = "classify" | "extract" | "repair";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));

/**
 * Mock model that plays every step: classification (answers with the file's
 * type) and extraction or repair (answers with that file's document from a
 * fixture extraction). `answer` can replace a step's text, cut it off or
 * throw for a file.
 */
function mockModel(extractionJson: string, answer: (file: string, kind: Kind) => string | Error | CutOff | undefined = () => undefined, delayMs = 0) {
  const docs: Doc[] = JSON.parse(extractionJson).documents;
  const calls: Call[] = [];
  const stats = { inFlight: 0, maxInFlight: 0 };
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      const prompt = JSON.stringify(options.prompt);
      calls.push({ prompt, format: options.responseFormat?.type === "json" ? "json" : "text" });
      stats.inFlight += 1;
      stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
      try {
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
        const doc = docs.find((d) => prompt.includes(`File: ${d.sourceFile}`))!;
        const kind: Kind = prompt.includes("Classify this file") ? "classify" : prompt.includes("The checker found these problems") ? "repair" : "extract";
        const custom = answer(doc.sourceFile, kind);
        if (custom instanceof Error) throw custom;
        const cutOff = typeof custom === "object";
        const text =
          (cutOff ? custom.cutOff : custom) ??
          (kind === "classify" ? JSON.stringify({ files: [{ sourceFile: doc.sourceFile, type: doc.type, language: doc.language }] }) : JSON.stringify(doc));
        return {
          content: [{ type: "text", text }],
          finishReason: { unified: cutOff ? "length" : "stop", raw: undefined },
          usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 20, text: 20, reasoning: undefined },
          },
          warnings: [],
        };
      } finally {
        stats.inFlight -= 1;
      }
    },
  });
  return { model, calls, stats };
}

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

/** The CLI as a process, with no key in its environment: any model call would end the run. */
const cli = (...args: string[]) =>
  spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env: { ...process.env, ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", OPENROUTER_API_KEY: "", LOGISTICSHUB_MODEL: "" } });
const skill = (...args: string[]) => spawnSync(process.execPath, [SKILL_SCRIPT, ...args], { encoding: "utf8" });

/** A copy of a fixture folder (extraction.json and PDFs) to change. */
function copyFixture(path: string): string {
  const dir = mkdtempSync(join(tmpdir(), "lh-cli-fixture-"));
  for (const file of readdirSync(join(FIXTURES, path))) copyFileSync(join(FIXTURES, path, file), join(dir, file));
  return dir;
}

/** The extraction of a fixture with one text replaced in it. */
function changed(path: string, from: string, to: string): string {
  const text = fixture(path);
  expect(text, from).toContain(from);
  return text.replaceAll(from, to);
}

/** One document of an extraction, as the model would return it. */
const documentOf = (extractionJson: string, sourceFile: string) =>
  JSON.stringify(JSON.parse(extractionJson).documents.find((d: Doc) => d.sourceFile === sourceFile));

describe("logisticshub check", () => {
  it("reads PDFs with the model, checks them and marks the findings", async () => {
    const dir = "ka-office-furniture/words-mismatch";
    const { model, calls } = mockModel(fixture(`${dir}/extraction.json`));
    const outDir = out();
    const run = await runCheck({ inputs: [join(FIXTURES, dir)], outDir, model: () => model, language: "ka" });

    expect(run.result.findings.map((f) => f.key)).toEqual(["AMT-01.mismatch"]);
    expect(run.modelCalls).toBe(8); // 4 files × (classification + extraction)
    expect(run.complete).toBe(true);
    expect(run.notes).toEqual([]);
    expect(run.markdown).toContain("სიტყვიერად წერია 13\u00a0500,00 EUR, ციფრებით კი 13\u00a0300,00 EUR.");
    for (const name of ["extraction.json", "report.md", "report.json", "report.html", "invoice.marked.pdf"]) {
      expect(existsSync(join(outDir, name)), name).toBe(true);
    }
    expect(run.annotations.flatMap((a) => a.results).every((r) => r.rects.length > 0)).toBe(true);

    const classifications = calls.filter((c) => c.prompt.includes("Classify this file"));
    expect(classifications).toHaveLength(4);
    for (const c of classifications) expect(c.prompt.match(/application\/pdf/g)).toHaveLength(1);
    const invoiceCall = calls.find((c) => c.prompt.includes("File: invoice.pdf") && !c.prompt.includes("Classify"))!;
    expect(invoiceCall.prompt.match(/application\/pdf/g)).toHaveLength(1);
    expect(invoiceCall.prompt).toContain("This file is a commercial_invoice.");
  });

  it("asks for a document as text, with the type's schema in the request", async () => {
    // Claude refuses the invoice's schema as structured output ("The compiled grammar is too large"), so only classification asks for it.
    const dir = "en-led-lighting/clean";
    const good = fixture(`${dir}/extraction.json`);
    const wrong = documentOf(changed(`${dir}/extraction.json`, "Kartli Retail LLC", "Kartli Wholesale LLC"), "invoice.pdf");
    const { model, calls } = mockModel(good, (_file, kind) => (kind === "extract" ? wrong : undefined));
    const run = await runCheck({ inputs: [join(FIXTURES, dir, "invoice.pdf")], outDir: out(), model: () => model });
    expect(run.result.extractionIssues).toEqual([]);
    expect(calls.map((c) => c.format)).toEqual(["json", "text", "text"]); // classify, extract, repair
    const inPrompt = (text: string) => JSON.stringify(text).slice(1, -1);
    const schema = inPrompt(JSON.stringify(documentJsonSchema("commercial_invoice")));
    expect(calls[1]!.prompt).toContain(inPrompt("Return the document JSON and nothing else: no words around it and no code fence. It must match this JSON Schema, with every key present:\n") + schema);
    expect(calls[2]!.prompt).toContain(schema);
    expect(calls[0]!.prompt).not.toContain(schema);
  });

  it("reads a document the model wrapped in a code fence or in words", async () => {
    const dir = "ka-office-furniture/words-mismatch";
    const good = fixture(`${dir}/extraction.json`);
    const expected: { key: string }[] = JSON.parse(fixture(`${dir}/expected.json`));
    const { model } = mockModel(good, (file, kind) =>
      kind === "classify" ? undefined : file === "invoice.pdf" ? `Here is the document:\n\n\`\`\`json\n${documentOf(good, file)}\n\`\`\`\n` : `\`\`\`\n${documentOf(good, file)}\n\`\`\``,
    );
    const run = await runCheck({ inputs: [join(FIXTURES, dir)], outDir: out(), model: () => model });
    expect(run.complete).toBe(true);
    expect(run.result.extractionIssues).toEqual([]);
    expect(run.result.findings.map((f) => f.key)).toEqual(expected.map((f) => f.key));
    expect(expected).toHaveLength(1);

    const doc = { type: "other", note: "a } and a {" };
    expect(answerObject(JSON.stringify(doc))).toEqual(doc);
    expect(answerObject(`  \n${JSON.stringify(doc, null, 2)}\n`)).toEqual(doc);
    for (const text of ["", "I cannot read this file.", "[1, 2]", '{"type": "other"', "{ type: other }", "} {"]) expect(() => answerObject(text), text).toThrow("the answer is not JSON");
  });

  it("classifies a declaration PDF and sends the declaration guide only for it", async () => {
    const dir = "ka-office-furniture/declaration-gross-mismatch";
    const { model, calls } = mockModel(fixture(`${dir}/extraction.json`));
    const outDir = out();
    const run = await runCheck({ inputs: [join(FIXTURES, dir)], outDir, model: () => model });
    expect(run.result.extractionIssues).toEqual([]);
    expect(run.result.findings.map((f) => f.key)).toEqual(["DEC-03.gross"]);
    const extractions = calls.filter((call) => call.format === "text");
    expect(extractions).toHaveLength(5);
    expect(extractions.filter(({ prompt }) => prompt.includes("# Georgian goods declaration")).map(({ prompt }) => prompt.includes("File: declaration.pdf"))).toEqual([true]);
    expect(existsSync(join(outDir, "declaration.marked.pdf"))).toBe(true);
    expect(run.notes).toEqual([]);
  });

  it("appends and checks a saved Revenue Service response without a model or PDF for that source", () => {
    const dir = join(FIXTURES, "ka-office-furniture/declaration-rs-clean");
    const appended = cli("declaration-from-rs", join(dir, "rs-response.json"), "--registration", "C-DEMO-2041",
      "--append", join(FIXTURES, "ka-office-furniture/declaration-clean/extraction.json"));
    expect(appended.status).toBe(0);
    expect(JSON.parse(appended.stdout).documents.at(-1)).toMatchObject({ id: "declaration-2", sourceFile: "rs-response.json", sourceKind: "rs_json" });

    const converted = cli("declaration-from-rs", join(dir, "rs-response.json"));
    expect(converted.status).toBe(0);
    const doc = JSON.parse(converted.stdout).documents[0];
    doc.importer.taxId = { value: "900000009", quote: "900000009", page: null };
    const extraction = readJson(join(dir, "extraction.json"));
    extraction.documents[4] = doc;
    const output = out();
    const input = join(output, "extraction.json");
    writeFileSync(input, JSON.stringify(extraction));
    const checked = cli("check", input, "--out", output, "--lang", "en", "--pdf-dir", dir);
    expect(checked.status).toBe(0);
    const report = readJson(join(output, "report.json"));
    expect(report.findings.map((f: { key: string }) => f.key)).toEqual(["DEC-01.tax-id"]);
    expect(report.documents[4]).toMatchObject({ sourceFile: "rs-response.json" });
    expect(report.findings[0].evidence[1]).toMatchObject({ quote: "900000009", page: null });
    expect(report.sourceNotes.join()).toContain("rs-response.json");
    expect(readdirSync(output).filter((file) => file.endsWith(".marked.pdf"))).toEqual(["invoice.marked.pdf"]);
  });

  it("leaves a file out when its answer is not JSON or was cut off, and says which", async () => {
    const dir = "tr-ceramics/consignee-mismatch";
    const good = fixture(`${dir}/extraction.json`);
    const answers: Record<string, string | { cutOff: string }> = {
      "invoice.pdf": "I cannot read this file.",
      "cmr.pdf": { cutOff: documentOf(good, "cmr.pdf").slice(0, 400) },
    };
    const { model } = mockModel(good, (file, kind) => (kind === "extract" ? answers[file] : undefined));
    const outDir = out();
    const run = await runCheck({ inputs: [join(FIXTURES, dir)], outDir, model: () => model });
    expect(run.complete).toBe(false);
    expect(run.modelCalls).toBe(8); // no repair call: there is no document to correct
    expect(run.result.extractionIssues).toContainEqual({ code: "EXT_MODEL", path: "invoice.pdf", message: "extraction failed: the answer is not JSON" });
    expect(run.result.extractionIssues).toContainEqual({ code: "EXT_MODEL", path: "cmr.pdf", message: "extraction failed: the answer was cut off at the model's output limit" });
    expect(readJson(join(outDir, "extraction.json")).documents.map((d: Doc) => d.sourceFile)).toEqual(["contract.pdf", "packing-list.pdf"]);
  });

  it("keeps the first answer when the correction is not JSON", async () => {
    const dir = "en-led-lighting/clean";
    const first = documentOf(changed(`${dir}/extraction.json`, "Kartli Retail LLC", "Kartli Wholesale LLC"), "invoice.pdf");
    const { model } = mockModel(fixture(`${dir}/extraction.json`), (_file, kind) => (kind === "extract" ? first : kind === "repair" ? "Sorry, the buyer is printed as I gave it." : undefined));
    const outDir = out();
    const run = await runCheck({ inputs: [join(FIXTURES, dir, "invoice.pdf")], outDir, model: () => model });
    expect(run.modelCalls).toBe(3);
    expect(run.result.extractionIssues).toEqual([]);
    expect(run.notes).toEqual(['invoice.pdf: page 1: 1 quote not found in the page text: documents[0].buyer.name "Kartli Wholesale LLC"']);
    expect(readFileSync(join(outDir, "extraction.json"), "utf8")).toContain("Kartli Wholesale LLC");
  });

  it("asks the model once more when the extraction has format problems", async () => {
    const good = fixture("en-led-lighting/clean/extraction.json");
    const invoice = JSON.parse(good).documents.find((d: Doc) => d.sourceFile === "invoice.pdf");
    const badInvoice = JSON.stringify(invoice).replace('"value":"15500.00"', '"value":"15,500.00"');
    expect(badInvoice).not.toBe(JSON.stringify(invoice));
    const { model, calls } = mockModel(good, (file, kind) => (file === "invoice.pdf" && kind === "extract" ? badInvoice : undefined));
    const run = await runCheck({ inputs: [join(FIXTURES, "en-led-lighting/clean")], outDir: out(), model: () => model });
    expect(run.modelCalls).toBe(9); // 4 classifications + 4 extractions + 1 repair (invoice only)
    expect(run.result.extractionIssues).toEqual([]);
    expect(run.result.findings).toEqual([]);
    const repair = calls.find((c) => c.prompt.includes("The checker found these problems"))!;
    expect(repair.prompt).toContain("File: invoice.pdf");
    expect(repair.prompt).toContain("is not a canonical decimal");
    // The model cannot open issues.md, so the row of the code comes with the problem.
    expect(repair.prompt).toContain('(EXT_DECIMAL_FORMAT): \\"15,500.00\\" is not a canonical decimal like 13300.00.');
    expect(repair.prompt).toContain("What each code means, and the fix:\\n- EXT_DECIMAL_FORMAT: a number that is not canonical (`13,300.00`, `1 880`, `15%`). Fix: `13300.00`.");
  });

  it("checks the other files when one model call fails, and names the failed file", async () => {
    const dir = "tr-ceramics/consignee-mismatch";
    const { model } = mockModel(fixture(`${dir}/extraction.json`), (file, kind) =>
      file === "invoice.pdf" && kind === "extract" ? new Error("Rate limit exceeded") : undefined,
    );
    const outDir = out();
    const run = await runCheck({ inputs: [join(FIXTURES, dir)], outDir, model: () => model });
    expect(run.complete).toBe(false);
    expect(run.result.ok).toBe(true);
    expect(run.result.summary.documents).toBe(3);
    expect(run.result.findings.map((f) => f.key)).toEqual(["DOC-01.missing"]); // the invoice is not there to check
    expect(run.result.extractionIssues).toContainEqual({ code: "EXT_MODEL", path: "invoice.pdf", message: "extraction failed: Rate limit exceeded" });
    expect(run.markdown).toContain("`invoice.pdf` (EXT_MODEL): extraction failed: Rate limit exceeded");
    expect(readJson(join(outDir, "extraction.json")).documents.map((d: Doc) => d.sourceFile)).toEqual(["cmr.pdf", "contract.pdf", "packing-list.pdf"]);
  });

  it("keeps the documents that parse when one still breaks the schema after the repair", async () => {
    const dir = "en-led-lighting/clean";
    const broken = JSON.stringify({ type: "commercial_invoice", lines: "none" });
    const { model } = mockModel(fixture(`${dir}/extraction.json`), (file, kind) => (file === "invoice.pdf" && kind !== "classify" ? broken : undefined));
    const outDir = out();
    const run = await runCheck({ inputs: [join(FIXTURES, dir)], outDir, model: () => model });
    expect(run.modelCalls).toBe(9);
    expect(run.complete).toBe(false);
    expect(run.result.summary.documents).toBe(3);
    const issue = run.result.extractionIssues.find((i) => i.path === "invoice.pdf")!;
    expect(issue.code).toBe("EXT_SHAPE");
    expect(issue.message).toContain("extraction.rejected.json");
    expect(readJson(join(outDir, "extraction.json")).documents).toHaveLength(3);
    const rejected = readJson(join(outDir, "extraction.rejected.json"));
    expect(rejected.documents).toEqual([{ ...JSON.parse(broken), sourceFile: "invoice.pdf" }]);
    expect(rejected.issues.length).toBeGreaterThan(0);
    expect(rejected.issues.every((i: { path: string }) => i.path.startsWith("documents[0]"))).toBe(true);
  });

  it("writes no empty extraction.json and reports unreadable when no document parses", async () => {
    const dir = "en-led-lighting/clean";
    const { model } = mockModel(fixture(`${dir}/extraction.json`), (_file, kind) => (kind !== "classify" ? "{}" : undefined));
    const outDir = out();
    const run = await runCheck({ inputs: [join(FIXTURES, dir)], outDir, model: () => model });
    expect(run.complete).toBe(false);
    expect(run.result.ok).toBe(false);
    expect(run.markdown).toContain("The extraction could not be read");
    expect(existsSync(join(outDir, "extraction.json"))).toBe(false);
    expect(readJson(join(outDir, "extraction.rejected.json")).documents).toHaveLength(4);
  });

  it("fails without writing anything when every model call fails", async () => {
    const { model } = mockModel(fixture("en-led-lighting/clean/extraction.json"), () => new Error("Invalid API key"));
    const outDir = out();
    await expect(runCheck({ inputs: [join(FIXTURES, "en-led-lighting/clean")], outDir, model: () => model })).rejects.toThrow(
      "No document could be read. classification failed: Invalid API key",
    );
    expect(readdirSync(outDir)).toEqual([]);
  });

  it("keeps at most 4 model calls in flight (or the given cap)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lh-cli-many-"));
    const invoice = JSON.parse(fixture("en-led-lighting/clean/extraction.json")).documents.find((d: Doc) => d.sourceFile === "invoice.pdf");
    const docs = Array.from({ length: 7 }, (_, i) => ({ ...invoice, sourceFile: `invoice-${i + 1}.pdf` }));
    for (const doc of docs) copyFileSync(join(FIXTURES, "en-led-lighting/clean/invoice.pdf"), join(dir, doc.sourceFile));
    const extraction = JSON.stringify({ schemaVersion: "1", documents: docs });

    const capped = mockModel(extraction, undefined, 15);
    const run = await runCheck({ inputs: [dir], outDir: out(), model: () => capped.model, annotate: false });
    expect(run.result.summary.documents).toBe(7);
    expect(capped.stats.maxInFlight).toBe(4);

    const two = mockModel(extraction, undefined, 15);
    await runCheck({ inputs: [dir], outDir: out(), model: () => two.model, annotate: false, concurrency: 2 });
    expect(two.stats.maxInFlight).toBe(2);
  });

  it("checks an existing extraction.json without a model and marks the PDFs next to it", async () => {
    const outDir = out();
    const run = await runCheck({ inputs: [join(FIXTURES, "tr-ceramics/consignee-mismatch/extraction.json")], outDir });
    expect(run.modelCalls).toBe(0);
    expect(run.result.findings.map((f) => f.key)).toEqual(["PTY-01.name"]);
    expect(existsSync(join(outDir, "cmr.marked.pdf"))).toBe(true);
  });

  it("still writes the reports when marking cannot run, and says why", async () => {
    const globals = globalThis as { Iterator?: unknown };
    const saved = globals.Iterator;
    delete globals.Iterator;
    try {
      const outDir = out();
      const run = await runCheck({ inputs: [join(FIXTURES, "tr-ceramics/consignee-mismatch/extraction.json")], outDir });
      expect(run.result.ok).toBe(true);
      expect(run.notes).toEqual([
        `marked PDFs skipped: marking needs Node.js 22 or newer (this is ${process.version})`,
        `quotes not checked in the PDFs: reading PDFs needs Node.js 22 or newer (this is ${process.version})`,
      ]);
      expect(readdirSync(outDir).sort()).toEqual(["report.html", "report.json", "report.md"]);
    } finally {
      globals.Iterator = saved;
    }
  });

  it("rejects two input files with one name", () => {
    const a = join(FIXTURES, "en-led-lighting/clean/invoice.pdf");
    const b = join(FIXTURES, "ru-textile/clean/invoice.pdf");
    expect(() => collectFiles([a, b])).toThrow(UsageError);
    expect(() => collectFiles([a, b])).toThrow(/Files share a name: .*invoice\.pdf and .*invoice\.pdf/);
    expect(collectFiles([a, a])).toHaveLength(1);
  });

  it("passes over the marked copies an earlier run left in a folder: they are not documents", async () => {
    const dir = copyFixture("ka-office-furniture/words-mismatch");
    copyFileSync(join(dir, "invoice.pdf"), join(dir, "invoice.marked.pdf"));
    copyFileSync(join(dir, "cmr.pdf"), join(dir, "CMR.Marked.PDF"));
    const passedOver: string[] = [];
    expect(collectFiles([dir], passedOver).map((f) => f.name)).toEqual(["cmr.pdf", "contract.pdf", "invoice.pdf", "packing-list.pdf"]);
    expect(passedOver).toEqual([join(dir, "CMR.Marked.PDF"), join(dir, "invoice.marked.pdf")]);
    // Named on its own, a file is read whatever its name: the user asked for it.
    expect(collectFiles([join(dir, "invoice.marked.pdf")]).map((f) => f.name)).toEqual(["invoice.marked.pdf"]);

    // A second run with --out set to the documents' folder reads the same four files as the first.
    const { model } = mockModel(fixture("ka-office-furniture/words-mismatch/extraction.json"));
    const log: string[] = [];
    const run = await runCheck({ inputs: [dir], outDir: dir, model: () => model, language: "ka", log: (line) => log.push(line) });
    expect(run.modelCalls).toBe(8);
    expect(run.result.summary.documents).toBe(4);
    expect(run.result.findings.map((f) => f.key)).toEqual(["AMT-01.mismatch"]);
    expect(log).toEqual(["Passed over 2 marked copies of an earlier run: CMR.Marked.PDF, invoice.marked.pdf", "Reading 4 file(s): cmr.pdf, contract.pdf, invoice.pdf, packing-list.pdf"]);

    const only = out();
    copyFileSync(join(dir, "invoice.pdf"), join(only, "invoice.marked.pdf"));
    const none = cli("check", only, "--out", join(only, "out"));
    expect(none.status).toBe(2);
    expect(none.stderr).toBe(
      `No PDF or image files (.pdf, .png, .jpg, .jpeg and .webp) in ${only}. The marked copy of an earlier run (invoice.marked.pdf) is not read as a document. To check an extraction you already have, give the extraction.json itself.\n`,
    );
  });

  it("parses --format strictly", () => {
    expect(parseFormats(" md, json ,md")).toEqual(["md", "json"]);
    expect(() => parseFormats("MD")).toThrow(UsageError);
    expect(() => parseFormats("md,pdf")).toThrow(UsageError);
    expect(() => parseFormats("")).toThrow(UsageError);
  });

  it("exits with 2 on usage errors, before any model call", () => {
    const run = (...args: string[]) => cli("check", ...args);
    const dupes = run(join(FIXTURES, "en-led-lighting/clean/invoice.pdf"), join(FIXTURES, "ru-textile/clean/invoice.pdf"));
    expect(dupes.status).toBe(2);
    expect(dupes.stderr).toContain("Files share a name");
    const format = run(join(FIXTURES, "en-led-lighting/clean/extraction.json"), "--format", "md,docx");
    expect(format.status).toBe(2);
    expect(format.stderr).toContain('got "docx"');
    expect(run(join(FIXTURES, "missing"), "--out", out()).status).toBe(2);
  });
});

describe("logisticshub check, from its help alone", () => {
  it("prints the help for check --help and check -h, and exits with 0", () => {
    const top = cli("--help");
    expect(top.status).toBe(0);
    for (const args of [["check", "--help"], ["check", "-h"], ["check", join(FIXTURES, "missing"), "--help"]]) {
      const help = cli(...args);
      expect(help.status, args.join(" ")).toBe(0);
      expect(help.stderr).toBe("");
      expect(help.stdout).toBe(top.stdout);
    }
  });

  it("names every option, the accepted inputs, the defaults and the exit codes in the help", () => {
    const help = cli("--help").stdout;
    for (const option of ["--lang", "--out", "--model", "--pdf-dir", "--format", "--no-annotate", "--help", "--version"]) expect(help, option).toContain(option);
    expect(help).toContain(".pdf, .png, .jpg, .jpeg and .webp");
    expect(help).toContain("default: ./logisticshub-report");
    expect(help).toContain("default: anthropic:claude-opus-5-5");
    expect(help).toContain("LOGISTICSHUB_MODEL");
    expect(help).toContain("default: the extraction.json's folder");
    for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"]) expect(help).toContain(key);
    expect(help).toMatch(/Exit codes:\n  0  .+\n(     .+\n)*  1  .+\n(     .+\n)*  2  .+\n/);
  });

  it("has a README that names what the help names: options, defaults, inputs, keys and exit codes", () => {
    const help = cli("--help").stdout;
    const readme = readFileSync(join(ROOT, "packages/cli/README.md"), "utf8");
    const options = [...new Set([...help.matchAll(/(?<![\w-])--?[a-z][a-z-]*/g)].map((m) => m[0]))];
    expect(options.sort()).toEqual(["--append", "--fetch-registry", "--format", "--help", "--json", "--lang", "--limit", "--model", "--no-annotate", "--out", "--pdf-dir", "--registration", "--registry", "--version", "-h", "-o", "-v"]);
    for (const option of options) expect(readme, option).toContain(`\`${option}`);
    for (const fact of [
      ".pdf`, `.png`, `.jpg`, `.jpeg` and `.webp`",
      "`./logisticshub-report`",
      "`anthropic:claude-opus-5-5`",
      "`LOGISTICSHUB_MODEL`",
      "the `extraction.json`'s folder",
      "the language of most documents, else `en`",
      "`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `OPENROUTER_API_KEY`",
      "the `<name>.marked.pdf` copies an earlier run left there",
      "- `0`: checked, with or without findings.",
      "- `1`: not checked in full, and the reports say why:",
      "- `2`: nothing was checked.",
    ]) {
      expect(readme, fact).toContain(fact);
      // The same fact in the help, which prints it without the code marks.
      expect(help.replace(/\s+/g, " "), fact).toContain(fact.replaceAll("`", "").replace(/^- (\d): /, "$1 ").replace(/[.:]$/, ""));
    }
  });

  it("prints its version for check --version", () => {
    const version = cli("check", "--version");
    expect(version.status).toBe(0);
    expect(version.stdout).toBe(cli("--version").stdout);
  });
});

describe("logisticshub hs", () => {
  it("finds Georgian HS entries in the CLI and Node skill without a model", () => {
    const args = ["hs", "საწერი მაგიდ", "--limit", "2", "--json"];
    const ours = cli(...args);
    expect(ours.status).toBe(0);
    expect(ours.stdout).toBe(skill(...args).stdout);
    expect(JSON.parse(ours.stdout)).toMatchObject({ edition: { publication: 0, laterAmendmentsVerified: false }, matches: [{ description: "საწერი მაგიდები" }, { description: "საწერი მაგიდები" }] });
    expect(cli("hs", "9403 30 110 00").stdout).toContain("94033011000 (national code) · საწერი მაგიდები");
    expect(cli("hs", "940330", "--limit", "0").status).toBe(2);
    expect(cli("--help").stdout).toContain("logisticshub hs");
  });
});

describe("logisticshub check extraction.json", () => {
  it.each(["en-led-lighting/clean", "en-led-lighting/line-arithmetic", "ka-office-furniture/scanned-cmr", "ru-textile/weight-mismatch"])(
    "%s: prints what the skill's script prints for the same extraction and folder",
    (dir) => {
      const file = join(FIXTURES, dir, "extraction.json");
      const outDir = out();
      const theirs = skill(file, "--out", outDir);
      const ours = cli("check", file, "--out", outDir);
      expect(ours.stdout).toBe(theirs.stdout);
      expect(ours.status).toBe(0);
      expect(theirs.status).toBe(0);
      expect(ours.stderr).toBe("");
    },
  );

  it("prints document text as printed, like the skill's script: Markdown escapes are for report.md only", () => {
    const dir = out();
    // A document number with Markdown characters in it, and a type the schema does not know.
    writeFileSync(join(dir, "extraction.json"), changed("en-led-lighting/line-arithmetic/extraction.json", "BL-INV-26-0412", "BL_INV_26*0412"));
    writeFileSync(join(dir, "shape.json"), changed("en-led-lighting/clean/extraction.json", '"type": "cmr"', '"type": "waybill"'));
    for (const [name, printed, status] of [["extraction.json", "invoice BL_INV_26*0412 (invoice.pdf), p. 1", 0], ["shape.json", "commercial_invoice, packing_list", 1]] as const) {
      const outDir = join(dir, `out-${name}`);
      const ours = cli("check", join(dir, name), "--out", outDir, "--no-annotate");
      expect(ours.status, name).toBe(status);
      expect(ours.stdout, name).toContain(printed);
      expect(ours.stdout.slice(0, ours.stdout.indexOf("\nFiles:\n")), name).not.toContain("\\");
      // report.md keeps the escapes, so no character of a document is read as Markdown there.
      expect(readFileSync(join(outDir, "report.md"), "utf8"), name).toContain(printed.replace(/[_*]/g, "\\$&"));
      const theirs = skill(join(dir, name), "--out", outDir, "--no-annotate");
      expect(ours.stdout, name).toBe(theirs.stdout);
    }
  });

  it("ends in the skill script's line and exit code 2 when the extraction cannot be read", () => {
    const dir = out();
    const broken = join(dir, "broken.json");
    writeFileSync(broken, '{\n  "schemaVersion": "2",\n  "documents": [\n}\n');
    const empty = join(dir, "empty.json");
    writeFileSync(empty, "");
    mkdirSync(join(dir, "folder.json"));
    const cases: [string, string][] = [
      [join(dir, "missing.json"), `Cannot read ${join(dir, "missing.json")}: no such file or folder (ENOENT).\n`],
      [broken, `Cannot read ${broken}: not valid JSON at line 4, column 1 (unexpected "}"). Fix the file and run the check again.\n`],
      [empty, `Cannot read ${empty}: the file is empty. Fix the file and run the check again.\n`],
      [join(dir, "folder.json"), `Cannot read ${join(dir, "folder.json")}: it is a folder, not a file (EISDIR).\n`],
    ];
    for (const [file, line] of cases) {
      const outDir = join(dir, "out");
      const ours = cli("check", file, "--out", outDir);
      expect(ours.stderr, file).toBe(line);
      expect(ours.status, file).toBe(2);
      expect(ours.stdout, file).toBe("");
      expect(existsSync(outDir), file).toBe(false);
      const theirs = skill(file, "--out", outDir);
      expect([ours.stderr, ours.status], file).toEqual([theirs.stderr, theirs.status]);
    }
  });

  it("reads an extraction saved with a byte order mark", () => {
    const dir = copyFixture("en-led-lighting/clean");
    writeFileSync(join(dir, "extraction.json"), `\uFEFF${fixture("en-led-lighting/clean/extraction.json")}`);
    const run = cli("check", join(dir, "extraction.json"), "--out", join(dir, "out"));
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
  });

  it("exits with 1 and writes the reports when the extraction is not usable", () => {
    const dir = out();
    writeFileSync(join(dir, "extraction.json"), fixture("en-led-lighting/clean/extraction.json").replace('"schemaVersion": "3"', '"schemaVersion": "1"'));
    const run = cli("check", join(dir, "extraction.json"), "--out", join(dir, "out"));
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('written for schema version "1"');
    expect(readdirSync(join(dir, "out")).sort()).toEqual(["report.html", "report.json", "report.md"]);
    const theirs = skill(join(dir, "extraction.json"), "--out", join(dir, "out"));
    expect([run.stdout, run.status]).toEqual([theirs.stdout, theirs.status]);
  });

  it("takes one extraction.json, alone", () => {
    const a = join(FIXTURES, "en-led-lighting/clean/extraction.json");
    const b = join(FIXTURES, "ru-textile/clean/extraction.json");
    const two = cli("check", a, b, "--out", out());
    expect(two.status).toBe(2);
    expect(two.stderr).toBe(
      `Give one extraction.json per run; got 2 (${a}, ${b}). Each extraction is one shipment: check them one at a time, each with its own --out.\n`,
    );
    const mixed = cli("check", a, join(FIXTURES, "en-led-lighting/clean/invoice.pdf"), "--out", out());
    expect(mixed.status).toBe(2);
    expect(mixed.stderr).toBe("An extraction.json is checked on its own; got 2 inputs. To mark the PDFs it cites, give their folder with --pdf-dir.\n");
  });

  it("finds the PDFs in --pdf-dir, and says so when they are not where it looks", () => {
    const pdfs = join(FIXTURES, "tr-ceramics/consignee-mismatch");
    const dir = out();
    copyFileSync(join(pdfs, "extraction.json"), join(dir, "extraction.json"));

    const alone = cli("check", join(dir, "extraction.json"), "--out", join(dir, "alone"));
    expect(alone.status).toBe(0);
    expect(alone.stdout).toContain("- cmr.pdf: not marked: file not found\n");
    expect(alone.stdout).toContain("- packing-list.pdf: quotes not checked: file not found\n");
    expect(existsSync(join(dir, "alone/cmr.marked.pdf"))).toBe(false);

    const withPdfs = cli("check", join(dir, "extraction.json"), "--out", join(dir, "with"), "--pdf-dir", pdfs);
    expect(withPdfs.status).toBe(0);
    expect(withPdfs.stdout).not.toContain("Notes:");
    expect(existsSync(join(dir, "with/cmr.marked.pdf"))).toBe(true);
    const theirs = skill(join(dir, "extraction.json"), "--out", join(dir, "with"), "--pdf-dir", pdfs);
    expect(withPdfs.stdout).toBe(theirs.stdout);
  });

  it("refuses --pdf-dir with document files, before any model call", () => {
    const run = cli("check", join(FIXTURES, "en-led-lighting/clean"), "--pdf-dir", join(FIXTURES, "en-led-lighting/clean"), "--out", out());
    expect(run.status).toBe(2);
    expect(run.stderr).toBe("--pdf-dir goes with an extraction.json: it names the folder of the PDFs the extraction cites. Document files given as inputs need no --pdf-dir.\n");
  });

  it("lists the quotes the PDFs do not print under Notes, as the skill's script does", () => {
    const dir = copyFixture("en-led-lighting/line-arithmetic");
    const wrong = JSON.parse(fixture("en-led-lighting/line-arithmetic/extraction.json"));
    const invoice = wrong.documents.find((d: Doc) => d.sourceFile === "invoice.pdf");
    invoice.buyer.name = { value: "Kartli Wholesale LLC", quote: "Kartli Wholesale LLC", page: 1 };
    invoice.number.page = 7;
    writeFileSync(join(dir, "extraction.json"), JSON.stringify(wrong));

    const ours = cli("check", join(dir, "extraction.json"), "--out", join(dir, "out"));
    expect(ours.status).toBe(0);
    const notes = ours.stdout.slice(ours.stdout.indexOf("Notes:\n"));
    expect(notes).toContain("- invoice.pdf: page 7 does not exist (1 page): documents[0].number\n");
    expect(notes).toContain('- invoice.pdf: page 1: 1 quote not found in the page text: documents[0].buyer.name "Kartli Wholesale LLC"\n');
    expect(ours.stdout).toBe(skill(join(dir, "extraction.json"), "--out", join(dir, "out")).stdout);

    const unread = cli("check", join(dir, "extraction.json"), "--out", join(dir, "unread"), "--no-annotate");
    expect(unread.status).toBe(0);
    expect(unread.stdout).not.toContain("Notes:");
    expect(readdirSync(join(dir, "unread")).sort()).toEqual(["report.html", "report.json", "report.md"]);
  });
});

describe("logisticshub check, output it cannot write", () => {
  it("names the folder, says what to do and exits with 2, like the skill's script", () => {
    const dir = out();
    writeFileSync(join(dir, "a-file"), "");
    const file = join(FIXTURES, "en-led-lighting/line-arithmetic/extraction.json");
    for (const outDir of [join(dir, "a-file"), join(dir, "a-file/reports")]) {
      const ours = cli("check", file, "--out", outDir);
      expect(ours.stderr).toBe(`Cannot write to ${outDir}: a file stands where a folder is needed (ENOTDIR). Give --out a folder that can be written to.\n`);
      expect(ours.status).toBe(2);
      expect(ours.stdout).toBe("");
    }
    const below = join(dir, "a-file/reports");
    const theirs = skill(file, "--out", below);
    expect(cli("check", file, "--out", below).stderr).toBe(theirs.stderr);
    expect(theirs.status).toBe(2);
  });

  it("names the file when one report cannot be written", () => {
    const dir = out();
    mkdirSync(join(dir, "report.json"));
    const run = cli("check", join(FIXTURES, "en-led-lighting/clean/extraction.json"), "--out", dir);
    expect(run.stderr).toBe(`Cannot write ${join(dir, "report.json")}: it is a folder, not a file (EISDIR). Give --out a folder that can be written to.\n`);
    expect(run.status).toBe(2);
  });

  it("finds out before any model call", async () => {
    const dir = out();
    writeFileSync(join(dir, "a-file"), "");
    const { model, calls } = mockModel(fixture("en-led-lighting/clean/extraction.json"));
    const run = runCheck({ inputs: [join(FIXTURES, "en-led-lighting/clean")], outDir: join(dir, "a-file/reports"), model: () => model });
    await expect(run).rejects.toThrow(OutputError);
    await expect(run).rejects.toThrow(`Cannot write to ${join(dir, "a-file/reports")}: a file stands where a folder is needed (ENOTDIR).`);
    expect(calls).toHaveLength(0);
    expect(readdirSync(dir)).toEqual(["a-file"]);
  });
});

describe("logisticshub check, inputs it cannot use", () => {
  it("names a file that is not a document, and a folder without documents", () => {
    const dir = out();
    writeFileSync(join(dir, "notes.docx"), "");
    const file = cli("check", join(dir, "notes.docx"), "--out", join(dir, "out"));
    expect(file.status).toBe(2);
    expect(file.stderr).toBe(`Cannot read ${join(dir, "notes.docx")}: not a PDF or an image. Give .pdf, .png, .jpg, .jpeg and .webp files, a folder of them, or one extraction.json.\n`);
    const folder = cli("check", dir, "--out", join(dir, "out"));
    expect(folder.status).toBe(2);
    expect(folder.stderr).toBe(
      `No PDF or image files (.pdf, .png, .jpg, .jpeg and .webp) in ${dir}. To check an extraction you already have, give the extraction.json itself.\n`,
    );
    const missing = cli("check", join(dir, "missing"), "--out", join(dir, "out"));
    expect(missing.status).toBe(2);
    expect(missing.stderr).toBe(`Cannot read ${join(dir, "missing")}: no such file or folder (ENOENT).\n`);
  });

  it("says which key to set, or how to go on without a model", () => {
    const run = cli("check", join(FIXTURES, "en-led-lighting/clean"), "--out", out());
    expect(run.status).toBe(2);
    expect(run.stderr).toBe("Set ANTHROPIC_API_KEY to extract with anthropic, or pass an extraction.json to check without a model.\n");
  });

  it("ends as 'nothing was checked' when every model call fails", async () => {
    const { model } = mockModel(fixture("en-led-lighting/clean/extraction.json"), () => new Error("Invalid API key"));
    const run = runCheck({ inputs: [join(FIXTURES, "en-led-lighting/clean")], outDir: out(), model: () => model });
    await expect(run).rejects.toThrow(NoDocumentError);
    await expect(run).rejects.toThrow(NothingChecked);
  });
});

describe("the model call", () => {
  const sectionsOf = (guide: string) => guide.split(/^(?=## )/m);
  /** Every `…` the model's guide names that is a file or a command of the skill's agent. */
  const agentOnly = [...new Set([...MODEL_GUIDE.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!.split(" ")[0]!))].filter(
    (name) => /^(scripts\/|pdfto)/.test(name) || /^extraction[\w-]*\.json$/.test(name) || /^[\w-]+\.md$/.test(name),
  );

  it("gives the model the guide without the sections only an agent can act on", () => {
    const all = sectionsOf(EXTRACTION_GUIDE);
    const kept = sectionsOf(MODEL_GUIDE);
    const left = all.filter((section) => AGENT_ONLY_SECTIONS.some((heading) => section.startsWith(`## ${heading}\n`)));
    // Both sections exist under these names: a renamed one would slip back into the prompt unseen.
    expect(left.map((section) => section.slice(3, section.indexOf("\n")))).toEqual(["Several documents, files and pages", "Before the check, and after it"]);
    expect(kept).toHaveLength(all.length - 2);
    // Every other section is the skill's own text, to the letter.
    expect(kept.join("").trimEnd()).toBe(all.filter((section) => !left.includes(section)).join("").trimEnd());
    // What only those sections spoke of: the script's notes, and putting files together.
    for (const gone of ["`Notes:`", "docs.pdf", "cmr-2.jpg", "open `issues.md`"]) {
      expect(EXTRACTION_GUIDE, gone).toContain(gone);
      expect(MODEL_GUIDE, gone).not.toContain(gone);
    }
  });

  it("tells the model what it cannot do: the guide's files, commands and user are not there", async () => {
    expect(agentOnly.sort()).toEqual(["declaration.md", "extraction-blank.json", "extraction-schema.json", "extraction.json", "issues.md", "pdftoppm", "pdftotext", "scripts/check.mjs"]);
    for (const name of agentOnly) expect(MODEL_INSTRUCTIONS, name).toContain(`\`${name}\``);
    // What the guide asks of an agent and a called model cannot do.
    for (const [inGuide, answered] of [
      ["tell the user", "Where the guide says to tell the user, apply the reading it gives and say nothing."],
      ["for the user", "no list to keep"],
      ["other documents in the set", "Where the guide looks at the issuer's other documents, you have none"],
      ["**A document that prints both conventions**", 'where the guide\'s point "A document that prints both conventions" applies, your value stays and so does the problem'],
    ] as const) {
      expect(MODEL_GUIDE, inGuide).toContain(inGuide);
      expect(MODEL_INSTRUCTIONS, inGuide).toContain(answered);
    }
    // The instructions cancel nothing that is no longer in the model's guide.
    for (const section of AGENT_ONLY_SECTIONS) expect(MODEL_INSTRUCTIONS).not.toContain(section);
    expect(MODEL_INSTRUCTIONS).not.toContain("`Notes:`");

    const { model, calls } = mockModel(fixture("en-led-lighting/clean/extraction.json"));
    await runCheck({ inputs: [join(FIXTURES, "en-led-lighting/clean/invoice.pdf")], outDir: out(), model: () => model });
    const extraction = calls.find((c) => !c.prompt.includes("Classify this file"))!;
    const system = (JSON.parse(extraction.prompt) as { role: string; content: string }[]).find((m) => m.role === "system")!.content;
    expect(system).toBe(`${MODEL_INSTRUCTIONS}\n\n${MODEL_GUIDE}`);
  });

  it("sends the correction call the row of issues.md for each code it has to correct", () => {
    // A row for every code of the file's first table, none lost to a cell the pattern cannot read.
    const codes = [...ISSUES_GUIDE.matchAll(/^\| `(EXT_[A-Z_]+)`/gm)].map((m) => m[1]!);
    expect(codes).toHaveLength(9);
    expect([...issueRows().keys()]).toEqual(codes);
    for (const row of issueRows().values()) expect(`${row.means} ${row.fix}`).not.toMatch(/table|\|/);

    const request = correctionRequest([
      { code: "EXT_QUOTE_MISMATCH", path: "documents[0].total", message: '"15000.00" does not match the quote "USD 15,500.00", which reads 15500.00.' },
      { code: "EXT_QUOTE_MISMATCH", path: "documents[0].subtotal", message: '"15000.00" does not match the quote "15,500.00", which reads 15500.00.' },
      { code: "EXT_UNCITED", path: "documents[0].date", message: "Value has no supporting quote." },
      { code: "EXT_SHAPE", path: "documents[0].lines", message: "Expected a list." },
      { path: "documents[0].buyer.name", message: 'the quote "Kartli Wholesale LLC" is not printed on page 1 of the file.' },
    ]);
    expect(request).toBe(
      [
        "The checker found these problems. Correct them against the document, change nothing else, and return the full corrected JSON.",
        '- documents[0].total (EXT_QUOTE_MISMATCH): "15000.00" does not match the quote "USD 15,500.00", which reads 15500.00.',
        '- documents[0].subtotal (EXT_QUOTE_MISMATCH): "15000.00" does not match the quote "15,500.00", which reads 15500.00.',
        "- documents[0].date (EXT_UNCITED): Value has no supporting quote.",
        "- documents[0].lines (EXT_SHAPE): Expected a list.",
        '- documents[0].buyer.name: the quote "Kartli Wholesale LLC" is not printed on page 1 of the file.',
        "",
        "What each code means, and the fix:",
        "- EXT_QUOTE_MISMATCH: the value is not what its own quote reads; the message gives the reading. Fix: read the quote in the document again; correct the value, or the quote if you cited the wrong text.",
        "- EXT_UNCITED: a value without a quote. Fix: add the quote and page, or make the fact null.",
      ].join("\n"),
    );
    // A quote the PDF does not print has no code: its line says all there is to say.
    expect(correctionRequest([{ path: "documents[0].number", message: "page 7 does not exist, the file has 1 page." }])).not.toContain("What each code means");
  });

  it("sends a quote the PDF does not print back to the model, once", async () => {
    const dir = "en-led-lighting/clean";
    const good = fixture(`${dir}/extraction.json`);
    const wrong = documentOf(changed(`${dir}/extraction.json`, "Kartli Retail LLC", "Kartli Wholesale LLC"), "invoice.pdf");
    const { model, calls } = mockModel(good, (file, kind) => (file === "invoice.pdf" && kind === "extract" ? wrong : undefined));
    const outDir = out();
    const run = await runCheck({ inputs: [join(FIXTURES, dir)], outDir, model: () => model });
    expect(run.modelCalls).toBe(9); // 4 classifications + 4 extractions + 1 repair (invoice only)
    const repair = calls.filter((c) => c.prompt.includes("The checker found these problems"));
    expect(repair).toHaveLength(1);
    expect(repair[0]!.prompt).toContain("File: invoice.pdf");
    expect(repair[0]!.prompt).toContain('documents[0].buyer.name: the quote \\"Kartli Wholesale LLC\\" is not printed on page 1 of the file.');
    expect(run.notes).toEqual([]);
    expect(run.result.findings).toEqual([]);
    expect(fixture(`${dir}/extraction.json`)).toContain("Kartli Retail LLC");
    expect(readFileSync(join(outDir, "extraction.json"), "utf8")).not.toContain("Wholesale");
  });

  it("tells the model when a page does not exist", async () => {
    const dir = "en-led-lighting/clean";
    const invoice = JSON.parse(documentOf(fixture(`${dir}/extraction.json`), "invoice.pdf"));
    invoice.number.page = 7;
    const { model, calls } = mockModel(fixture(`${dir}/extraction.json`), (file, kind) => (file === "invoice.pdf" && kind === "extract" ? JSON.stringify(invoice) : undefined));
    const run = await runCheck({ inputs: [join(FIXTURES, dir, "invoice.pdf")], outDir: out(), model: () => model });
    const repair = calls.find((c) => c.prompt.includes("The checker found these problems"))!;
    expect(repair.prompt).toContain("documents[0].number: page 7 does not exist, the file has 1 page. Give the page the quote is printed on, counted from 1.");
    expect(run.notes).toEqual([]);
  });

  it("keeps the first answer when the correction leaves more to correct, and lists what is left under Notes", async () => {
    const dir = "en-led-lighting/clean";
    const first = documentOf(changed(`${dir}/extraction.json`, "Kartli Retail LLC", "Kartli Wholesale LLC"), "invoice.pdf");
    const worse = first.replaceAll("Baltic Lumen OÜ", "Baltic Lantern OÜ");
    expect(worse).not.toBe(first);
    const { model } = mockModel(fixture(`${dir}/extraction.json`), (file, kind) => (file !== "invoice.pdf" ? undefined : kind === "extract" ? first : kind === "repair" ? worse : undefined));
    const outDir = out();
    const run = await runCheck({ inputs: [join(FIXTURES, dir, "invoice.pdf")], outDir, model: () => model });
    expect(run.modelCalls).toBe(3);
    expect(run.notes).toEqual(['invoice.pdf: page 1: 1 quote not found in the page text: documents[0].buyer.name "Kartli Wholesale LLC"']);
    expect(readFileSync(join(outDir, "extraction.json"), "utf8")).not.toContain("Lantern");
  });

  it("does not look the quotes up when the PDFs are not to be read", async () => {
    const dir = "en-led-lighting/clean";
    const wrong = documentOf(changed(`${dir}/extraction.json`, "Kartli Retail LLC", "Kartli Wholesale LLC"), "invoice.pdf");
    const { model } = mockModel(fixture(`${dir}/extraction.json`), (file, kind) => (file === "invoice.pdf" && kind === "extract" ? wrong : undefined));
    const run = await runCheck({ inputs: [join(FIXTURES, dir, "invoice.pdf")], outDir: out(), model: () => model, annotate: false });
    expect(run.modelCalls).toBe(2);
    expect(run.notes).toEqual([]);
  });
});

describe("models", () => {
  it("parses provider:model and defaults to anthropic", () => {
    expect(parseModelId("anthropic:claude-opus-5-5")).toEqual({ provider: "anthropic", model: "claude-opus-5-5" });
    expect(parseModelId("claude-sonnet-5-5")).toEqual({ provider: "anthropic", model: "claude-sonnet-5-5" });
    expect(parseModelId("openrouter:google/gemini-3-pro")).toEqual({ provider: "openrouter", model: "google/gemini-3-pro" });
    expect(() => parseModelId("bard:x")).toThrow(ModelConfigError);
    expect(() => parseModelId("constructor:x")).toThrow(ModelConfigError);
    expect(() => parseModelId("toString:x")).toThrow(/Unknown model "toString:x"/);
    expect(() => parseModelId("openai:")).toThrow(ModelConfigError);
  });

  it("explains a missing key", () => {
    expect(() => resolveModel("anthropic:claude-opus-5-5", {})).toThrow(/ANTHROPIC_API_KEY/);
  });
});

describe("registry commands", () => {
  it("uses a saved snapshot, fetches a new one and prints a single reply on both Node entry points", () => {
    // Intercept every request in the child, including unexpected ones.
    const fake = `globalThis.fetch = async (url, request) => {
      if (url !== "https://xdata.rs.ge/TaxPayer/RSPublicInfo" || request.body !== '{"IdentCode":"910000001"}') {
        process.stderr.write("Unexpected request");
        throw new Error("Unexpected request");
      }
      return Response.json({ Status: -100, Message: "System error" });
    };`;
    const dir = out();
    const stored = join(FIXTURES, "ka-office-furniture/registry-name-mismatch");
    const input = join(stored, "extraction.json");
    const modified = JSON.parse(readFileSync(input, "utf8"));
    for (const doc of modified.documents) {
      const party = doc.buyer ?? doc.consignee;
      if (party) party.taxId = { value: "910000001", quote: "910000001", page: 1 };
    }
    modified.documents[2].carrier.taxId = { value: "91000000001", quote: "91000000001", page: 1 };
    const onlineInput = join(dir, "extraction.json");
    writeFileSync(onlineInput, JSON.stringify(modified));

    for (const script of [MAIN, SKILL_SCRIPT]) {
      const run = (...args: string[]) => spawnSync(process.execPath, ["--import", "data:text/javascript," + encodeURIComponent(fake), script, ...args], { encoding: "utf8" });
      const check = (...args: string[]) => run(...(script === MAIN ? ["check"] : []), ...args, "--no-annotate", "--lang", "en", "--out", dir);
      const result = check(input, "--registry", join(stored, "registry.json"));
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("TAX-01");
      const fresh = check(onlineInput, "--fetch-registry");
      expect(fresh.status).toBe(0);
      expect(fresh.stderr).toBe("Skipped an 11-digit personal number.\n");
      expect(fresh.stdout).toContain("Could not be checked");
      expect(fresh.stdout).toContain("System error");
      expect(JSON.parse(readFileSync(join(dir, "report.json"), "utf8")).findings).toEqual([]);
      const dest = join(dir, "standalone-registry.json");
      expect(run("registry", onlineInput, "-o", dest).status).toBe(0);
      expect(JSON.parse(readFileSync(dest, "utf8")).entries).toMatchObject([{ code: "910000001", error: { Status: -100, Message: "System error" } }]);
      const single = run("taxpayer", "910000001");
      expect(single).toMatchObject({ status: 0, stderr: "" });
      expect(single.stdout).toContain("Could not be checked.\n-100: System error");
      expect(JSON.parse(run("taxpayer", "910000001", "--json").stdout).error).toEqual({ Status: -100, Message: "System error" });
      expect(run("taxpayer", "91000000001")).toMatchObject({ status: 2, stderr: "Skipped lookup: an 11-digit personal number is never sent.\n" });
    }
  });
});

describe("MCP server", () => {
  async function connect() {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createServer("test").connect(serverSide);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(clientSide);
    return client;
  }
  const text = (result: unknown) => JSON.stringify((result as { content?: unknown }).content);
  type Structured = {
    ok: boolean;
    language: string;
    summary: { documents: number; errors: number; warnings: number };
    extractionIssues: { code: string; path: string; message: string }[];
    findings: { rule: string; severity: string; key: string; params: Record<string, string>; message: string; check: string; units: Record<string, string>; evidence: Record<string, unknown>[] }[];
    files: string[];
    notes: string[];
  };
  const structured = (result: unknown) => (result as { structuredContent: Structured }).structuredContent;
  const parts = (result: unknown) => (result as { content: { type: string; text: string }[] }).content.map((part) => part.text);
  /** issues.md as a result carries it: after the report, with how its words map to this server. */
  const ISSUES_PART = `${ISSUES_PREFACE}\n\n${ISSUES_GUIDE}`;

  it("serves the guide and checks an extraction in memory", async () => {
    const client = await connect();
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(["check_documents", "get_extraction_guide", "lookup_hs_code", "lookup_taxpayer"]);

    const guide = await client.callTool({ name: "get_extraction_guide", arguments: {} });
    expect(JSON.stringify(guide.content)).toContain("Extraction guide");

    const leftovers = () => readdirSync(tmpdir()).filter((name) => name.startsWith("logisticshub-")).length;
    const before = leftovers();
    const extraction = JSON.parse(fixture("ru-textile/weight-mismatch/extraction.json"));
    const result = await client.callTool({ name: "check_documents", arguments: { extraction, language: "ru" } });
    expect(text(result)).toContain("Вес брутто различается: в упаковочном листе 2\u00a0496 кг, в CMR 2\u00a0946 кг.");
    expect(text(result)).not.toContain("Files:");
    expect(structured(result).findings.map((f) => f.key)).toEqual(["WGT-02.gross"]);
    expect(structured(result).files).toEqual([]);
    expect(leftovers()).toBe(before);
    // Nothing to correct, so nothing more to read: the report is the whole text.
    expect(parts(result)).toHaveLength(1);
    await client.close();
  });

  it("returns a live reply and checks a saved snapshot offline", async () => {
    const client = await connect();
    const fetch = vi.fn(async () => Response.json({ Status: -100, Message: "System error" }));
    vi.stubGlobal("fetch", fetch);
    try {
      const live = await client.callTool({ name: "lookup_taxpayer", arguments: { code: "910000001" } });
      expect(live.structuredContent).toMatchObject({ code: "910000001", error: { Status: -100, Message: "System error" } });
      expect(text(live)).toContain("Could not be checked");
      const personal = await client.callTool({ name: "lookup_taxpayer", arguments: { code: "91000000001" } });
      expect(personal.isError).toBe(true);
      expect(text(personal)).toContain("personal number");
      const dir = join(FIXTURES, "ka-office-furniture/registry-status-minus-one");
      const extraction = JSON.parse(readFileSync(join(dir, "extraction.json"), "utf8"));
      const saved = await client.callTool({ name: "check_documents", arguments: { extraction, registryFile: join(dir, "registry.json") } });
      expect(saved.structuredContent).toHaveProperty("registry");
      expect(structured(saved).findings.map(({ key }) => key)).toEqual(["TAX-03.reply"]);
      const invalid = await client.callTool({ name: "check_documents", arguments: { extraction, registryFile: join(dir, "extraction.json") } });
      expect(invalid.isError).toBe(true);
      expect(text(invalid)).toContain("Invalid registry snapshot");
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
      await client.close();
    }
  });

  it("tells the client what it is for and in which order to call its tools", async () => {
    const client = await connect();
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toBe(SERVER_INSTRUCTIONS);
    expect(instructions).toContain(`${RULE_IDS.length} deterministic rules`);
    const order = ["Call get_extraction_guide", "Read every page of every document", "Call check_documents", "correct the extraction", "not as a verdict"].map((step) => instructions.indexOf(step));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // What the skill's description says: one invoice can be checked on its own; paying and booking are not its job.
    const description = /^description: (.+)$/m.exec(readFileSync(join(ROOT, "packages/skill/SKILL.md"), "utf8"))![1]!;
    expect(description).toContain("Check invoice sums and words");
    expect(instructions).toContain("an invoice on its own gets its line totals, its sums and its amount in words checked");
    expect(description).toContain("Not for paying or booking.");
    expect(instructions).toContain("Not for paying or booking an invoice.");
    expect(instructions).not.toContain("single invoice");
    expect(description).toContain("look up Georgian HS codes");
    expect(instructions).toContain("Use lookup_hs_code");
    await client.close();
  });

  it("gives the guide with what the skill keeps in files: the schema and the blank", async () => {
    const client = await connect();
    const guide = await client.callTool({ name: "get_extraction_guide", arguments: {} });
    const texts = parts(guide);
    expect(texts).toHaveLength(4);
    // Every file or script the guide names is either served here or mapped to a tool.
    const named = [...new Set([...EXTRACTION_GUIDE.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!.split(" ")[0]!))].filter((name) => /^scripts\/|^[\w-]+\.(json|md)$/.test(name));
    expect(named.sort()).toEqual(["declaration.md", "extraction-blank.json", "extraction-schema.json", "extraction.json", "issues.md", "scripts/check.mjs"]);
    for (const name of [...named.filter((n) => n !== "extraction.json"), "Notes:"]) expect(texts[0], name).toContain(name);
    expect(texts[1]).toBe(EXTRACTION_GUIDE);
    const withDeclaration = await client.callTool({ name: "get_extraction_guide", arguments: { includeDeclaration: true } });
    expect(parts(withDeclaration)).toContain(DECLARATION_GUIDE);
    expect(JSON.parse(texts[2]!.slice(texts[2]!.indexOf("{")))).toEqual(extractionJsonSchema());
    expect(JSON.parse(texts[3]!.slice(texts[3]!.indexOf("{")))).toEqual(extractionBlank());
    await client.close();
  });

  it("sends issues.md with a result that lists an extraction issue or a note, and with no other", async () => {
    const client = await connect();
    const clean = JSON.parse(fixture("en-led-lighting/clean/extraction.json"));
    expect(parts(await client.callTool({ name: "check_documents", arguments: { extraction: clean } }))).toHaveLength(1);
    const planted = await client.callTool({ name: "check_documents", arguments: { extraction: JSON.parse(fixture("en-led-lighting/line-arithmetic/extraction.json")) } });
    expect(parts(planted)).toHaveLength(1);

    // An extraction issue: the fixture whose packing list prints numbers in two conventions.
    const mixed = await client.callTool({ name: "check_documents", arguments: { extraction: JSON.parse(fixture("en-led-lighting/mixed-number-conventions/extraction.json")) } });
    expect(mixed.isError).toBe(false);
    expect(structured(mixed).extractionIssues.map((i) => i.code)).toEqual(["EXT_QUOTE_MISMATCH"]);
    expect(parts(mixed)).toHaveLength(2);
    expect(parts(mixed)[1]).toBe(ISSUES_PART);
    expect(parts(mixed)[1]).toContain("One issue is not yours to fix");

    // An extraction that is not usable.
    const old = JSON.parse(fixture("en-led-lighting/clean/extraction.json").replace('"schemaVersion": "3"', '"schemaVersion": "1"'));
    const unusable = await client.callTool({ name: "check_documents", arguments: { extraction: old } });
    expect(unusable.isError).toBe(true);
    expect(parts(unusable)[1]).toBe(ISSUES_PART);

    // A note and no issue: a quote the PDF does not print.
    const wrong = JSON.parse(changed("en-led-lighting/clean/extraction.json", "Kartli Retail LLC", "Kartli Wholesale LLC"));
    const noted = await client.callTool({ name: "check_documents", arguments: { extraction: wrong, pdfDir: join(FIXTURES, "en-led-lighting/clean") } });
    expect(structured(noted).extractionIssues).toEqual([]);
    expect(structured(noted).notes.length).toBeGreaterThan(0);
    expect(parts(noted)[1]).toBe(ISSUES_PART);

    // The preface maps every word of the file that means something else here.
    for (const name of ["extraction.json", "--pdf-dir", "the script prints", "Run again", "xit code"]) {
      expect(ISSUES_GUIDE, name).toContain(name);
      expect(ISSUES_PREFACE, name).toContain(name);
    }
    await client.close();
  });

  it("gives the report as the skill's script prints it: document text without Markdown escapes", async () => {
    const client = await connect();
    const extraction = JSON.parse(changed("en-led-lighting/line-arithmetic/extraction.json", "BL-INV-26-0412", "BL_INV_26*0412"));
    const result = await client.callTool({ name: "check_documents", arguments: { extraction } });
    expect(parts(result)[0]).toContain("invoice BL_INV_26*0412 (invoice.pdf), p. 1 · line 2, quantity: “1,500”");
    expect(parts(result)[0]).not.toContain("\\");
    await client.close();
  });

  it("reads an extraction passed as a string of JSON, and says what to pass when the string is not that", async () => {
    const client = await connect();
    const json = fixture("ru-textile/weight-mismatch/extraction.json");
    const asObject = await client.callTool({ name: "check_documents", arguments: { extraction: JSON.parse(json), language: "ru" } });
    const asString = await client.callTool({ name: "check_documents", arguments: { extraction: json, language: "ru" } });
    expect(asString.isError).toBe(false);
    expect(asString).toEqual(asObject);
    expect(structured(asString).findings.map((f) => f.key)).toEqual(["WGT-02.gross"]);

    const what = 'extraction must be the extraction object itself: { "schemaVersion": …, "documents": [ … ] }, as get_extraction_guide describes it. A string is read only when it is that object as JSON.';
    for (const [extraction, said] of [
      ['{ "schemaVersion": "2", "documents": [', `${what} The string you passed is not valid JSON: it ends too early at line 1, column 39. Nothing was checked.`],
      ["see the attached extraction", `${what} The string you passed is not valid JSON at line 1, column 1 (unexpected "s"). Nothing was checked.`],
      ["", `${what} The string you passed is empty. Nothing was checked.`],
    ] as const) {
      const refused = await client.callTool({ name: "check_documents", arguments: { extraction } });
      expect(refused.isError, extraction).toBe(true);
      expect(parts(refused), extraction).toEqual([said]);
      expect(refused.structuredContent, extraction).toBeUndefined();
    }
    // Any other JSON value (a list, a number, a quoted text) gets the same sentence.
    for (const extraction of ["[1, 2]", '"text"', 5, null, [1]]) {
      const refused = await client.callTool({ name: "check_documents", arguments: { extraction } as never });
      expect(refused.isError, String(extraction)).toBe(true);
      expect(text(refused), String(extraction)).toContain("extraction must be the extraction object itself");
    }
    // The listed schema still asks for the object: a string is forgiven, not invited.
    const tool = (await client.listTools()).tools.find((t) => t.name === "check_documents")!;
    expect((tool.inputSchema.properties as Record<string, { type?: string; description?: string }>).extraction).toMatchObject({
      type: "object",
      description: "The extraction object, as described by get_extraction_guide. Pass the object itself, not a string of JSON.",
    });
    await client.close();
  });

  it("describes its structured result with an output schema, and keeps to it", async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find((t) => t.name === "check_documents")!;
    const schema = tool.outputSchema as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(schema.properties).sort()).toEqual(["extractionIssues", "files", "findings", "language", "notes", "ok", "registry", "summary"]);
    expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).filter((key) => key !== "registry").sort());

    // The client checks every structured result against the schema it was given, and throws when one breaks it.
    const planted = await client.callTool({ name: "check_documents", arguments: { extraction: JSON.parse(fixture("en-led-lighting/line-arithmetic/extraction.json")) } });
    expect(planted.isError).toBe(false);
    const result = structured(planted);
    expect(Object.keys(result).sort()).toEqual([...schema.required].sort());
    expect(result).toMatchObject({ ok: true, language: "en", summary: { documents: 4, errors: 2, warnings: 0 }, extractionIssues: [], files: [], notes: [] });
    expect(result.findings[0]).toEqual({
      rule: "SUM-01",
      severity: "error",
      key: "SUM-01.line",
      params: { line: "2", quantity: "1500", unitPrice: "2.90", expected: "4350.00", found: "4530.00" },
      message: "Line 2: 1,500 × 2.90 = 4,350.00 USD, but the line total is 4,530.00 USD.",
      check: "Recalculate this line of the invoice: the quantity, the unit price or the line total is wrong.",
      // The currency the message prints after each amount of money; params stay bare decimals.
      units: { expected: "USD", found: "USD" },
      // Each piece of evidence says which field it is, as the report does.
      evidence: [
        { document: "invoice", sourceFile: "invoice.pdf", page: 1, path: "lines[1].quantity", label: "line 2, quantity", quote: "1,500", value: "1500" },
        { document: "invoice", sourceFile: "invoice.pdf", page: 1, path: "lines[1].unitPrice", label: "line 2, unit price", quote: "2.90", value: "2.90" },
        { document: "invoice", sourceFile: "invoice.pdf", page: 1, path: "lines[1].lineTotal", label: "line 2, total", quote: "4,530.00", value: "4530.00" },
      ],
    });
    // A finding without money has no units, and a sum the checker worked out has no label; in Georgian the labels are Georgian.
    const weights = structured(await client.callTool({ name: "check_documents", arguments: { extraction: JSON.parse(fixture("ka-office-furniture/scanned-cmr/extraction.json")), language: "ka" } }));
    expect(weights.findings[0]).toMatchObject({ key: "WGT-02.gross", units: {} });
    expect(weights.findings[0]!.evidence.map((e) => e.label)).toEqual(["საერთო ბრუტო წონა", "საერთო ბრუტო წონა"]);
    const noTotal = JSON.parse(fixture("ru-textile/weight-mismatch/extraction.json"));
    noTotal.documents.find((d: Doc) => d.type === "packing_list").totalGrossWeightKg = { value: null, quote: null, page: null };
    const summed = structured(await client.callTool({ name: "check_documents", arguments: { extraction: noTotal, language: "en" } }));
    expect(summed.findings[0]!.evidence.map((e) => [e.path, e.label, e.quote])).toEqual([
      ["lines[*]", null, null],
      ["totalGrossWeightKg", "total gross weight", "2 946"],
    ]);

    const old = JSON.parse(fixture("en-led-lighting/clean/extraction.json").replace('"schemaVersion": "3"', '"schemaVersion": "1"'));
    const unusable = await client.callTool({ name: "check_documents", arguments: { extraction: old } });
    expect(unusable.isError).toBe(true);
    expect(structured(unusable)).toMatchObject({ ok: false, findings: [], summary: { documents: 0 } });
    expect(structured(unusable).extractionIssues[0]!.message).toContain('written for schema version "1"');
    await client.close();
  });

  it("writes reports and marked PDFs to an absolute outDir and lists them", async () => {
    const client = await connect();
    const dir = join(FIXTURES, "tr-ceramics/consignee-mismatch");
    const outDir = out();
    const result = await client.callTool({
      name: "check_documents",
      arguments: { extraction: JSON.parse(fixture("tr-ceramics/consignee-mismatch/extraction.json")), outDir, pdfDir: dir },
    });
    expect(result.isError).toBe(false);
    expect(text(result)).toContain(join(outDir, "cmr.marked.pdf"));
    expect(existsSync(join(outDir, "cmr.marked.pdf"))).toBe(true);
    expect(existsSync(join(outDir, "report.html"))).toBe(true);
    expect(structured(result).files).toContain(join(outDir, "cmr.marked.pdf"));
    expect(structured(result).notes).toEqual([]);
    await client.close();
  });

  it("looks the quotes up in pdfDir and returns what it did not find as notes", async () => {
    const client = await connect();
    const extraction = JSON.parse(changed("en-led-lighting/clean/extraction.json", "Kartli Retail LLC", "Kartli Wholesale LLC"));
    const result = await client.callTool({ name: "check_documents", arguments: { extraction, outDir: out(), pdfDir: join(FIXTURES, "en-led-lighting/clean") } });
    expect(result.isError).toBe(false);
    expect(structured(result).notes).toHaveLength(4);
    expect(structured(result).notes[0]).toBe('invoice.pdf: page 1: 1 quote not found in the page text: documents[0].buyer.name "Kartli Wholesale LLC"');
    expect(text(result)).toContain("Notes:\\n- invoice.pdf: page 1: 1 quote not found in the page text");
    await client.close();
  });

  it("refuses relative paths", async () => {
    const client = await connect();
    const extraction = JSON.parse(fixture("ru-textile/weight-mismatch/extraction.json"));
    const relative = await client.callTool({ name: "check_documents", arguments: { extraction, outDir: "reports" } });
    expect(relative.isError).toBe(true);
    expect(text(relative)).toContain("outDir must be an absolute path");
    const relativePdf = await client.callTool({ name: "check_documents", arguments: { extraction, outDir: out(), pdfDir: "./docs" } });
    expect(text(relativePdf)).toContain("pdfDir must be an absolute path");
    await client.close();
  });

  it("looks the quotes up with pdfDir alone, and writes nothing without outDir", async () => {
    const client = await connect();
    const leftovers = () => readdirSync(tmpdir()).filter((name) => name.startsWith("logisticshub-")).length;
    const before = leftovers();
    const pdfDir = copyFixture("en-led-lighting/line-arithmetic");
    const inFolder = readdirSync(pdfDir).sort();
    const wrong = JSON.parse(changed("en-led-lighting/line-arithmetic/extraction.json", "Kartli Retail LLC", "Kartli Wholesale LLC"));
    const result = await client.callTool({ name: "check_documents", arguments: { extraction: wrong, pdfDir } });
    expect(result.isError).toBe(false);
    // The findings come back, the wrong quotes are found, and no file is written: no report, no marked copy.
    expect(structured(result).findings.map((f) => f.key)).toEqual(["SUM-01.line", "SUM-02.subtotal"]);
    expect(structured(result).notes[0]).toBe('invoice.pdf: page 1: 1 quote not found in the page text: documents[0].buyer.name "Kartli Wholesale LLC"');
    expect(structured(result).files).toEqual([]);
    expect(parts(result)[0]).not.toContain("Files:");
    expect(readdirSync(pdfDir).sort()).toEqual(inFolder);
    expect(leftovers()).toBe(before);

    // The right extraction: every quote is found, so no note, though nothing was marked.
    const right = await client.callTool({ name: "check_documents", arguments: { extraction: JSON.parse(fixture("en-led-lighting/line-arithmetic/extraction.json")), pdfDir } });
    expect(structured(right).notes).toEqual([]);
    expect(structured(right).files).toEqual([]);
    await client.close();
  });

  it("returns an outDir it cannot write to as an error that names the folder, and checks nothing", async () => {
    const client = await connect();
    const dir = out();
    writeFileSync(join(dir, "a-file"), "");
    const outDir = join(dir, "a-file/reports");
    const result = await client.callTool({ name: "check_documents", arguments: { extraction: JSON.parse(fixture("ru-textile/weight-mismatch/extraction.json")), outDir } });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]!.text).toBe(
      `Cannot write to ${outDir}: a file stands where a folder is needed (ENOTDIR). Nothing was checked. Give outDir a folder that can be written to, or leave it out to get the report inline.`,
    );
    expect(result.structuredContent).toBeUndefined();
    await client.close();
  });

  it("works as a process over stdio: instructions, all three tools, a check, a string of JSON, pdfDir alone and the refusals", async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [MAIN, "mcp"], stderr: "pipe" });
    const client = new Client({ name: "test", version: "1" });
    await client.connect(transport);
    try {
      expect(client.getServerVersion()).toMatchObject({ name: "logisticshub" });
      expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
      expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(["check_documents", "get_extraction_guide", "lookup_hs_code", "lookup_taxpayer"]);
      for (const [query, matches] of [["9403 30", [{ code: "940330", level: "subheading" }]], ["999999", []]] as const) {
        const result = await client.callTool({ name: "lookup_hs_code", arguments: { query, limit: 1 } });
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toMatchObject({
          edition: { documentId: 6086072, publication: 0, laterAmendmentsVerified: false },
          sourceUrl: "https://matsne.gov.ge/ka/document/download/6086072/0/1",
          matches,
        });
      }
      const extraction = JSON.parse(fixture("ru-textile/weight-mismatch/extraction.json"));
      const checked = await client.callTool({ name: "check_documents", arguments: { extraction } });
      expect(structured(checked).findings.map((f) => f.key)).toEqual(["WGT-02.gross"]);
      // The two calls that used to cost a client a round: the extraction as a string of JSON, and pdfDir without outDir.
      const asString = await client.callTool({ name: "check_documents", arguments: { extraction: fixture("ru-textile/weight-mismatch/extraction.json") } });
      expect(asString.isError).toBe(false);
      expect(structured(asString)).toEqual(structured(checked));
      const lookedUp = await client.callTool({ name: "check_documents", arguments: { extraction, pdfDir: join(FIXTURES, "ru-textile/weight-mismatch") } });
      expect(lookedUp.isError).toBe(false);
      expect(structured(lookedUp)).toMatchObject({ files: [], notes: [] });
      expect(structured(lookedUp).findings).toEqual(structured(checked).findings);
      const refusals = [
        [{ extraction, outDir: "reports" }, "outDir must be an absolute path"],
        [{ extraction, outDir: out(), pdfDir: "./docs" }, "pdfDir must be an absolute path"],
        [{ extraction: "{ not json" }, "The string you passed is not valid JSON at line 1, column 3"],
      ] as const;
      for (const [args, message] of refusals) {
        const refused = await client.callTool({ name: "check_documents", arguments: args });
        expect(refused.isError, message).toBe(true);
        expect(text(refused)).toContain(message);
      }
    } finally {
      await client.close();
    }
  });
});
