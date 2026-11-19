/**
 * check.mjs: run the Logisticshub rules on an extraction and write reports.
 *
 *   node check.mjs extraction.json [--lang en|ka|ru|tr] [--out dir] [--format md,json,html]
 *                  [--pdf-dir dir] [--no-annotate]
 *   node check.mjs --schema        # print the extraction JSON Schema
 *
 * Exit codes:
 *   0  checked, with or without findings;
 *   1  the extraction is not usable (wrong shape, another schema version):
 *      the reports are written and list what to fix;
 *   2  nothing was checked: a bad option, a file that cannot be read or is
 *      not JSON, or reports that cannot be written. One line on stderr says
 *      which, and no report is written.
 *
 * Reading the PDFs never changes the exit code: what could not be marked, and
 * every quote that is not printed where the extraction says, is listed under
 * "Notes:" with the reason:
 *
 *   marked PDFs skipped: <why>            quotes not checked in the PDFs: <why>
 *   <file>: not marked: <why>             <file>: quotes not checked: <why>
 *   <file>: N of M marks not located: <reasons>[; no marked copy]
 *   <file>: page 1: "<quote>" is printed N times and finding K could not be tied to one of them; all N are boxed
 *   <file>: page 7 does not exist (1 page): <field paths>
 *   <file>: page 1 has no text, likely a scan: N quotes not checked
 *   <file>: page 1: N quotes not found in the page text: <field path> "<quote>"; …
 *   <file>: an image: [not marked, ]N quotes not checked     (or "not a PDF" for another format)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { annotateDocuments, checkNotes, checkQuotes, type QuoteCheck } from "@logisticshub/annotate";
import {
  buildReport,
  checkDocuments,
  decodeText,
  extractionJsonSchema,
  hsLookupOutput,
  ioProblem,
  parseJson,
  pickLanguage,
  renderHtml,
  renderJson,
  renderMarkdown,
  renderText,
  REPORT_LANGUAGES,
  type ReportFormat,
  type ReportLanguage,
} from "@logisticshub/core";

declare const __VERSION__: string;
const VERSION = typeof __VERSION__ === "string" ? __VERSION__ : "dev";
const FORMATS: ReportFormat[] = ["md", "json", "html"];

const USAGE = `Logisticshub ${VERSION}: cross-check trade documents

Usage:
  node check.mjs <extraction.json> [--lang en|ka|ru|tr] [--out <dir>] [--format md,json,html]
                 [--pdf-dir <dir>] [--no-annotate]
  node check.mjs --schema
  node check.mjs hs <code or Georgian words> [--json] [--limit <n>]

Writes report.md, report.json and report.html (default: next to the extraction)
and prints the report. PDFs named in sourceFile (looked up in --pdf-dir,
default: the extraction's folder) get a copy with the findings marked,
<name>.marked.pdf, and every quote is looked up on its page: what is not found
is listed under "Notes:". --no-annotate leaves the PDFs unread.

Exit codes:
  0  checked, with or without findings
  1  the extraction is not usable: the reports list what to fix
  2  nothing was checked: a bad option, a file that cannot be read or is not
     JSON, or reports that cannot be written`;

/** A wrong command line: the message and how to call the script. */
function fail(message: string): never {
  process.stderr.write(`${message}\n\n${USAGE}\n`);
  process.exit(2);
}

