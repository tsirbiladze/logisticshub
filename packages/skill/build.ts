/**
 * Builds the installable skill into <repo>/skills/logisticshub:
 *   SKILL.md, scripts/check.mjs (single file, no dependencies) and
 *   scripts/THIRD-PARTY-NOTICES.txt (licenses of what check.mjs bundles),
 *   scripts/check.py + check-data.json (Python port),
 *   scripts/hs-nomenclature.json.gz (shared by Node and Python),
 *   references/extraction.md, extraction-schema.json, extraction-blank.json,
 *   references/issues.md, rules.md
 * The output is committed so `npx skills add` works without a build.
 */
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  CMR_PARTICULARS,
  CMR_PARTS,
  CURRENCY_CODES,
  CURRENCY_SIGNS,
  DATE_PARAMS,
  DECLARATION_GUIDE,
  EXTRACTION_CHECKS,
  EXTRACTION_GUIDE,
  FIELD_LABELS,
  extractionBlank,
  extractionJsonSchema,
  INCOTERMS_2020,
  INSURANCE_TITLE,
  ISSUES_GUIDE,
  KEY_CHECKS,
  LEGAL_FORMS,
  LEXICONS,
  MESSAGES,
  MONTH_WORDS,
  NOT_CHECKED,
  NUMBER_PARAMS,
  REF_SEPARATORS,
  REPORT_CSS,
  REPORT_LANGUAGES,
  REPORT_VERSION,
  REQUIRED_DOCUMENTS,
  RULE_CHECKS,
  RULE_DESCRIPTIONS,
  RULE_IDS,
  RULE_PRINCIPLES,
  RULE_REFERENCE,
  RULE_TITLES,
  REGISTRY_FIELDS,
  REGISTRY_LABELS,
  REGISTRY_SOURCE,
  REGISTRY_VERSION,
  SCHEMA_VERSION,
  SEA_ONLY,
  SELLER_INSURES,
  UI,
  UNIT_ALIASES,
  VOCAB,
} from "@logisticshub/core";
import { RS_FIELDS } from "../core/src/declaration.ts";
import { COUNTRIES } from "../core/src/check/rules/declaration.ts";
import { GEORGIA_COUNTRIES, HS_LOOKUP_LIMIT } from "../core/src/hs.ts";
import { thirdPartyNotices } from "../cli/notices.ts";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const OUT = here("../../skills/logisticshub/");
const version = JSON.parse(readFileSync(here("package.json"), "utf8")).version as string;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(`${OUT}scripts`, { recursive: true });
mkdirSync(`${OUT}references`, { recursive: true });

const { metafile } = await build({
  entryPoints: [here("src/cli.ts")],
  outfile: `${OUT}scripts/check.mjs`,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: true,
  metafile: true,
  // Licenses go into scripts/THIRD-PARTY-NOTICES.txt, in full.
  legalComments: "none",
  define: { __VERSION__: JSON.stringify(version) },
  banner: {
    js: `// Logisticshub ${version}: cross-check trade documents. MIT License. Bundles zod, pdf-lib and unpdf/pdf.js; their licenses are in THIRD-PARTY-NOTICES.txt. Runs on Node.js 22+ without install.\nimport { createRequire as __lhCreateRequire } from "node:module"; const require = __lhCreateRequire(import.meta.url);`,
  },
});

writeFileSync(`${OUT}scripts/THIRD-PARTY-NOTICES.txt`, thirdPartyNotices(metafile, `Logisticshub ${version} (scripts/check.mjs)`));
copyFileSync(here("../core/src/hs-nomenclature.json.gz"), `${OUT}scripts/hs-nomenclature.json.gz`);
copyFileSync(here("SKILL.md"), `${OUT}SKILL.md`);

