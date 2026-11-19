/** The check pipeline shared by the CLI command and the MCP server. */
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { annotateDocuments, checkNotes, checkQuotes, type Marking, type MarkResult, type QuoteCheck } from "@logisticshub/annotate";
import {
  buildReport,
  fetchRegistry,
  readRegistry,
  registryJson,
  shapeIssues,
  checkDocuments,
  decodeText,
  ioProblem,
  parseJson,
  pickLanguage,
  renderHtml,
  renderJson,
  renderMarkdown,
  renderText,
  SCHEMA_VERSION,
  type CheckResult,
  type ReportFormat,
  type ReportLanguage,
  type ReportView,
} from "@logisticshub/core";
import type { LanguageModel } from "ai";
import { extractDocuments, type ExtractionProblem, type InputFile } from "./extract.ts";

/** The run ended before anything was checked. The CLI prints the message and exits with 2. */
export class NothingChecked extends Error {}

/** Bad arguments, or an input that cannot be read. */
export class UsageError extends NothingChecked {}

/** Every model call failed: there is no document to check. */
export class NoDocumentError extends NothingChecked {}

/**
 * The output folder, or a file in it, cannot be written. The message ends
 * after the reason; the caller adds how its own option is called (--out, outDir).
 */
export class OutputError extends NothingChecked {
  constructor(target: string, problem: string) {
    super(`Cannot write ${target}: ${problem}.`);
  }
}

export const REPORT_FORMATS: readonly ReportFormat[] = ["md", "json", "html"];

/** " md, json" → ["md", "json"]; throws UsageError on an unknown or empty entry. */
export function parseFormats(value: string): ReportFormat[] {
  const formats = value.split(",").map((f) => f.trim());
  const unknown = formats.filter((f) => !(REPORT_FORMATS as readonly string[]).includes(f));
  if (unknown.length > 0) throw new UsageError(`--format takes a comma list of ${REPORT_FORMATS.join(", ")}; got "${unknown.join('", "')}".`);
  return [...new Set(formats)] as ReportFormat[];
}

const MEDIA_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

/** The file types a model reads, as the messages name them. */
export const DOCUMENT_TYPES_TEXT = ".pdf, .png, .jpg, .jpeg and .webp";

const isDocument = (path: string) => Boolean(MEDIA_TYPES[extname(path).toLowerCase()]);
const isJson = (path: string) => extname(path).toLowerCase() === ".json";

/** "<name>.marked.pdf": the copy of a PDF that a run writes with the findings boxed. */
export const isMarkedCopy = (path: string) => /\.marked\.pdf$/i.test(basename(path));

/**
 * Document files from paths (files or folders, one level deep), sorted by
 * name. Documents are told apart by file name (sourceFile, <name>.marked.pdf),
 * so two files with one name are a usage error. In a folder, files of other
 * types are passed over, and so is every <name>.marked.pdf: it is the copy an
 * earlier run wrote there, not one more document. Their paths are added to
 * `passedOver`. A file named on its own must be a document, and is read
 * whatever its name.
 */
export function collectFiles(paths: string[], passedOver: string[] = []): InputFile[] {
  const files = new Set<string>();
  for (const path of paths.map((p) => resolve(p))) {
    try {
      if (statSync(path).isDirectory()) {
        for (const entry of readdirSync(path).sort()) {
          const full = join(path, entry);
          if (!isDocument(entry) || !statSync(full).isFile()) continue;
          if (isMarkedCopy(entry)) passedOver.push(full);
          else files.add(full);
        }
        continue;
      }
    } catch (error) {
      throw new UsageError(`Cannot read ${path}: ${ioProblem(error)}.`);
    }
    if (!isDocument(path)) {
      throw new UsageError(`Cannot read ${path}: not a PDF or an image. Give ${DOCUMENT_TYPES_TEXT} files, a folder of them, or one extraction.json.`);
    }
    files.add(path);
  }
  const sorted = [...files].sort();
  const byName = new Map<string, string[]>();
  for (const f of sorted) byName.set(basename(f).toLowerCase(), [...(byName.get(basename(f).toLowerCase()) ?? []), f]);
  const clashes = [...byName.values()].filter((same) => same.length > 1);
  if (clashes.length > 0) {
    throw new UsageError(
      `Files share a name: ${clashes.map((same) => same.join(" and ")).join("; ")}. Documents are told apart by file name; rename one.`,
    );
  }
  return sorted.map((f) => ({ name: basename(f), mediaType: MEDIA_TYPES[extname(f).toLowerCase()]!, bytes: new Uint8Array(readFileSync(f)) }));
}

