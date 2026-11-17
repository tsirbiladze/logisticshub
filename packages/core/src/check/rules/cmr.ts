/**
 * CMR-01: particulars required by CMR Convention Art. 6(1)(a)-(k).
 * Missing (b)-(h) is an error (Art. 7(1) makes most of them the sender's
 * responsibility); missing (a), (i), (j), (k) is a warning.
 */
import type { Cmr } from "../../schema.ts";
import { evidence } from "../helpers.ts";
import type { Finding, Rule, Severity } from "../types.ts";

type Particular = {
  item: string;
  severity: Severity;
  /** Field paths that are missing, empty when the particular is present. */
  missing: (cmr: Cmr) => string[];
};

const filled = (value: string | null) => Boolean(value && value.trim());

function missingFields(checks: [string, string | null][]): string[] {
  return checks.filter(([, value]) => !filled(value)).map(([path]) => path);
}

export const PARTICULARS: Particular[] = [
  {
    item: "a",
    severity: "warning",
    missing: (c) => missingFields([["date", c.date.value], ["placeOfIssue", c.placeOfIssue.value]]),
  },
  {
    item: "b",
    severity: "error",
    missing: (c) => missingFields([["sender.name", c.sender.name.value], ["sender.address", c.sender.address.value]]),
  },
  {
    item: "c",
    severity: "error",
    missing: (c) => missingFields([["carrier.name", c.carrier.name.value], ["carrier.address", c.carrier.address.value]]),
  },
  {
    item: "d",
    severity: "error",
    missing: (c) =>
      missingFields([
        ["placeOfTakingOver", c.placeOfTakingOver.value],
        ["dateOfTakingOver", c.dateOfTakingOver.value],
        ["placeOfDelivery", c.placeOfDelivery.value],
      ]),
  },
  {
    item: "e",
    severity: "error",
    missing: (c) => missingFields([["consignee.name", c.consignee.name.value], ["consignee.address", c.consignee.address.value]]),
  },
  {
    item: "f",
    severity: "error",
    missing: (c) =>
      c.goods.length === 0
        ? ["goods"]
        : c.goods.flatMap((g, i) =>
            missingFields([[`goods[${i}].description`, g.description.value], [`goods[${i}].packingMethod`, g.packingMethod.value]]),
          ),
  },
  {
    item: "g",
    severity: "error",
    missing: (c) => {
      const packages = filled(c.totalPackages.value) || (c.goods.length > 0 && c.goods.every((g) => filled(g.packages.value)));
      const marks = c.goods.some((g) => filled(g.marksAndNumbers.value));
      return [...(packages ? [] : ["totalPackages"]), ...(marks ? [] : ["goods[*].marksAndNumbers"])];
    },
  },
  {
    item: "h",
    severity: "error",
    missing: (c) =>
      filled(c.totalGrossWeightKg.value) || (c.goods.length > 0 && c.goods.every((g) => filled(g.grossWeightKg.value)))
        ? []
        : ["totalGrossWeightKg"],
  },
  {
    item: "i",
    severity: "warning",
    missing: (c) => missingFields([["carriageCharges", c.carriageCharges.value]]),
  },
  {
    item: "j",
    severity: "warning",
    missing: (c) => missingFields([["customsInstructions", c.customsInstructions.value]]),
  },
  {
    item: "k",
    severity: "warning",
    missing: (c) => missingFields([["convention", c.convention.value]]),
  },
];

export const cmrParticulars: Rule = {
  id: "CMR-01",
  run({ cmrs }) {
    const findings: Finding[] = [];
    for (const cmr of cmrs) {
      for (const p of PARTICULARS) {
        const missing = p.missing(cmr);
        if (missing.length === 0) continue;
        findings.push({
          rule: "CMR-01",
          severity: p.severity,
          key: "CMR-01.missing",
          params: { item: p.item, fields: missing.join(", ") },
          // The document itself is the evidence; point at its number.
          evidence: [evidence(cmr, "number", cmr.number)],
        });
      }
    }
    return findings;
  },
};