/** A file that cannot be read or written: one line, nothing else. */
function stop(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function parseArgs(argv: string[]) {
  const options: {
    file?: string;
    lang?: ReportLanguage;
    out?: string;
    pdfDir?: string;
    annotate: boolean;
    formats: ReportFormat[];
    schema: boolean;
  } = { formats: FORMATS, schema: false, annotate: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = () => argv[++i] ?? fail(`Missing value for ${arg}.`);
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    } else if (arg === "--version") {
      process.stdout.write(`${VERSION}\n`);
      process.exit(0);
    } else if (arg === "--schema") {
      options.schema = true;
    } else if (arg === "--lang") {
      const lang = next();
      if (!(REPORT_LANGUAGES as readonly string[]).includes(lang)) fail(`--lang must be one of ${REPORT_LANGUAGES.join(", ")}.`);
      options.lang = lang as ReportLanguage;
    } else if (arg === "--out") {
      options.out = next();
    } else if (arg === "--pdf-dir") {
      options.pdfDir = next();
    } else if (arg === "--no-annotate") {
      options.annotate = false;
    } else if (arg === "--format") {
      const formats = next().split(",").map((f) => f.trim());
      const unknown = [...new Set(formats)].filter((f) => !(FORMATS as string[]).includes(f));
      if (unknown.length > 0) fail(`--format takes a comma list of ${FORMATS.join(", ")}; got "${unknown.join('", "')}".`);
      options.formats = [...new Set(formats)] as ReportFormat[];
    } else if (arg.startsWith("-")) {
      fail(`Unknown option ${arg}.`);
    } else if (options.file) {
      fail("Give one extraction file.");
    } else {
      options.file = arg;
    }
  }
  return options;
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "hs") {
    if (args.includes("--help") || args.includes("-h")) return void process.stdout.write(`${USAGE}\n`);
    try {
      return void process.stdout.write(`${hsLookupOutput(args.slice(1))}\n`);
    } catch (error) {
      stop((error as Error).message);
    }
  }
  const options = parseArgs(args);
  if (options.schema) {
    process.stdout.write(`${JSON.stringify(extractionJsonSchema(), null, 2)}\n`);
    return;
  }
  if (!options.file) fail("Missing extraction file.");

  const file = resolve(options.file);
  let text: string;
  try {
    text = decodeText(readFileSync(file));
  } catch (error) {
    stop(`Cannot read ${file}: ${ioProblem(error)}.`);
  }
  const json = parseJson(text);
  if (!json.ok) stop(`Cannot read ${file}: ${json.problem}. Fix the file and run the check again.`);
  const input = json.value;

  const result = checkDocuments(input);
  const language = options.lang ?? pickLanguage(result.extraction);
  const view = buildReport(result, language);
  const reports: Record<ReportFormat, () => string> = {
    md: () => renderMarkdown(view),
    json: () => renderJson(result, view),
    html: () => renderHtml(view),
  };
  const outDir = resolve(options.out ?? dirname(file));
  const written: string[] = [];
  /** Writes into the output folder, or ends the run with one line when that cannot be done. */
  const advice = "Give --out a folder that can be written to.";
  const write = (name: string, content: string | Uint8Array) => {
    try {
      mkdirSync(outDir, { recursive: true });
    } catch (error) {
      stop(`Cannot write to ${outDir}: ${ioProblem(error)}. ${advice}`);
    }
    const path = join(outDir, name);
    try {
      writeFileSync(path, content);
    } catch (error) {
      stop(`Cannot write ${path}: ${ioProblem(error)}. ${advice}`);
    }
    written.push(path);
  };
  for (const format of options.formats) write(`report.${format}`, reports[format]());

  let notes: string[] = [];
  if (options.annotate) {
    const pdfDir = resolve(options.pdfDir ?? dirname(file));
    // Never throws: a PDF that cannot be marked, or a Node.js too old for PDF.js, ends up in the notes.
    const readPdf = (name: string) => {
      const path = join(pdfDir, basename(name));
      return existsSync(path) ? new Uint8Array(readFileSync(path)) : null;
    };
    const marking = await annotateDocuments(view, readPdf);
    for (const doc of marking.files) {
      if (doc.bytes) write(`${basename(doc.sourceFile, extname(doc.sourceFile))}.marked.pdf`, doc.bytes);
    }
    // Every quote against the text of its page: a wrong quote or page number is found here, not by a reader.
    const quotes: QuoteCheck = result.extraction ? await checkQuotes(result.extraction, readPdf) : { files: [], skipped: null };
    notes = checkNotes(marking, quotes);
  }

  const notesText = notes.length > 0 ? `Notes:\n${notes.map((n) => `- ${n}`).join("\n")}\n` : "";
  // The terminal gets the report without Markdown escapes; report.md keeps them.
  process.stdout.write(`${renderText(view)}\nFiles:\n${written.map((p) => `- ${p}`).join("\n")}\n${notesText}`);
  process.exitCode = result.ok ? 0 : 1;
}

try {
  await main();
} catch (error) {
  // Not expected: every known failure ends in stop() or fail() above.
  stop(`Unexpected error, nothing was checked: ${ioProblem(error)}`);
}