// Python port (claude.ai / Claude API, no Node): logic in check.py, every text
// and constant from the same TypeScript sources via check-data.json.
copyFileSync(here("python/check.py"), `${OUT}scripts/check.py`);
const lexicons = Object.fromEntries(
  Object.entries(LEXICONS).map(([lang, lex]) => [
    lang,
    { ...lex, numbers: Object.fromEntries(Object.entries(lex.numbers).map(([w, n]) => [w, { value: Number(n.value), role: n.role }])) },
  ]),
);
const data = {
  version,
  georgiaCountries: GEORGIA_COUNTRIES,
  countries: COUNTRIES,
  rsFields: RS_FIELDS,
  hsLookupLimit: HS_LOOKUP_LIMIT,
  schemaVersion: SCHEMA_VERSION,
  reportVersion: REPORT_VERSION,
  languages: REPORT_LANGUAGES,
  ruleIds: RULE_IDS,
  ruleTitles: RULE_TITLES,
  registryFields: REGISTRY_FIELDS,
  registryLabels: REGISTRY_LABELS,
  registrySource: REGISTRY_SOURCE,
  registryVersion: REGISTRY_VERSION,
  ruleChecks: RULE_CHECKS,
  keyChecks: KEY_CHECKS,
  fieldLabels: FIELD_LABELS,
  messages: MESSAGES,
  dateParams: DATE_PARAMS,
  numberParams: NUMBER_PARAMS,
  cmrParts: CMR_PARTS,
  vocab: VOCAB,
  ui: UI,
  lexicons,
  legalForms: [...LEGAL_FORMS],
  refSeparators: REF_SEPARATORS,
  incoterms2020: [...INCOTERMS_2020],
  seaOnly: [...SEA_ONLY],
  sellerInsures: [...SELLER_INSURES],
  insuranceTitle: { source: INSURANCE_TITLE.source, flags: INSURANCE_TITLE.flags },
  requiredDocuments: REQUIRED_DOCUMENTS,
  unitAliases: UNIT_ALIASES,
  monthWords: MONTH_WORDS,
  currencyCodes: CURRENCY_CODES,
  currencySigns: CURRENCY_SIGNS,
  cmrSeverity: Object.fromEntries(CMR_PARTICULARS.map((p) => [p.item, p.severity])),
  reportCss: REPORT_CSS,
};
writeFileSync(`${OUT}scripts/check-data.json`, `${JSON.stringify(data, null, 2)}\n`);
writeFileSync(`${OUT}references/extraction.md`, EXTRACTION_GUIDE);
writeFileSync(`${OUT}references/issues.md`, ISSUES_GUIDE);
writeFileSync(`${OUT}references/declaration.md`, DECLARATION_GUIDE);
writeFileSync(`${OUT}references/extraction-schema.json`, `${JSON.stringify(extractionJsonSchema(), null, 2)}\n`);
writeFileSync(`${OUT}references/extraction-blank.json`, `${blankJson(extractionBlank())}\n`);

/**
 * The blank as an agent reads and copies it: indented like JSON.stringify
 * does, but with a fact ({ "value": null, "quote": null, "page": null }) on
 * one line. Spread over five lines each, the facts made the file four times
 * as long and hid which keys a document has.
 */
function blankJson(value: unknown, indent = ""): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const inner = `${indent}  `;
  if (Array.isArray(value)) return value.length === 0 ? "[]" : `[\n${value.map((item) => `${inner}${blankJson(item, inner)}`).join(",\n")}\n${indent}]`;
  const entries = Object.entries(value);
  if (entries.length === 0) return "{}";
  const flat = entries.every(([, held]) => held === null || typeof held !== "object");
  if (flat && indent !== "") return `{ ${entries.map(([key, held]) => `${JSON.stringify(key)}: ${JSON.stringify(held)}`).join(", ")} }`;
  return `{\n${entries.map(([key, held]) => `${inner}${JSON.stringify(key)}: ${blankJson(held, inner)}`).join(",\n")}\n${indent}}`;
}

// references/rules.md: the exact statement of each rule, from RULE_REFERENCE.
const cell = (text: string) => text.replaceAll("|", "\\|");
const ruleSections = RULE_IDS.map((id) => {
  const rule = RULE_REFERENCE[id];
  const findings = rule.findings.map((f) => `| \`${f.key}\` | ${f.severity} | ${cell(f.when)} |`);
  return [
    `### ${id} · ${RULE_TITLES.en[id]}`,
    "",
    RULE_DESCRIPTIONS[id],
    "",
    `- **Reads:** ${rule.reads}`,
    `- **Tolerance:** ${rule.tolerance}`,
    ...(rule.details ?? []).map((line) => `- ${line}`),
    "",
    "| Finding | Severity | Reported when |",
    "|---|---|---|",
    ...findings,
    "",
    "Not reported:",
    "",
    ...rule.silent.map((line) => `- ${line}`),
  ].join("\n");
});
writeFileSync(
  `${OUT}references/rules.md`,
  `# Rules

\`scripts/check.mjs\` (and \`check.py\`) applies these ${RULE_IDS.length} rules to the extraction. This page states each rule exactly: what it reads, every finding it can report with its severity, its tolerance, and when it reports nothing. The last section lists what is not checked at all.

## How every rule works

${RULE_PRINCIPLES.map((line) => `- ${line}`).join("\n")}

## Before the rules: the extraction check

The checker first checks the extraction itself and lists what it finds as extraction issues, before the findings: a wrong shape or schema version (\`EXT_SHAPE\`: no rule runs, exit code 1), a number, date or currency in the wrong format, a value that is not a reading of its own quote (\`EXT_QUOTE_MISMATCH\`), a percentage where an amount belongs (\`EXT_PERCENTAGE\`), a value without a quote, a page below 1, a duplicate id. The codes and how to fix each are in \`issues.md\`.

A value is held against its own quote in these ways. Each speaks only where the quote can be read beyond doubt, and is silent otherwise:

${EXTRACTION_CHECKS.map((line) => `- ${line}`).join("\n")}

\`check.mjs\` also looks every quote up in the text of its PDF page and lists the ones it does not find under \`Notes:\`; \`check.py\` does not read the PDFs.

## The rules

${ruleSections.join("\n\n")}

## Not checked

${NOT_CHECKED.map((line) => `- ${line}`).join("\n")}
`,
);

console.log(`✓ skill ${version} built → ${OUT}`);
