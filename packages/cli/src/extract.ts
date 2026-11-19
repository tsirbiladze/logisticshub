/**
 * Turns document files into an extraction with an LLM. Each file goes through
 * its own steps, at most 4 model calls at a time:
 *
 * 1. classify: the file and a tiny schema (type, language);
 * 2. extract: the file with that type's schema;
 * 3. repair: one more call if the checker has something to correct: a value
 *    in the wrong format, or a quote that the PDF does not print on the page
 *    the extraction names.
 *
 * Only classification asks the provider for structured output. That compiles
 * the schema into a grammar, and Claude refuses the invoice's as too large
 * ("The compiled grammar is too large"). So extraction and repair send the
 * type's schema in the request, and the answer is read as JSON and checked
 * here, as the skill's agent writes it.
 * A failed call or a document that still breaks the schema leaves that file
 * out and is reported; the other files are still checked.
 */
import { checkQuotes } from "@logisticshub/annotate";
import {
  classificationJsonSchema,
  documentJsonSchema,
  DECLARATION_GUIDE,
  EXTRACTION_GUIDE,
  ISSUES_GUIDE,
  parseExtraction,
  SCHEMA_VERSION,
  type DocumentType,
  type Extraction,
  type ExtractionIssue,
  type TradeDocument,
} from "@logisticshub/core";
import { generateText, jsonSchema, Output, type LanguageModel, type ModelMessage, type UserContent } from "ai";

export interface InputFile {
  name: string;
  mediaType: string;
  bytes: Uint8Array;
}

/**
 * A file left out of the check. EXT_MODEL: a model call failed. EXT_SHAPE:
 * the document still breaks the schema after the repair call. `path` is the
 * file name.
 */
export interface ExtractionProblem extends ExtractionIssue {
  code: "EXT_MODEL" | "EXT_SHAPE";
  path: string;
  message: string;
}

export interface ExtractResult {
  /** The documents that pass the schema, in file order: these get checked. */
  extraction: Extraction;
  /** Documents the model returned that still break the schema, with their issues (paths "documents[0]…"). */
  rejected: { document: unknown; issues: ExtractionIssue[] }[];
  problems: ExtractionProblem[];
  /** Model calls made: 2 per file (classify, extract) + repairs, failed ones included. */
  calls: number;
}

export interface ExtractOptions {
  /** Most model calls in flight at once (default 4). */
  concurrency?: number;
  /** Look every quote up in its PDF and send the ones not found to the repair call (default true). */
  checkQuotes?: boolean;
}

/**
 * The sections of the guide a called model cannot act on. It sees one file,
 * so it never puts documents, files and pages together; and it never sees a
 * report, an issue list or \`Notes:\`, so what to do after the check is not
 * its to read.
 */
export const AGENT_ONLY_SECTIONS: readonly string[] = ["Several documents, files and pages", "Before the check, and after it"];

