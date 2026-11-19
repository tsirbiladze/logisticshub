/**
 * Self-contained HTML report: one file, no external requests, printable.
 * Visual language follows the Logisticshub site (black type, red accent,
 * light technical grid).
 */
import { formatNumber } from "../check/messages.ts";
import { registryRows } from "./registry.ts";
import { evidenceSource, type FindingView, type ReportView } from "./view.ts";

const esc = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const REPORT_CSS = `
:root { --ink: #111214; --muted: #5d616b; --line: #cfd1d6; --paper: #ececea; --card: #f7f7f5; --red: #e1251b; --amber: #8a5a00; }
@media (prefers-color-scheme: dark) { :root { --ink: #ededeb; --muted: #a2a5ad; --line: #3a3c42; --paper: #141518; --card: #1c1d21; --red: #ff4d42; --amber: #e0a63a; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--ink); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", "Noto Sans", "Noto Sans Georgian", sans-serif;
  --grid: color-mix(in srgb, var(--line) 45%, transparent);
  background-image: linear-gradient(var(--grid) 1px, transparent 1px), linear-gradient(90deg, var(--grid) 1px, transparent 1px); background-size: 48px 48px; background-position: -1px -1px; }
main { max-width: 860px; margin: 0 auto; padding: 40px 20px 56px; }
.brand { font-weight: 800; letter-spacing: .04em; font-size: 13px; text-transform: uppercase; }
.brand b { color: var(--red); }
h1 { font-size: clamp(28px, 5vw, 44px); line-height: 1.05; margin: 10px 0 18px; letter-spacing: -.02em; }
.summary { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 28px; }
.stat { background: var(--card); border: 1px solid var(--line); padding: 10px 14px; min-width: 120px; }
.stat strong { display: block; font-size: 28px; line-height: 1.1; }
.stat.err strong { color: var(--red); }
.stat.warn strong { color: var(--amber); }
.stat span { color: var(--muted); font-size: 13px; }
.ok { background: var(--card); border: 1px solid var(--line); border-left: 4px solid var(--ink); padding: 14px 16px; font-weight: 600; }
.note { color: var(--muted); font-size: 13px; margin: -14px 0 24px; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin: 30px 0 10px; }
h2:lang(ka) { text-transform: none; letter-spacing: 0; font-size: 14px; }
.finding { background: var(--card); border: 1px solid var(--line); border-left: 4px solid var(--red); padding: 14px 16px; margin-bottom: 10px; }
.finding.warning { border-left-color: var(--amber); }
.rule { font-size: 12px; color: var(--muted); letter-spacing: .03em; }
.rule b { color: var(--ink); }
.message { font-size: 16px; font-weight: 600; margin: 4px 0 10px; }
ul { list-style: none; padding: 0; margin: 0; }
li { border-top: 1px dashed var(--line); padding: 7px 0 0; margin-top: 7px; font-size: 14px; }
.src { color: var(--muted); font-size: 12.5px; display: block; }
.field { font-weight: 600; }
q { quotes: none; font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace; font-size: 13.5px; background: color-mix(in srgb, var(--red) 9%, transparent); padding: 1px 4px; }
.check { margin: 10px 0 0; font-size: 14px; color: var(--muted); }
.issues li { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 13px; }
.issues-hint { margin: 0 0 4px; font-size: 14px; }
footer { margin-top: 36px; color: var(--muted); font-size: 12.5px; }
@media print { body { background: #fff; } .finding, .stat, .ok { break-inside: avoid; } }
`;

function finding(f: FindingView, view: ReportView): string {
  const items = f.evidence
    .map((e) => {
      const shown =
        e.quote !== null
          ? `<q>${esc(e.quote)}</q>`
          : e.value === null
            ? "—"
            : e.computed
              ? `${esc(formatNumber(e.value, view.language))} <span class="src">${esc(view.ui.computed)}</span>`
              : esc(e.value);
      const field = e.label === null ? "" : `<span class="field">${esc(e.label)}:</span> `;
      return `<li><span class="src">${esc(evidenceSource(e, view.ui))}</span>${field}${shown}</li>`;
    })
    .join("");
  const label = f.severity === "error" ? view.ui.error : view.ui.warning;
  return `<article class="finding ${f.severity}">
  <div class="rule">${esc(label)} · <b>${esc(f.rule)}</b> · ${esc(f.ruleTitle)}</div>
  <div class="message">${esc(f.message)}</div>
  ${items ? `<ul>${items}</ul>` : ""}
  <p class="check">→ ${esc(f.check)}</p>
</article>`;
}

export function renderHtml(view: ReportView): string {
  const { ui } = view;
  const body: string[] = [];
  if (!view.readable) {
    body.push(`<p class="ok">${esc(ui.unreadable)}</p>`);
  } else {
    body.push(`<div class="summary">
  <div class="stat err"><strong>${view.errors.length}</strong><span>${esc(ui.errors)}</span></div>
  <div class="stat warn"><strong>${view.warnings.length}</strong><span>${esc(ui.warnings)}</span></div>
  <div class="stat"><strong>${view.documents.length}</strong><span>${esc(ui.documents)}</span></div>
  <div class="stat"><strong>${view.rulesRun}</strong><span>${esc(ui.rules)}</span></div>
</div>`);
  }
  // Before the findings: a value with an issue is left out of the rules, so what follows depends on them.
  if (view.extractionIssues.length > 0) {
    const hint = view.readable ? `${ui.extractionIssuesHint} ${ui.extractionIssuesEffect}` : ui.extractionIssuesHint;
    body.push(
      `<h2>${esc(ui.extractionIssues)}</h2><p class="issues-hint">${esc(hint)}</p><ul class="issues">${view.extractionIssues
        .map((i) => `<li>${esc(i.path)} · ${esc(i.code)} · ${esc(i.message)}</li>`)
        .join("")}</ul>`,
    );
  } else if (view.readable) {
    body.push(`<p class="note">${esc(ui.extractionOk)}</p>`);
  }
  if (view.readable) {
    // With extraction issues some values were left out of the rules, so "no problems" would say too much.
    if (view.errors.length === 0 && view.warnings.length === 0 && view.extractionIssues.length === 0) body.push(`<p class="ok">✓ ${esc(ui.noProblems)}</p>`);
    if (view.errors.length > 0) body.push(`<h2>${esc(ui.errorsHeading)}</h2>`, ...view.errors.map((f) => finding(f, view)));
    if (view.warnings.length > 0) body.push(`<h2>${esc(ui.warningsHeading)}</h2>`, ...view.warnings.map((f) => finding(f, view)));
  }
  const registry = view.registry;
  if (registry) {
    body.push(`<h2>${esc(registry.title)}</h2><p>${esc(registry.source.label)}: ${esc(registry.source.value)}</p>`);
    for (const entry of registry.entries) {
      const rows = registryRows(registry, entry).map(([label, value]) => value
        ? `<li>${esc(label)}: <span style="white-space: pre-wrap">${esc(value)}</span></li>`
        : `<li>${esc(label)}</li>`).join("");
      body.push(`<h3>${entry.code}</h3><ul>${rows}</ul>`);
    }
  }
  return `<!doctype html>
<html lang="${view.language}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(ui.title)} · Logisticshub</title><style>${REPORT_CSS}</style></head>
<body><main>
<div class="brand">Logistics<b>hub</b></div>
<h1>${esc(ui.title)}</h1>
${body.join("\n")}
<footer>${esc(ui.generatedBy)}</footer>
</main></body></html>
`;
}
