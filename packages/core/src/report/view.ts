/**
 * Language-specific view of a check result, shared by the Markdown, HTML and
 * JSON reports.
 */
import { registryView } from "./registry.ts";
import type { CheckResult } from "../check/index.ts";
import { formatMessage, REPORT_LANGUAGES, VOCAB, type MessageKey, type ReportLanguage } from "../check/messages.ts";
import { RULES } from "../check/index.ts";
import type { RuleId, Severity } from "../check/types.ts";
import { walkCited } from "../introspect.ts";
import { documentSchema, type DocumentType, type Extraction } from "../schema.ts";
import { checkLine, FIELD_LABELS, RULE_TITLES, UI, type UiStrings } from "./i18n.ts";

export interface EvidenceView {
  document: string;
  documentId: string;
  /** Position of the document in the extraction: ids may repeat, positions cannot. */
  documentIndex: number;
  documentType: DocumentType;
  number: string | null;
  sourceFile: string | null;
  dataSource?: true;
  page: number | null;
  path: string;
  /** Which field this is, in the report's language ("subtotal", "line 2, quantity"); null for a sum of lines and for a path without a name. */
  label: string | null;
  quote: string | null;
  value: string | null;
  /** The value is a sum of lines worked out by the checker (no quote exists). */
  computed: boolean;
}

export interface FindingView {
  index: number;
  rule: RuleId;
  ruleTitle: string;
  severity: Severity;
  message: string;
  /** What to check in the documents: one line of advice, the key's own or its rule's. */
  check: string;
  /** Message template and params, so a renderer can escape the document text in them. */
  key: MessageKey;
  params: Record<string, string>;
  /** The currency of each money param the rule knows it for (see Finding.units). */
  units: Record<string, string>;
  evidence: EvidenceView[];
}

/**
 * One quote the extraction cites from a file. The marker reads these to tell
 * the copies of a repeated quote apart ("USD 15,500.00" as subtotal and as
 * total): the fields that share a quote stand here in schema order.
 */
export interface Citation {
  sourceFile: string;
  documentIndex: number;
  /** Field path inside the document, as in the evidence: "lines[0].lineTotal". */
  path: string;
  quote: string;
  page: number | null;
}

export interface ReportView {
  language: ReportLanguage;
  ui: UiStrings;
  readable: boolean;
  documents: { id: string; type: DocumentType; label: string; number: string | null; sourceFile: string | null }[];
  rulesRun: number;
  errors: FindingView[];
  warnings: FindingView[];
  extractionIssues: { code: string; path: string; message: string }[];
  /** Every quote of the documents that have findings, in document and schema order. Not part of any rendered report. */
  citations: Citation[];
  sourceNotes: string[];
  registry?: ReturnType<typeof registryView>;
}

/**
 * The name of an evidence field in the report's language: "subtotal",
 * "line 2, quantity", „საბოლოო ჯამი“. Null when the path has no name (a sum
 * of lines, "lines[*]").
 */
export function fieldLabel(type: DocumentType, path: string, language: ReportLanguage): string | null {
  const labels = FIELD_LABELS[language];
  const key = path.replace(/\[[^\]]*\]/g, "");
  const typed = `${type}:${key}`;
  const label = Object.hasOwn(labels, typed) ? labels[typed]! : Object.hasOwn(labels, key) ? labels[key]! : null;
  if (label === null) return null;
  const row = /^(lines|items)\[([0-9]+)\]\./.exec(path);
  const vocab = VOCAB[language];
  return row ? `${row[1] === "items" ? vocab.item : vocab.line} ${Number(row[2]) + 1}, ${label}` : label;
}