/** The extraction guide without AGENT_ONLY_SECTIONS: every other section as the skill's agent reads it. */
export function modelGuide(guide: string = EXTRACTION_GUIDE): string {
  const parts = guide.split(/^(?=## )/m);
  const kept = parts.filter((part) => !AGENT_ONLY_SECTIONS.some((heading) => part.startsWith(`## ${heading}\n`)));
  return `${kept.join("").trimEnd()}\n`;
}

export const MODEL_GUIDE = modelGuide();

/**
 * How the model reads the guide. The guide is written for an agent that works
 * with a user, runs commands and writes the whole extraction.json; a model
 * called by this program does none of that. The sections it cannot act on
 * are left out (MODEL_GUIDE), and every file, command and channel the rest
 * still names and the model does not have is named here
 * (test: "tells the model what it cannot do").
 */
export const MODEL_INSTRUCTIONS = `You extract one trade document into JSON for a deterministic checker. The checker compares the documents of a shipment with each other, so it needs exactly what each document prints, with verbatim quotes.

The guide below was written for an agent that works with a user, runs commands and writes a whole \`extraction.json\`. You are called by a program, once per file, and your whole answer is the JSON of one document. Follow the guide with these differences:

- **One file, one document.** You see one file and return the one document the request names. The program gives it its \`id\` and \`sourceFile\` and puts the documents of the set together, so of the section "File" only \`type\`, \`language\` and the last point are yours. When the file holds more than the document the request names, extract that document and leave the rest. \`page\` counts the pages of the file you were given, from 1. Where the guide looks at the issuer's other documents, you have none: go on to the next rule it gives.
- **No commands and no other files.** You cannot run \`pdftotext\`, \`pdftoppm\`, \`scripts/check.mjs\` or \`scripts/check.py\`, and you cannot open \`extraction-schema.json\`, \`extraction-blank.json\`, \`issues.md\` or \`declaration.md\`. The declaration guide is included here when applicable. Read the file as you were given it; the schema of your answer already holds every key.
- **No user to tell.** Nothing but the JSON reaches anyone: there is no report and no list to keep. Where the guide says to tell the user, apply the reading it gives and say nothing. Where the guide gives no reading, or a character cannot be read for certain, the fact is \`{ "value": null, "quote": null, "page": null }\`. A null is safe; a guess makes a false finding.
- **One correction.** The program checks your answer: the format of every value, each value against its own quote, and every quote against the text of its page. It may come back once with the problems it found, and with what \`issues.md\` says about each code among them. Correct those against the document and change nothing else. Change a value or a quote only to what the document prints, never just to make a problem go away: where the guide's point "A document that prints both conventions" applies, your value stays and so does the problem.`;

const SYSTEM = `${MODEL_INSTRUCTIONS}

${MODEL_GUIDE}`;

const ID: Record<DocumentType, string> = {
  commercial_invoice: "invoice",
  packing_list: "packing-list",
  cmr: "cmr",
  contract: "contract",
  customs_declaration: "declaration",
  other: "other",
};

/** One thing for the repair call to correct: an extraction issue (with its code), or a quote the PDF does not print. */
type Correction = Pick<ExtractionIssue, "path" | "message"> & { code?: string };

/**
 * The rows of issues.md by code: what the code means and the fix. A model
 * cannot open the file, so the repair call is sent the rows of the codes it
 * has to correct.
 */
export function issueRows(guide: string = ISSUES_GUIDE): Map<string, { means: string; fix: string }> {
  const rows = new Map<string, { means: string; fix: string }>();
  // "(table below)" points at a table of the file, which is not sent: the message itself gives the reading.
  for (const [, code, means, fix] of guide.matchAll(/^\| `(EXT_[A-Z_]+)` \| (.+?) \| (.+?) \|$/gm)) rows.set(code!, { means: means!.replace(/ \(table below\)$/, ""), fix: fix! });
  return rows;
}

/** Codes about extraction.json as a whole (its shape, its ids), which the model does not write: their rows speak of exit codes and of other documents. */
const NOT_THE_MODELS: ReadonlySet<string> = new Set(["EXT_SHAPE", "EXT_DUPLICATE_ID"]);

/** The request of the repair call: the problems, then issues.md's row for each code among them. */
export function correctionRequest(issues: readonly Correction[]): string {
  const rows = issueRows();
  const codes = [...new Set(issues.flatMap((i) => (i.code && !NOT_THE_MODELS.has(i.code) && rows.has(i.code) ? [i.code] : [])))];
  const problems = issues.map((i) => `- ${i.path}${i.code ? ` (${i.code})` : ""}: ${i.message}`);
  const meanings = codes.map((code) => `- ${code}: ${rows.get(code)!.means}. Fix: ${rows.get(code)!.fix}.`);
  return [
    "The checker found these problems. Correct them against the document, change nothing else, and return the full corrected JSON.",
    ...problems,
    ...(meanings.length > 0 ? ["", "What each code means, and the fix:", ...meanings] : []),
  ].join("\n");
}

type Classified = { sourceFile: string; type: DocumentType; language: TradeDocument["language"] };

const filePart = (file: InputFile) => ({ type: "file" as const, mediaType: file.mediaType, data: file.bytes, filename: file.name });

function schemaOf<T>(json: Record<string, unknown>) {
  return jsonSchema<T>(json as Parameters<typeof jsonSchema>[0]);
}

async function classify(file: InputFile, model: LanguageModel): Promise<DocumentType> {
  const content: UserContent = [
    { type: "text", text: `File: ${file.name}` },
    filePart(file),
    {
      type: "text",
      text: `Classify this file: commercial_invoice, packing_list, cmr (road consignment note), contract, customs_declaration (Georgian goods declaration or draft), or other. One entry, sourceFile exactly as given: ${file.name}.`,
    },
  ];
  const { output } = await generateText({
    model,
    messages: [{ role: "user", content }],
    output: Output.object({ schema: schemaOf<{ files: Classified[] }>(classificationJsonSchema()) }),
  });
  const files = output.files ?? [];
  return (files.find((c) => c.sourceFile === file.name) ?? files[0])?.type ?? "other";
}

function extractMessages(file: InputFile, type: DocumentType): ModelMessage[] {
  return [
    {
      role: "user",
      content: [
        { type: "text", text: `File: ${file.name}` },
        filePart(file),
        {
          type: "text",
          text: `This file is a ${type}. Extract it following the guide. Return the document JSON and nothing else: no words around it and no code fence. It must match this JSON Schema, with every key present:\n${JSON.stringify(documentJsonSchema(type))}`,
        },
      ],
    },
  ];
}

/**
 * The JSON object of a model's answer. The model is asked for the JSON alone;
 * a code fence or words around it are dropped, since the document is checked
 * against the schema afterwards.
 */
export function answerObject(text: string): Record<string, unknown> {
  const from = text.indexOf("{");
  const to = text.lastIndexOf("}");
  if (from === -1 || to < from) throw new Error("the answer is not JSON");
  try {
    return JSON.parse(text.slice(from, to + 1)) as Record<string, unknown>;
  } catch {
    throw new Error("the answer is not JSON");
  }
}

/** One document from the model: the answer as text, read as JSON. Its shape is checked by validate(). */
async function documentFrom(model: LanguageModel, type: DocumentType, messages: ModelMessage[]): Promise<TradeDocument> {
  const { text, finishReason } = await generateText({ model, system: type === "customs_declaration" ? `${SYSTEM}\n${DECLARATION_GUIDE}` : SYSTEM, messages });
  if (finishReason === "length") throw new Error("the answer was cut off at the model's output limit");
  const document = answerObject(text);
  if (document.type === "customs_declaration") document.sourceKind = null;
  return document as unknown as TradeDocument;
}

function extractOne(file: InputFile, type: DocumentType, model: LanguageModel): Promise<TradeDocument> {
  return documentFrom(model, type, extractMessages(file, type));
}

function repairOne(
  file: InputFile,
  type: DocumentType,
  doc: TradeDocument,
  issues: Correction[],
  model: LanguageModel,
): Promise<TradeDocument> {
  // The schema of the classified type is in the first request: the document's own type may be what is broken.
  return documentFrom(model, type, [
    ...extractMessages(file, type),
    { role: "assistant", content: JSON.stringify(doc) },
    { role: "user", content: correctionRequest(issues) },
  ]);
}

/** Gives each document a unique id ("invoice", "invoice-2"). */
function assignIds(docs: TradeDocument[]): TradeDocument[] {
  const seen = new Map<string, number>();
  return docs.map((doc) => {
    const base = ID[doc.type] ?? "other";
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { ...doc, id: n === 1 ? base : `${base}-${n}` };
  });
}

/** Runs at most `max` tasks at a time. */
function limiter(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active < max) active += 1;
    else await new Promise<void>((resolve) => waiting.push(resolve)); // the finishing task hands over its slot
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 300);

/**
 * Validates one document on its own (ids are given at the end), so its issues
 * are its own: paths start with "documents[0]".
 */
const validate = (doc: TradeDocument) => parseExtraction({ schemaVersion: SCHEMA_VERSION, documents: [{ ...doc, id: "doc" }] });

type Parsed = ReturnType<typeof validate>;

/**
 * The quotes of a well-shaped document that its PDF does not print where the
 * document says, worded for the repair call. A page without text (a scan) is
 * not a problem: nothing can be looked up there. Images are not read.
 */
async function quoteProblems(file: InputFile, parsed: Parsed): Promise<Correction[]> {
  if (!parsed.ok || file.mediaType !== "application/pdf") return [];
  const check = await checkQuotes(parsed.extraction, () => file.bytes);
  return check.files.flatMap((checked) =>
    checked.problems.flatMap((problem): Correction[] => {
      const pages = `the file has ${checked.pages} ${checked.pages === 1 ? "page" : "pages"}`;
      if (problem.reason === "no-page") {
        return [{ path: problem.path, message: `page ${problem.page} does not exist, ${pages}. Give the page the quote is printed on, counted from 1.` }];
      }
      if (problem.reason !== "not-found") return [];
      const where = problem.page === null ? "any page of the file" : `page ${problem.page} of the file`;
      return [
        {
          path: problem.path,
          message: `the quote ${JSON.stringify(problem.quote)} is not printed on ${where}. Copy the text character for character from the page, or correct the page number; if the document does not print this fact, make it null.`,
        },
      ];
    }),
  );
}

type FileOutcome =
  | { ok: true; doc: TradeDocument }
  | { ok: false; problem: ExtractionProblem; rejected?: { document: unknown; issues: ExtractionIssue[] } };

export async function extractDocuments(files: InputFile[], model: LanguageModel, options: ExtractOptions = {}): Promise<ExtractResult> {
  const limit = limiter(options.concurrency ?? 4);
  let calls = 0;
  const call = <T>(task: () => Promise<T>) =>
    limit(() => {
      calls += 1;
      return task();
    });

  const one = async (file: InputFile): Promise<FileOutcome> => {
    const failed = (step: string, error: unknown): FileOutcome => ({
      ok: false,
      problem: { code: "EXT_MODEL", path: file.name, message: `${step} failed: ${errorText(error)}` },
    });
    let type: DocumentType;
    try {
      type = await call(() => classify(file, model));
    } catch (error) {
      return failed("classification", error);
    }
    let doc: TradeDocument;
    try {
      doc = { ...(await call(() => extractOne(file, type, model))), sourceFile: file.name };
    } catch (error) {
      return failed("extraction", error);
    }
    let parsed = validate(doc);
    const lookUp = (p: Parsed) => (options.checkQuotes === false ? Promise.resolve([]) : quoteProblems(file, p));
    const unprinted = await lookUp(parsed);
    if (parsed.issues.length + unprinted.length > 0) {
      try {
        const repaired = { ...(await call(() => repairOne(file, type, doc, [...parsed.issues, ...unprinted], model))), sourceFile: file.name };
        const again = validate(repaired);
        // Keep the repair unless it made things worse: it broke the shape of a usable document, or left more to correct than before.
        const worse = parsed.ok && (!again.ok || again.issues.length + (await lookUp(again)).length > parsed.issues.length + unprinted.length);
        if (!worse) [doc, parsed] = [repaired, again];
      } catch {
        // The first answer stands; its issues are reported below or by the check.
      }
    }
    if (!parsed.ok) {
      const shown = parsed.issues.slice(0, 3).map((i) => `${i.path.replace(/^documents\[0\]\.?/, "") || "document"}: ${i.message}`);
      if (parsed.issues.length > 3) shown.push(`${parsed.issues.length - 3} more`);
      return {
        ok: false,
        problem: { code: "EXT_SHAPE", path: file.name, message: `left out, the extraction breaks the schema (kept in extraction.rejected.json): ${shown.join("; ")}` },
        rejected: { document: doc, issues: parsed.issues },
      };
    }
    return { ok: true, doc };
  };

  const outcomes = await Promise.all(files.map(one));
  const docs = assignIds(outcomes.flatMap((o) => (o.ok ? [o.doc] : [])));
  const parsed = parseExtraction({ schemaVersion: SCHEMA_VERSION, documents: docs });
  // Unreachable: the schema has no rules across documents.
  if (!parsed.ok) throw new Error(`Extracted documents fail together: ${parsed.issues[0]?.message ?? "unknown"}`);
  return {
    extraction: parsed.extraction,
    rejected: outcomes.flatMap((o) => (!o.ok && o.rejected ? [o.rejected] : [])),
    problems: outcomes.flatMap((o) => (o.ok ? [] : [o.problem])),
    calls,
  };
}
