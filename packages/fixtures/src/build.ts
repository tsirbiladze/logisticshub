/** Builds every variant in memory: documents, extraction and the checker's verdict. */
import { checkExtraction, inspectExtraction, SCHEMA_VERSION, type Extraction, type Finding } from "@logisticshub/core";
import { formatter } from "./format.ts";
import { applyLayout, buildDocuments, type Pack, type ShipmentDocuments, type Variant } from "./model.ts";
import { PACKS } from "./packs/index.ts";

export interface BuiltVariant {
  pack: Pack;
  variant: Variant;
  documents: ShipmentDocuments;
  extraction: Extraction;
  findings: Finding[];
  /** Sorted actual vs expected keys; equal when the variant behaves as designed. */
  actualKeys: string[];
  expectedKeys: string[];
  /** Extraction issues of the reference extraction as "CODE path", actual and expected (none, for all but one variant). */
  actualIssues: string[];
  expectedIssues: string[];
}

export function buildVariant(pack: Pack, variant: Variant): BuiltVariant {
  const spec = variant.style ? { ...pack.spec, style: { ...pack.spec.style, ...variant.style } } : pack.spec;
  const documents = buildDocuments(spec);
  variant.mutate?.(documents, formatter(spec.style));
  applyLayout(documents, variant.layout);
  const extraction: Extraction = {
    schemaVersion: SCHEMA_VERSION,
    documents: [documents.invoice, documents.packingList, documents.cmr, documents.contract, ...(documents.secondInvoice ? [documents.secondInvoice] : [])],
  };
  const findings = checkExtraction(extraction);
  return {
    pack,
    variant,
    documents,
    extraction,
    findings,
    actualKeys: findings.map((f) => f.key).sort(),
    expectedKeys: [...variant.expected].sort(),
    actualIssues: inspectExtraction(extraction).issues.map((issue) => `${issue.code} ${issue.path}`).sort(),
    expectedIssues: [...(variant.expectedIssues ?? [])].sort(),
  };
}

export function buildAll(packs: readonly Pack[] = PACKS): BuiltVariant[] {
  return packs.flatMap((pack) => pack.variants.map((variant) => buildVariant(pack, variant)));
}
