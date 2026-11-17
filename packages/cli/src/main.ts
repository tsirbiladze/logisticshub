/**
 * logisticshub: cross-check trade documents.
 *
 *   logisticshub check <files|folder> [--lang ka] [--out dir] [--model anthropic:claude-opus-5-5]
 *   logisticshub check extraction.json [--pdf-dir dir] [--lang ka] [--out dir]
 *   logisticshub schema
 *   logisticshub mcp
 */
import { REPORT_LANGUAGES, extractionJsonSchema, ioProblem, type ReportFormat, type ReportLanguage } from "@logisticshub/core";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./mcp.ts";
import { DEFAULT_MODEL, ModelConfigError, resolveModel } from "./models.ts";
import { DOCUMENT_TYPES_TEXT, NothingChecked, OutputError, parseFormats, runCheck } from "./run.ts";

declare const __VERSION__: string;
const VERSION = typeof __VERSION__ === "string" ? __VERSION__ : "dev";

const USAGE = `logisticshub ${VERSION}: cross-check a shipment's trade documents (invoice, packing list, CMR, contract)

Usage:
  logisticshub check <files or folder> [options]   read the documents with an AI model, then check them
  logisticshub check extraction.json [options]     check an extraction you already have (no model, no key)
  logisticshub schema                              print the JSON Schema of extraction.json
  logisticshub mcp                                 run as an MCP server (stdio)

Inputs: ${DOCUMENT_TYPES_TEXT} files, or a folder of them (not its
subfolders, and not the <name>.marked.pdf copies an earlier run left there):
one document per file, the documents of one shipment per run. Or one
extraction.json, as an earlier run wrote it into --out.

Options:
  --lang <en|ka|ru|tr>    report language (default: the language of most documents, else en)
  --out <dir>             folder for the reports, extraction.json and the marked PDFs
                          (default: ./logisticshub-report)
  --model <provider:id>   the model that reads the documents (default: ${DEFAULT_MODEL});
                          also openai:<id> and openrouter:<id>. LOGISTICSHUB_MODEL sets it too.
  --pdf-dir <dir>         with an extraction.json: the folder of the PDFs it cites
                          (default: the extraction.json's folder)
  --format <md,json,html> report formats to write (default: all three)
  --no-annotate           do not read the PDFs after the extraction: no marked copies,
                          no quote looked up
  -h, --help              this text
  -v, --version           the version

Keys: ANTHROPIC_API_KEY, OPENAI_API_KEY or OPENROUTER_API_KEY, for the provider of --model.

Output: the report on stdout (the text of report.md, with document text as
printed), then "Files:" with what was written (report.md, report.json,
report.html, extraction.json, and <name>.marked.pdf for each PDF that has a
finding), then "Notes:" with what the PDFs showed: what could not be marked,
and each quote that is not printed where the extraction says. Progress and
errors go to stderr.

Exit codes:
  0  checked, with or without findings. The report may still open with
     extraction issues: read them first. Notes never change the exit code.
  1  not checked in full, and the reports say why: the extraction is not
     usable, or a file was left out (a model call failed, or its extraction
     still breaks the schema)
  2  nothing was checked: a bad option, a missing key, an input that cannot be
     read or is not JSON, no document the model could read, or an output
     folder that cannot be written. One line on stderr says which.`;

/** A wrong command line: the message and how to call the program. */
function fail(message: string): never {
  process.stderr.write(`${message}\n\n${USAGE}\n`);
  process.exit(2);
}

/** Nothing was checked: one line, nothing else. */
function stop(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

/** Runs a parser that throws UsageError, failing with exit code 2. */
function usage<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    stop((error as Error).message);
  }
}

async function check(args: string[]) {
  const inputs: string[] = [];
  let lang: ReportLanguage | undefined;
  let out = "logisticshub-report";
  let model = process.env.LOGISTICSHUB_MODEL || DEFAULT_MODEL;
  let formats: ReportFormat[] | undefined;
  let pdfDir: string | undefined;
  let annotate = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const next = () => args[++i] ?? stop(`Missing value for ${arg}.`);
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    } else if (arg === "--version" || arg === "-v") {
      process.stdout.write(`${VERSION}\n`);
      process.exit(0);
    } else if (arg === "--lang") {
      const value = next();
      if (!(REPORT_LANGUAGES as readonly string[]).includes(value)) stop(`--lang must be one of ${REPORT_LANGUAGES.join(", ")}.`);
      lang = value as ReportLanguage;
    } else if (arg === "--out") out = next();
    else if (arg === "--model") model = next();
    else if (arg === "--pdf-dir") pdfDir = next();
    else if (arg === "--format") formats = usage(() => parseFormats(next()));
    else if (arg === "--no-annotate") annotate = false;
    else if (arg.startsWith("-")) fail(`Unknown option ${arg}.`);
    else inputs.push(arg);
  }
  if (inputs.length === 0) fail("Give document files, a folder, or an extraction.json.");

  try {
    const run = await runCheck({
      inputs,
      outDir: out,
      annotate,
      ...(lang ? { language: lang } : {}),
      ...(formats ? { formats } : {}),
      ...(pdfDir !== undefined ? { pdfDir } : {}),
      model: () => resolveModel(model),
      log: (line) => process.stderr.write(`${line}\n`),
    });
    const notes = run.notes.length > 0 ? `Notes:\n${run.notes.map((n) => `- ${n}`).join("\n")}\n` : "";
    // What the skill's script prints: the report without Markdown escapes; report.md keeps them.
    process.stdout.write(`${run.text}\nFiles:\n${run.written.map((p) => `- ${p}`).join("\n")}\n${notes}`);
    process.exitCode = run.result.ok && run.complete ? 0 : 1;
  } catch (error) {
    if (error instanceof OutputError) stop(`${error.message} Give --out a folder that can be written to.`);
    if (error instanceof ModelConfigError || error instanceof NothingChecked) stop(error.message);
    // Not expected: every known failure is one of the errors above.
    stop(`Unexpected error, nothing was checked: ${ioProblem(error)}`);
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h" || command === "help") return void process.stdout.write(`${USAGE}\n`);
  if (command === "--version" || command === "-v") return void process.stdout.write(`${VERSION}\n`);
  if (command === "schema") return void process.stdout.write(`${JSON.stringify(extractionJsonSchema(), null, 2)}\n`);
  if (command === "mcp") return void (await createServer(VERSION).connect(new StdioServerTransport()));
  if (command === "check") return check(args);
  return check([command, ...args]);
}

await main();