export interface RunOptions {
  /** Document files, folders, or one extraction.json. */
  inputs?: string[];
  /** An extraction object, checked instead of `inputs`. */
  extraction?: unknown;
  /** Folder for reports, extraction.json and marked PDFs; without it nothing is written. */
  outDir?: string;
  language?: ReportLanguage;
  formats?: ReportFormat[];
  /** False: the PDFs are not read after the extraction, so nothing is marked and no quote is looked up. */
  annotate?: boolean;
  /** Folder with the original PDFs when the input is an extraction (default: the extraction.json's folder). */
  pdfDir?: string;
  /** Needed unless the input is an extraction. */
  model?: () => LanguageModel;
  /** Most model calls in flight at once (default 4). */
  concurrency?: number;
  log?: (line: string) => void;
  registryFile?: string;
  fetchRegistry?: boolean;
}

export interface RunResult {
  /** The check result; its extractionIssues also list the files left out (EXT_MODEL, EXT_SHAPE). */
  result: CheckResult;
  language: ReportLanguage;
  /** The result in the report language: each finding's message, what to check, and where its evidence is. */
  view: ReportView;
  /** report.md: document text is escaped, so that no character of it is read as Markdown. */
  markdown: string;
  /** The same report for a terminal or a model: document text as printed, without the escapes. */
  text: string;
  written: string[];
  annotations: { sourceFile: string; results: MarkResult[] }[];
  /**
   * What reading the PDFs found, one line each: what could not be marked
   * ("<file>: not marked: …") and every quote that is not printed where the
   * extraction says ("<file>: page 1: 2 quotes not found in the page text: …").
   */
  notes: string[];
  /** False when some input file was left out of the check: the CLI then exits with 1. */
  complete: boolean;
  modelCalls: number;
}

/**
 * Why `dir` cannot be made or written to, or null. Looks at the nearest
 * folder that exists, so nothing is created by asking.
 */
function unwritable(dir: string): string | null {
  for (let at = dir; ; at = dirname(at)) {
    try {
      if (!statSync(at).isDirectory()) return ioProblem({ code: "ENOTDIR" });
      accessSync(at, constants.W_OK | constants.X_OK);
      return null;
    } catch (error) {
      if ((error as { code?: unknown }).code !== "ENOENT" || dirname(at) === at) return ioProblem(error);
    }
  }
}

