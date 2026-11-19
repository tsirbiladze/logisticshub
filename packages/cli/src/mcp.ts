/**
 * MCP server (stdio): the host agent reads the documents itself, gets the
 * extraction guide from this server, and sends the extraction for checking.
 */
import { isAbsolute } from "node:path";
import { lookupTaxpayer, RegistryInputError, taxpayerText, DECLARATION_GUIDE, EXTRACTION_GUIDE, extractionBlank, extractionJsonSchema, HS_LOOKUP_LIMIT, ISSUES_GUIDE, lookupHsCode, parseJson, REPORT_LANGUAGES, RULE_IDS, type ReportLanguage } from "@logisticshub/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { OutputError, runCheck } from "./run.ts";

/** Sent to the client when it connects: what the server is for and the order of the calls. */
export const SERVER_INSTRUCTIONS = `Logisticshub cross-checks the documents of one shipment (commercial invoice, packing list, CMR, sales contract and optional Georgian customs declaration) against each other with ${RULE_IDS.length} deterministic rules. One document is a set too: an invoice on its own gets its line totals, its sums and its amount in words checked. It reads no document itself: you read them, and it checks what you extracted.

1. Call get_extraction_guide and read it in full. Set includeDeclaration to true if the set includes a Georgian customs declaration.
2. Read every page of every document of the shipment yourself and build the extraction object the guide describes: each fact with its value, its verbatim quote and its page.
3. Call check_documents with that object. Give pdfDir (the absolute path of the folder with the PDFs) to have every quote looked up on its page, and outDir (an absolute path) to have the reports written. With both, each PDF that has a finding also gets a copy with the findings marked.
4. If the result lists extraction issues or notes, its last text part says what each code and each note means and what to do, and which one is not yours to fix. Then correct the extraction against the documents and call check_documents again, at most twice. What is still listed after that goes to the user.
5. Give the user every finding with its quotes and pages, as a discrepancy to verify against the originals, not as a verdict.

Use lookup_hs_code to explain a Georgian code or see related entries for HS-01. It uses the original text of Order No. 21 of 2024-01-26 (publication 0). Later amendments were not verified.

Not for paying or booking an invoice. Offer lookup_taxpayer when the user wants to verify a Georgian company. Ask for their agreement first: it sends one 9-digit company code to the Revenue Service. check_documents takes an optional registryFile, an absolute path to a saved snapshot, and checks it offline.`;

/** How the guide's words map to this server: the guide is the skill's, and names the skill's files and script. */
const GUIDE_PREFACE = `This guide comes with the Logisticshub skill, so it names the skill's files. With this server:

- \`scripts/check.mjs\` is the tool check_documents: pass the extraction as its \`extraction\` argument. Write no file unless the user wants one.
- \`extraction-schema.json\` and \`extraction-blank.json\` follow the guide. Set \`includeDeclaration\` to true to include \`declaration.md\` when needed.
- The \`Notes:\` the guide speaks of come back in the result of check_documents (\`notes\`), when you give it \`pdfDir\`. Without \`pdfDir\` no PDF is read and no quote is looked up.
- \`issues.md\` comes back with the result of check_documents, as its last text part, whenever that result lists an extraction issue or a note. A result with neither needs no more reading.
- When the extraction is not usable, the result is an error with \`ok\` false, and \`extractionIssues\` say what to write at which path.`;

/** In front of issues.md in a result: that text is the skill's too, and names the skill's file and options. */
export const ISSUES_PREFACE = `What the extraction issues and the notes of this result mean, and what to do about each. The text below is the skill's \`issues.md\`, so it names the skill's file and script. With this server:

- \`extraction.json\` is the object you pass as \`extraction\`, "the script prints" means this result, and "Run again" means call check_documents again.
- \`--pdf-dir\` is the argument \`pdfDir\`. Notes come only when you give it.
- Exit codes do not exist here: \`ok\` false stands for exit code 1.`;

/** What a client is told when \`extraction\` is neither the object nor a string of JSON that holds it. */
const NOT_AN_OBJECT = 'extraction must be the extraction object itself: { "schemaVersion": …, "documents": [ … ] }, as get_extraction_guide describes it. A string is read only when it is that object as JSON.';

/** Key of the object that stands for a string that could not be read as JSON. No extraction has it. */
const NOT_JSON = "(not JSON)";

/**
 * A client that passes the extraction as a string of JSON (a common mistake)
 * means the object in it: read it instead of refusing. A string that is not
 * JSON is kept with what is wrong with it, for the handler to say.
 */
function fromJsonString(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const json = parseJson(value);
  return json.ok ? json.value : { [NOT_JSON]: value.trim() === "" ? "empty" : json.problem };
}

