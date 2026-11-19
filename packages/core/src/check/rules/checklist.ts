import type { DocumentType } from "../../schema.ts";
import { evidence } from "../helpers.ts";
import type { Finding, Rule } from "../types.ts";

export const REQUIRED_DOCUMENTS: DocumentType[] = ["commercial_invoice", "packing_list", "cmr"];

/** DOC-01: the basic road-shipment set is complete; duplicates are flagged. */
export const checklist: Rule = {
  id: "DOC-01",
  run({ extraction, declarations }) {
    const findings: Finding[] = [];
    for (const type of REQUIRED_DOCUMENTS) {
      const docs = extraction.documents.filter((d) => d.type === type);
      if (docs.length === 0) {
        findings.push({ rule: "DOC-01", severity: "warning", key: "DOC-01.missing", params: { document: type }, evidence: [] });
      }
    }
    for (const type of ["commercial_invoice", "packing_list", "cmr", "contract", "customs_declaration"] as const) {
      const docs = extraction.documents.filter((d) => d.type === type);
      if (docs.length > 1) {
        findings.push({
          rule: "DOC-01",
          severity: "warning",
          key: type === "commercial_invoice" && declarations.length > 0 ? "DOC-01.multiple-invoices-declaration" : "DOC-01.multiple",
          params: { document: type, count: String(docs.length) },
          evidence: docs.map((d) => evidence(d, "number", d.number)),
        });
      }
    }
    return findings;
  },
};
