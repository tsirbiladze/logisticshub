import type { CheckResult } from "../check/index.ts";
import type { ReportLanguage } from "../check/messages.ts";
import { renderHtml } from "./html.ts";
import { renderMarkdown } from "./markdown.ts";
import { buildReport, type ReportView } from "./view.ts";

export { checkLine, FIELD_LABELS, KEY_CHECKS, RULE_CHECKS, RULE_DESCRIPTIONS, RULE_SUMMARIES_KA, RULE_TITLES, UI } from "./i18n.ts";
export { EXTRACTION_CHECKS, NOT_CHECKED, RULE_PRINCIPLES, RULE_REFERENCE, type RuleReference } from "./reference.ts";
export { renderHtml, REPORT_CSS } from "./html.ts";
export { markdownText, plainText, renderMarkdown, renderText } from "./markdown.ts";
export { buildReport, evidenceHeading, evidenceSource, fieldLabel, pickLanguage, type Citation, type EvidenceView, type FindingView, type ReportView } from "./view.ts";

export { REGISTRY_LABELS } from "./registry.ts";

export const REPORT_VERSION = "1";

/**
 * Machine-readable report: the raw result plus, per finding, the localized
 * rule title, message and what to check, and per piece of evidence the name
 * of its field ("label"). Extraction issues come before the findings, as in
 * the other two reports.
 */
export function renderJson(result: CheckResult, view: ReportView): string {
  const findings = [...view.errors, ...view.warnings].sort((a, b) => a.index - b.index);
  return `${JSON.stringify(
    {
      reportVersion: REPORT_VERSION,
      language: view.language,
      ok: result.ok,
      summary: result.summary,
      documents: view.documents,
      extractionIssues: result.extractionIssues,
      findings: result.findings.map((finding, i) => ({
        ...finding,
        evidence: finding.evidence.map((e, j) => ({ ...e, label: findings[i]?.evidence[j]?.label ?? null })),
        ruleTitle: findings[i]?.ruleTitle,
        message: findings[i]?.message,
        check: findings[i]?.check,
      })),
      ...(view.registry ? { registry: view.registry } : {}),
    },
    null,
    2,
  )}\n`;
}

export type ReportFormat = "md" | "json" | "html";

/** All three report formats for one result. */
export function renderReports(result: CheckResult, language?: ReportLanguage): Record<ReportFormat, string> {
  const view = buildReport(result, language);
  return { md: renderMarkdown(view), json: renderJson(result, view), html: renderHtml(view) };
}