/** Most common document language among the report languages, else English. */
export function pickLanguage(extraction: Extraction | null): ReportLanguage {
  const counts = new Map<ReportLanguage, number>();
  for (const doc of extraction?.documents ?? []) {
    const lang = doc.language;
    if (lang && (REPORT_LANGUAGES as readonly string[]).includes(lang)) {
      counts.set(lang as ReportLanguage, (counts.get(lang as ReportLanguage) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "en";
}

export function buildReport(result: CheckResult, language: ReportLanguage = pickLanguage(result.extraction)): ReportView {
  const vocab = VOCAB[language];
  const docs = result.extraction?.documents ?? [];
  const findings: FindingView[] = result.findings.map((finding, index) => ({
    index: index + 1,
    rule: finding.rule,
    ruleTitle: RULE_TITLES[language][finding.rule],
    severity: finding.severity,
    message: formatMessage(finding.key, finding.params, language, undefined, finding.units),
    check: checkLine(finding.key, finding.rule, language),
    key: finding.key,
    params: finding.params,
    units: finding.units ?? {},
    evidence: finding.evidence.map((e) => {
      // By position: two documents may carry the same id (an extraction issue), never the same position.
      const doc = docs[e.documentIndex];
      return {
        document: vocab.doc[e.documentType],
        documentId: e.documentId,
        documentIndex: e.documentIndex,
        documentType: e.documentType,
        number: doc?.number.value ?? null,
        sourceFile: doc?.sourceFile ?? null,
        ...(doc?.type === "customs_declaration" && doc.sourceKind === "rs_json" ? { dataSource: true as const } : {}),
        page: e.page,
        path: e.path,
        label: e.computed === true ? null : fieldLabel(e.documentType, e.path, language),
        quote: e.quote,
        value: e.value,
        computed: e.computed === true,
      };
    }),
  }));
  // Only documents with findings get marks, so only their quotes are listed.
  const cited = new Set(result.findings.flatMap((finding) => finding.evidence.map((e) => e.documentIndex)));
  const citations: Citation[] = [];
  docs.forEach((doc, documentIndex) => {
    const { sourceFile } = doc;
    if (!sourceFile || !cited.has(documentIndex) || (doc.type === "customs_declaration" && doc.sourceKind === "rs_json")) return;
    walkCited(documentSchema, doc, ({ path, field }) => {
      if (field.value !== null && field.quote !== null && field.quote.trim() !== "") citations.push({ sourceFile, documentIndex, path, quote: field.quote, page: field.page });
    });
  });
  return {
    language,
    ui: UI[language],
    readable: result.ok,
    documents: docs.map((d) => ({ id: d.id, type: d.type, label: vocab.doc[d.type], number: d.number.value, sourceFile: d.sourceFile })),
    rulesRun: result.ok ? RULES.length - (result.registry ? 0 : 3) - (docs.some((d) => d.type === "customs_declaration") ? 0 : 6) : 0,
    errors: findings.filter((f) => f.severity === "error"),
    warnings: findings.filter((f) => f.severity === "warning"),
    extractionIssues: result.extractionIssues,
    citations,
    sourceNotes: [...new Set(docs.flatMap((doc) =>
      doc.type === "customs_declaration" && doc.sourceKind === "rs_json"
        ? [`${doc.sourceFile ? doc.sourceFile + ": " : ""}${UI[language].declarationSource}`]
        : []))],
    ...(result.registry ? { registry: registryView(result.registry, language) } : {}),
  };
}

/** "invoice AOS-INV-2026-0918-01 (invoice.pdf), p. 1" */
export function evidenceSource(e: EvidenceView, ui: UiStrings): string {
  const name = [e.document, e.number].filter(Boolean).join(" ");
  const file = e.sourceFile ? ` (${e.sourceFile})` : "";
  const page = e.page !== null ? `, ${ui.page} ${e.page}` : "";
  return `${name}${file}${page}`;
}

/** Where a piece of evidence is and which field it is: "invoice … (invoice.pdf), p. 1 · subtotal". */
export function evidenceHeading(e: EvidenceView, ui: UiStrings): string {
  const source = evidenceSource(e, ui);
  return e.label === null ? source : `${source} · ${e.label}`;
}