/** The structured result of check_documents. */
const checkOutput = {
  ok: z.boolean().describe("False when the extraction is not usable (wrong shape, another schema version): no rule ran, and extractionIssues say what to write."),
  language: z.enum(REPORT_LANGUAGES).describe("The language of the report and of the messages below."),
  summary: z.object({
    documents: z.number().describe("Documents checked."),
    errors: z.number().describe("Findings of severity error."),
    warnings: z.number().describe("Findings of severity warning."),
  }),
  extractionIssues: z
    .array(
      z.object({
        code: z.string().describe("EXT_… code. The last text part of a result with issues says what each code means and how to fix it."),
        path: z.string().describe('Field path in the extraction: "documents[0].lines[1].lineTotal".'),
        message: z.string(),
      }),
    )
    .describe("What is wrong with the extraction itself. A value with an issue is left out of the rules, so correct these first."),
  findings: z
    .array(
      z.object({
        rule: z.string().describe('Rule id: "SUM-01".'),
        severity: z.enum(["error", "warning"]),
        key: z.string().describe('Which finding of the rule: "SUM-01.line".'),
        params: z.record(z.string(), z.string()).describe("The values the message is built from."),
        message: z.string().describe("The finding in one sentence, in the report language."),
        check: z.string().describe("What to verify in the documents."),
        units: z
          .record(z.string(), z.string())
          .describe('The currency (ISO 4217) of each amount of money in params, by param name, where the rule knows it: { "expected": "EUR" }. The message already prints it; params stay bare decimals.'),
        evidence: z.array(
          z.object({
            document: z.string().describe("Document id in the extraction."),
            sourceFile: z.string().nullable(),
            page: z.number().nullable(),
            path: z.string().describe("Field path inside the document."),
            label: z.string().nullable().describe('Which field this is, in the report language: "subtotal", "line 2, quantity". Null for a sum the checker worked out.'),
            quote: z.string().nullable().describe("The quoted text; null for a sum the checker worked out."),
            value: z.string().nullable(),
          }),
        ),
      }),
    )
    .describe("The discrepancies between the documents, errors and warnings."),
  registry: z.record(z.string(), z.unknown()).optional().describe("Registry section when a snapshot is supplied."),
  files: z.array(z.string()).describe("Absolute paths of the files written; empty without outDir."),
  notes: z
    .array(z.string())
    .describe(
      "What reading the PDFs showed: what could not be marked, and each quote that is not printed where the extraction says. Empty without pdfDir. The last text part of a result with notes says what to do about each.",
    ),
};

