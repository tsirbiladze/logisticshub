import { countDocuments, formatMessage, formatNumber } from "../check/messages.ts";
import { registryRows } from "./registry.ts";
import { evidenceHeading, type FindingView, type ReportView } from "./view.ts";

/**
 * Document text inside the Markdown report: whitespace runs (newlines too)
 * become one space and Markdown control characters are escaped, so a quote
 * cannot start a new line, a heading or a fake summary for the agent that
 * reads report.md. Numbers and ordinary text stay as they are.
 */
export function markdownText(text: string): string {
  return text.replace(/\s+/gu, " ").replace(/[\\`*_[\]<>|~]/gu, "\\$&");
}

/**
 * Document text in the report printed to a terminal: on one line, as in
 * report.md, and otherwise as printed. No Markdown escapes: an agent that
 * reads the terminal copies what it sees, backslashes included
 * ("commercial\_invoice"). Without a line break of its own, document text
 * still cannot start a line, a heading or a fake summary.
 */
export function plainText(text: string): string {
  return text.replace(/\s+/gu, " ");
}

type Escape = (text: string) => string;

function findingBlock(f: FindingView, view: ReportView, escape: Escape): string {
  const [open, close] = view.ui.quote;
  const message = formatMessage(f.key, f.params, view.language, escape, f.units);
  const lines = [`### ${f.index}. ${f.rule} · ${f.ruleTitle}`, "", message, ""];
  for (const e of f.evidence) {
    const shown =
      e.quote !== null
        ? `${open}${escape(e.quote)}${close}`
        : e.value === null
          ? "—"
          : e.computed
            ? `${formatNumber(escape(e.value), view.language)} (${view.ui.computed})`
            : escape(e.value);
    lines.push(`- ${escape(evidenceHeading(e, view.ui))}: ${shown}`);
  }
  if (f.evidence.length > 0) lines.push("");
  lines.push(`→ ${f.check}`);
  return lines.join("\n").trimEnd();
}

/**
 * The extraction issues. They stand before the findings: a value with an
 * issue is left out of the rules, so what follows depends on them.
 */
function issuesBlock(view: ReportView, escape: Escape): string[] {
  const { ui } = view;
  const out = [`## ${ui.extractionIssues}`, "", view.readable ? `${ui.extractionIssuesHint} ${ui.extractionIssuesEffect}` : ui.extractionIssuesHint, ""];
  for (const issue of view.extractionIssues) out.push(`- \`${issue.path}\` (${issue.code}): ${escape(issue.message)}`);
  out.push("");
  return out;
}

/** The report as Markdown (report.md). `escape` is what document text goes through; see renderText for the terminal. */
export function renderMarkdown(view: ReportView, escape: Escape = markdownText): string {
  const { ui } = view;
  const out: string[] = [`# ${ui.title}`, ""];
  if (!view.readable) {
    out.push(ui.unreadable, "");
  } else {
    out.push(
      `**${ui.errors}: ${view.errors.length} · ${ui.warnings}: ${view.warnings.length}** · ${ui.checked}: ${countDocuments(view.documents.length, view.language)}, ${view.rulesRun} ${ui.rules}`,
      "",
    );
  }
  if (view.extractionIssues.length > 0) out.push(...issuesBlock(view, escape));
  else if (view.readable) out.push(ui.extractionOk, "");
  if (view.readable) {
    // With extraction issues some values were left out of the rules, so "no problems" would say too much.
    if (view.errors.length === 0 && view.warnings.length === 0 && view.extractionIssues.length === 0) out.push(`✓ ${ui.noProblems}`, "");
    if (view.errors.length > 0) out.push(`## ${ui.errorsHeading}`, "", ...view.errors.map((f) => `${findingBlock(f, view, escape)}\n`));
    if (view.warnings.length > 0) out.push(`## ${ui.warningsHeading}`, "", ...view.warnings.map((f) => `${findingBlock(f, view, escape)}\n`));
  }
  const registry = view.registry;
  if (registry) {
    out.push(`## ${registry.title}`, "", `${registry.source.label}: ${escape(registry.source.value)}`, "");
    for (const entry of registry.entries) {
      out.push(`### ${entry.code}`, "");
      for (const [label, value] of registryRows(registry, entry)) out.push(value ? `- ${label}: ${escape(value)}` : `- ${label}`);
      out.push("");
    }
  }
  out.push(`---`, `${ui.generatedBy}`);
  return `${out.join("\n").trim()}\n`;
}

/**
 * The report as it is printed to a terminal: the layout of report.md with
 * document text as printed, without Markdown escapes (see plainText).
 */
export function renderText(view: ReportView): string {
  return renderMarkdown(view, plainText);
}