export async function runCheck(options: RunOptions): Promise<RunResult> {
  const log = options.log ?? (() => {});
  if (options.registryFile !== undefined && options.fetchRegistry) throw new UsageError("Use either --registry or --fetch-registry.");
  let registry = options.registryFile === undefined ? undefined : readRegistry(resolve(options.registryFile));
  const outDir = options.outDir === undefined ? null : resolve(options.outDir);
  const written: string[] = [];
  const write = (name: string, data: string | Uint8Array) => {
    if (!outDir) return;
    // Created on the first write, so a run that fails early leaves no empty folder.
    try {
      if (written.length === 0) mkdirSync(outDir, { recursive: true });
    } catch (error) {
      throw new OutputError(`to ${outDir}`, ioProblem(error));
    }
    const path = join(outDir, name);
    try {
      writeFileSync(path, data);
    } catch (error) {
      throw new OutputError(path, ioProblem(error));
    }
    written.push(path);
  };

  const inputs = options.inputs ?? [];
  const jsonInputs = options.extraction === undefined ? inputs.filter(isJson) : [];
  if (jsonInputs.length > 1) {
    throw new UsageError(
      `Give one extraction.json per run; got ${jsonInputs.length} (${jsonInputs.join(", ")}). Each extraction is one shipment: check them one at a time, each with its own --out.`,
    );
  }
  if (jsonInputs.length === 1 && inputs.length > 1) {
    throw new UsageError(`An extraction.json is checked on its own; got ${inputs.length} inputs. To mark the PDFs it cites, give their folder with --pdf-dir.`);
  }
  const jsonPath = jsonInputs.length === 1 ? resolve(jsonInputs[0]!) : null;
  if (options.fetchRegistry && outDir && jsonPath === join(outDir, "registry.json")) {
    throw new UsageError("The registry snapshot and extraction must use different paths.");
  }
  if (options.pdfDir !== undefined && options.extraction === undefined && !jsonPath) {
    throw new UsageError("--pdf-dir goes with an extraction.json: it names the folder of the PDFs the extraction cites. Document files given as inputs need no --pdf-dir.");
  }
  // Before any model call: a run must not be paid for and then have nowhere to go.
  if (outDir) {
    const problem = unwritable(outDir);
    if (problem) throw new OutputError(`to ${outDir}`, problem);
  }

  let input: unknown;
  let modelCalls = 0;
  let problems: ExtractionProblem[] = [];
  let readPdf: (name: string) => Uint8Array | null = () => null;

  if (options.extraction !== undefined || jsonPath) {
    if (jsonPath) {
      let text: string;
      try {
        text = decodeText(readFileSync(jsonPath));
      } catch (error) {
        throw new UsageError(`Cannot read ${jsonPath}: ${ioProblem(error)}.`);
      }
      const json = parseJson(text);
      if (!json.ok) throw new UsageError(`Cannot read ${jsonPath}: ${json.problem}. Fix the file and run the check again.`);
      input = json.value;
    } else {
      input = options.extraction;
    }
    const pdfDir = options.pdfDir ?? (jsonPath ? dirname(jsonPath) : null);
    if (pdfDir) {
      readPdf = (name) => {
        const path = join(resolve(pdfDir), basename(name));
        return existsSync(path) ? new Uint8Array(readFileSync(path)) : null;
      };
    }
  } else {
    const passedOver: string[] = [];
    const files = collectFiles(inputs, passedOver);
    const copies = `${passedOver.length === 1 ? "marked copy" : "marked copies"} of an earlier run`;
    if (files.length === 0) {
      const only = passedOver.length > 0 ? ` The ${copies} (${passedOver.map((p) => basename(p)).join(", ")}) ${passedOver.length === 1 ? "is not read as a document" : "are not read as documents"}.` : "";
      throw new UsageError(
        `No PDF or image files (${DOCUMENT_TYPES_TEXT}) in ${inputs.map((p) => resolve(p)).join(", ")}.${only} To check an extraction you already have, give the extraction.json itself.`,
      );
    }
    if (!options.model) throw new Error("A model is needed to read documents.");
    // Before "Reading…": a missing key is said first, not after a line that reads as progress.
    const model = options.model();
    if (passedOver.length > 0) log(`Passed over ${passedOver.length} ${copies}: ${passedOver.map((p) => basename(p)).join(", ")}`);
    log(`Reading ${files.length} file(s): ${files.map((f) => f.name).join(", ")}`);
    const extracted = await extractDocuments(files, model, {
      ...(options.concurrency ? { concurrency: options.concurrency } : {}),
      checkQuotes: options.annotate !== false,
    });
    modelCalls = extracted.calls;
    problems = extracted.problems;
    for (const p of problems) log(`${p.path}: ${p.message}`);
    if (extracted.extraction.documents.length === 0 && extracted.rejected.length === 0) {
      // Every call failed (a bad key, no network): nothing to report or keep.
      const reasons = [...new Set(problems.map((p) => p.message))];
      throw new NoDocumentError(`No document could be read. ${reasons.length === 1 ? reasons[0] : problems.map((p) => `${p.path}: ${p.message}`).join("; ")}`);
    }
    input = extracted.extraction;
    // Never an empty extraction.json over real results; what failed the schema is kept apart.
    if (extracted.extraction.documents.length > 0) write("extraction.json", `${JSON.stringify(input, null, 2)}\n`);
    if (extracted.rejected.length > 0) {
      const rejected = {
        schemaVersion: SCHEMA_VERSION,
        documents: extracted.rejected.map((r) => r.document),
        issues: extracted.rejected.flatMap((r, i) => r.issues.map((issue) => ({ ...issue, path: issue.path.replace(/^documents\[0\]/, `documents[${i}]`) }))),
      };
      write("extraction.rejected.json", `${JSON.stringify(rejected, null, 2)}\n`);
    }
    const byName = new Map(files.map((f) => [f.name, f.bytes]));
    readPdf = (name) => byName.get(name) ?? null;
  }

  if (options.fetchRegistry && outDir && shapeIssues(input).length === 0) {
    const snapshot = await fetchRegistry(input, log);
    write("registry.json", registryJson(snapshot));
    registry = readRegistry(join(outDir, "registry.json"));
  }
  let result: CheckResult = checkDocuments(input, registry ? { registry } : {});
  if (problems.length > 0) {
    const extractionIssues = [...problems, ...result.extractionIssues];
    // With no document left to check, the run reads as an unreadable extraction, not as "no problems".
    result =
      result.summary.documents > 0
        ? { ...result, extractionIssues }
        : { ok: false, extraction: null, extractionIssues, findings: [], summary: { documents: 0, errors: 0, warnings: 0 } };
  }
  const language = options.language ?? pickLanguage(result.extraction);
  const view = buildReport(result, language);
  const formats = options.formats ?? REPORT_FORMATS;
  const markdown = renderMarkdown(view);
  if (formats.includes("md")) write("report.md", markdown);
  if (formats.includes("json")) write("report.json", renderJson(result, view));
  if (formats.includes("html")) write("report.html", renderHtml(view));

  const annotations: RunResult["annotations"] = [];
  let notes: string[] = [];
  if (options.annotate !== false) {
    // Marked copies need a folder to go to; the quotes are looked up either way.
    const marking: Marking = outDir ? await annotateDocuments(view, readPdf) : { files: [], skipped: null };
    for (const file of marking.files) {
      if (file.bytes) write(`${basename(file.sourceFile, extname(file.sourceFile))}.marked.pdf`, file.bytes);
      annotations.push({ sourceFile: file.sourceFile, results: file.results });
    }
    // Every quote against the text of its page: a wrong quote or page number is found here, not by a reader.
    const quotes: QuoteCheck = result.extraction ? await checkQuotes(result.extraction, readPdf) : { files: [], skipped: null };
    notes = checkNotes(marking, quotes);
  }
  return { result, language, view, markdown, text: renderText(view), written, annotations, notes, complete: problems.length === 0, modelCalls };
}