export function createServer(version: string): McpServer {
  const server = new McpServer({ name: "logisticshub", version }, { instructions: SERVER_INSTRUCTIONS });

  server.registerTool(
    "get_extraction_guide",
    {
      title: "Extraction guide",
      description:
        "Returns how to extract trade documents (commercial invoice, packing list, CMR, contract, Georgian customs declaration) into the object that check_documents expects: the guide, the JSON Schema, and a blank of every document type to copy. Call it before check_documents.",
      inputSchema: { includeDeclaration: z.boolean().optional().describe("Include declaration.md for a Georgian customs declaration.") },
      annotations: { readOnlyHint: true },
    },
    async ({ includeDeclaration }) => ({
      content: [
        { type: "text", text: GUIDE_PREFACE },
        { type: "text", text: EXTRACTION_GUIDE },
        ...(includeDeclaration ? [{ type: "text" as const, text: DECLARATION_GUIDE }] : []),
        { type: "text", text: `extraction-schema.json (JSON Schema):\n${JSON.stringify(extractionJsonSchema())}` },
        { type: "text", text: `extraction-blank.json:\n${JSON.stringify(extractionBlank())}` },
      ],
    }),
  );

  server.registerTool(
    "check_documents",
    {
      title: "Check trade documents",
      description: `Cross-checks the extracted documents of one shipment with ${RULE_IDS.length} deterministic rules (amount in words against figures, totals, quantities, packages, weights, references, dates, parties, Incoterms, CMR particulars, Georgian HS codes, customs declaration) and returns the report with quoted evidence. With pdfDir it looks every quote up on its page; with outDir it writes the reports; with both it also marks the findings on copies of the PDFs.`,
      inputSchema: {
        extraction: z
          .preprocess(fromJsonString, z.record(z.string(), z.unknown(), { error: NOT_AN_OBJECT }))
          .describe("The extraction object, as described by get_extraction_guide. Pass the object itself, not a string of JSON."),
        language: z.enum(REPORT_LANGUAGES).optional().describe("Report language; defaults to the language of most documents, else en."),
        outDir: z
          .string()
          .optional()
          .describe("Absolute path of a folder to write report.md, report.json and report.html (and marked PDFs) into. Without it the report is only returned."),
        registryFile: z.string().optional().describe("Absolute path to a saved registry.json snapshot. The check reads it offline."),
        pdfDir: z
          .string()
          .optional()
          .describe(
            "Absolute path of the folder with the original PDFs, named as in sourceFile. Every quote is looked up on its page, and what is not found comes back in notes. With outDir as well, each PDF with a finding gets a marked copy, <name>.marked.pdf, in outDir; without outDir nothing is written and no PDF is marked.",
          ),
      },
      outputSchema: checkOutput,
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async ({ extraction, language, outDir, pdfDir, registryFile }) => {
      const refuse = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
      if (Object.hasOwn(extraction, NOT_JSON)) return refuse(`${NOT_AN_OBJECT} The string you passed is ${String(extraction[NOT_JSON])}. Nothing was checked.`);
      for (const [name, path] of [["outDir", outDir], ["pdfDir", pdfDir], ["registryFile", registryFile]] as const) {
        if (path !== undefined && !isAbsolute(path)) return refuse(`${name} must be an absolute path; got "${path}".`);
      }

      let run;
      try {
        // In memory: nothing is written unless outDir is given. With pdfDir alone the quotes are looked up and no PDF is marked.
        run = await runCheck({
          extraction,
          ...(outDir ? { outDir } : {}),
          ...(language ? { language: language as ReportLanguage } : {}),
          annotate: Boolean(pdfDir),
          ...(pdfDir ? { pdfDir } : {}),
          ...(registryFile === undefined ? {} : { registryFile }),
        });
      } catch (error) {
        if (error instanceof OutputError) return refuse(`${error.message} Nothing was checked. Give outDir a folder that can be written to, or leave it out to get the report inline.`);
        if (error instanceof RegistryInputError) return refuse(`${error.message} Nothing was checked.`);
        throw error;
      }
      const files = run.written.length > 0 ? `\n\nFiles:\n${run.written.map((p) => `- ${p}`).join("\n")}` : "";
      const notes = run.notes.length > 0 ? `\n\nNotes:\n${run.notes.map((n) => `- ${n}`).join("\n")}` : "";
      const findings = [...run.view.errors, ...run.view.warnings].sort((a, b) => a.index - b.index);
      // issues.md, as the skill has it: sent only with a result that has something to look up in it.
      const toDo = run.result.extractionIssues.length > 0 || run.notes.length > 0 ? [{ type: "text" as const, text: `${ISSUES_PREFACE}\n\n${ISSUES_GUIDE}` }] : [];
      return {
        // The report as the skill's script prints it: document text as printed, without Markdown escapes.
        content: [{ type: "text", text: `${run.text}${files}${notes}` }, ...toDo],
        structuredContent: {
          ok: run.result.ok,
          language: run.language,
          summary: run.result.summary,
          extractionIssues: run.result.extractionIssues.map(({ code, path, message }) => ({ code, path, message })),
          findings: findings.map(({ rule, severity, key, params, message, check, units, evidence }) => ({
            rule,
            severity,
            key,
            params,
            message,
            check,
            units,
            evidence: evidence.map((e) => ({ document: e.documentId, sourceFile: e.sourceFile, page: e.page, path: e.path, label: e.label, quote: e.quote, value: e.value })),
          })),
          ...(run.view.registry ? { registry: run.view.registry } : {}),
          files: run.written,
          notes: run.notes,
        },
        isError: !run.result.ok,
      };
    },
  );

  const entry = z.object({
    code: z.string(),
    level: z.enum(["heading", "subheading", "national code"]),
    description: z.string(),
    depth: z.number().int().nonnegative(),
    supplementaryUnit: z.string().nullable(),
  });
  server.registerTool(
    "lookup_hs_code",
    {
      title: "Look up Georgian HS codes",
      description: "Search the original annex to Georgian Order No. 21 of 2024-01-26 (publication 0) by code or Georgian description. Later amendments were not verified. Returns official descriptions, related headings and units. Use to explain codes or investigate HS-01 findings.",
      inputSchema: {
        query: z.string().trim().min(1).describe("Digits (exact code or prefix, with or without spaces and dots) or a substring of the Georgian description."),
        limit: z.number().int().positive().optional().describe(`Maximum number of matches, default ${HS_LOOKUP_LIMIT}.`),
      },
      outputSchema: {
        edition: z.object({
          orderNumber: z.number(),
          orderDate: z.string(),
          publishedDate: z.string(),
          inForceFrom: z.string(),
          title: z.string(),
          documentId: z.number(),
          publication: z.number(),
          laterAmendmentsVerified: z.literal(false),
        }),
        sourceUrl: z.url(),
        matches: z.array(entry.extend({ ancestors: z.array(entry) })),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, limit }) => {
      const result = lookupHsCode(query, limit);
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    },
  );

  server.registerTool(
    "lookup_taxpayer",
    {
      title: "Look up a Georgian company",
      description: "With the user's agreement, send one 9-digit company code to the Revenue Service and return its public reply. Personal numbers are never sent.",
      inputSchema: { code: z.string().describe("A 9-digit Georgian company code.") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ code }) => {
      try {
        const entry = await lookupTaxpayer(code);
        return { content: [{ type: "text", text: taxpayerText(entry) }], structuredContent: entry };
      } catch (error) {
        if (!(error instanceof RegistryInputError)) throw error;
        return { content: [{ type: "text", text: error.message }], isError: true };
      }
    },
  );

  return server;
}
