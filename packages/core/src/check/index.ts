import type { Cmr, CommercialInvoice, Contract, Extraction, OtherDocument, PackingList } from "../schema.ts";
import { inspectExtraction, parseAndInspect, type ExtractionIssue } from "../validate.ts";
import { beginRun, endRun } from "./helpers.ts";
import { amountInWords, documentTotals, invoiceTotals, lineArithmetic } from "./rules/amounts.ts";
import { companyParties } from "../parties.ts";
import type { RegistrySnapshot } from "../registry.ts";
import { partyTaxIds, taxpayerName, taxpayerVat, taxpayerNotRegistered } from "./rules/tax.ts";
import { hsCodes } from "./rules/hs.ts";
import { checklist } from "./rules/checklist.ts";
import { cmrParticulars } from "./rules/cmr.ts";
import {
  currencies,
  dateOrder,
  grossVsNet,
  incoterms,
  insurance,
  parties,
  quantities,
  references,
  seaTermOnRoad,
  weightsAgree,
} from "./rules/cross.ts";
import { RULE_IDS, type CheckOptions, type Finding, type Rule, type RuleContext } from "./types.ts";

export * from "./types.ts";
export { LEGAL_FORM_PHRASES, LEGAL_FORMS, REF_SEPARATORS } from "./helpers.ts";
export { INCOTERM_NAMES, INCOTERMS_2020, INSURANCE_TITLE, PACKING_KINDS, SEA_ONLY, SELLER_INSURES, UNIT_ALIASES } from "./rules/cross.ts";
export { REQUIRED_DOCUMENTS } from "./rules/checklist.ts";
export { PARTICULARS as CMR_PARTICULARS } from "./rules/cmr.ts";
export {
  CMR_PARTS,
  countDocuments,
  DATE_PARAMS,
  formatDate,
  formatMessage,
  formatNumber,
  MESSAGES,
  MESSAGES_EN,
  pluralCategory,
  REPORT_LANGUAGES,
  VOCAB,
  type MessageKey,
  type Metric,
  NUMBER_PARAMS,
  type NumberKind,
  type PluralForms,
  type ReportLanguage,
  type Role,
} from "./messages.ts";

export const RULES: readonly Rule[] = [
  amountInWords,
  lineArithmetic,
  invoiceTotals,
  documentTotals,
  currencies,
  quantities,
  grossVsNet,
  weightsAgree,
  references,
  dateOrder,
  parties,
  incoterms,
  seaTermOnRoad,
  insurance,
  cmrParticulars,
  checklist,
  hsCodes,
  partyTaxIds,
  taxpayerName,
  taxpayerVat,
  taxpayerNotRegistered,
];

const DEFAULT_OPTIONS: RuleContext["options"] = {
  weightToleranceKg: "0.5",
  volumeToleranceM3: "0.01",
};

function context(extraction: Extraction, options: CheckOptions): RuleContext {
  const docs = extraction.documents;
  return {
    extraction,
    invoices: docs.filter((d): d is CommercialInvoice => d.type === "commercial_invoice"),
    packingLists: docs.filter((d): d is PackingList => d.type === "packing_list"),
    cmrs: docs.filter((d): d is Cmr => d.type === "cmr"),
    contracts: docs.filter((d): d is Contract => d.type === "contract"),
    others: docs.filter((d): d is OtherDocument => d.type === "other"),
    options: { ...DEFAULT_OPTIONS, ...options },
  };
}

function runRules(extraction: Extraction, options: CheckOptions, unusable: ReadonlySet<object>): Finding[] {
  const ctx = context(extraction, options);
  beginRun(extraction, unusable);
  let findings: Finding[];
  try {
    findings = RULES.flatMap((rule) => rule.run(ctx));
  } finally {
    endRun();
  }
  const order = (f: Finding) => (f.severity === "error" ? 0 : 1) * 100 + RULE_IDS.indexOf(f.rule);
  return findings
    .map((finding, index) => ({ finding, index }))
    .sort((a, b) => order(a.finding) - order(b.finding) || a.index - b.index)
    .map(({ finding }) => finding);
}

/**
 * Runs every rule on a valid extraction. Errors first, then warnings, in rule
 * order. Values the extraction check finds unusable (see validate.ts) are
 * left out of every rule.
 */
export function checkExtraction(extraction: Extraction, options: CheckOptions = {}): Finding[] {
  return runRules(extraction, options, inspectExtraction(extraction).unusable);
}

export interface CheckResult {
  /** False when the extraction could not be read at all (see extractionIssues). */
  ok: boolean;
  /** The parsed extraction, or null when it could not be read. */
  extraction: Extraction | null;
  extractionIssues: ExtractionIssue[];
  findings: Finding[];
  registry?: { snapshot: RegistrySnapshot; parties: { code: string; name: string | null }[] };
  summary: { documents: number; errors: number; warnings: number };
}

/** Validates raw extraction JSON, then checks it. Never throws on bad input. */
export function checkDocuments(input: unknown, options: CheckOptions = {}): CheckResult {
  const parsed = parseAndInspect(input);
  if (!parsed.ok) {
    return {
      ok: false, extraction: null, extractionIssues: parsed.issues, findings: [],
      ...(options.registry ? { registry: { snapshot: options.registry, parties: [] } } : {}),
      summary: { documents: 0, errors: 0, warnings: 0 },
    };
  }
  const findings = runRules(parsed.extraction, options, parsed.unusable);
  return {
    ok: true,
    extraction: parsed.extraction,
    extractionIssues: parsed.issues,
    findings,
    ...(options.registry ? { registry: {
      snapshot: options.registry,
      parties: companyParties(parsed.extraction.documents).map(({ code, party }) => ({ code, name: party.name.value })),
    } } : {}),
    summary: {
      documents: parsed.extraction.documents.length,
      errors: findings.filter((f) => f.severity === "error").length,
      warnings: findings.filter((f) => f.severity === "warning").length,
    },
  };
}
