import type {
  Cmr,
  CommercialInvoice,
  Contract,
  DocumentType,
  Extraction,
  OtherDocument,
  PackingList,
} from "../schema.ts";
import type { MessageKey } from "./messages.ts";

export type Severity = "error" | "warning";

export const RULE_IDS = [
  "AMT-01",
  "SUM-01",
  "SUM-02",
  "SUM-03",
  "CUR-01",
  "QTY-01",
  "WGT-01",
  "WGT-02",
  "REF-01",
  "DATE-01",
  "PTY-01",
  "INC-01",
  "INC-02",
  "INC-03",
  "CMR-01",
  "DOC-01",
] as const;
export type RuleId = (typeof RULE_IDS)[number];

/** Where a finding comes from: one cited field of one document. */
export interface Evidence {
  documentId: string;
  /** Position of the document in `documents`. Ids should be unique, positions always are. */
  documentIndex: number;
  documentType: DocumentType;
  /** Field path inside the document, e.g. "lines[0].lineTotal". */
  path: string;
  value: string | null;
  quote: string | null;
  page: number | null;
  /** Present when the value is a sum of lines worked out by the checker, not a printed figure. */
  computed?: true;
}

export interface Finding {
  rule: RuleId;
  severity: Severity;
  /** Message template key; text is rendered per language. */
  key: MessageKey;
  params: Record<string, string>;
  /**
   * The currency (ISO 4217) of a money param, by param name, where the rule
   * knows it: { expected: "EUR", found: "EUR" }. Only the message uses it;
   * the params stay canonical decimals.
   */
  units?: Record<string, string>;
  evidence: Evidence[];
}

export interface CheckOptions {
  /** Allowed difference between weights of the same goods on different documents. Default "0.5". */
  weightToleranceKg?: string;
  /** Allowed difference between volumes. Default "0.01". */
  volumeToleranceM3?: string;
}

export interface RuleContext {
  extraction: Extraction;
  invoices: CommercialInvoice[];
  packingLists: PackingList[];
  cmrs: Cmr[];
  contracts: Contract[];
  others: OtherDocument[];
  options: Required<CheckOptions>;
}

export interface Rule {
  id: RuleId;
  run(context: RuleContext): Finding[];
}
