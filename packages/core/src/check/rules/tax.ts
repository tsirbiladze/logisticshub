import { companyParties, documentParties, georgianParty, taxDigits } from "../../parties.ts";
import { evidence, nameTokens, num, sameParty, scriptOf, text } from "../helpers.ts";
import type { Finding, Rule, RuleContext } from "../types.ts";

export const partyTaxIds: Rule = {
  id: "PTY-02",
  run({ extraction }) {
    const findings: Finding[] = [];
    const reported = new Map<string, string[]>();
    const seen: { name: string; code: string; citation: Finding["evidence"][number] }[] = [];
    for (const doc of extraction.documents) {
      for (const [role, party] of documentParties(doc)) {
        if (party.taxId.value === null) continue;
        const citation = evidence(doc, `${role}.taxId`, party.taxId);
        const code = taxDigits(party.taxId);
        const name = text(party.name);
        if (!code || (georgianParty(party) && code.length !== 9 && code.length !== 11)) {
          findings.push({ rule: "PTY-02", severity: "warning", key: "PTY-02.unreadable", params: { name: name ?? "" }, evidence: [citation] });
          continue;
        }
        if (!name) continue;
        for (const earlier of seen) {
          if (earlier.code === code || earlier.citation.documentIndex === citation.documentIndex || sameParty(earlier.name, name) !== true) continue;
          const pair = [earlier.code, code].sort().join("/");
          const names = reported.get(pair) ?? [];
          if (names.some((reportedName) => sameParty(reportedName, name) === true)) continue;
          reported.set(pair, [...names, name]);
          const first = earlier.citation;
          findings.push({
            rule: "PTY-02", severity: "error", key: "PTY-02.number",
            params: { name, a: first.quote!, b: citation.quote! }, evidence: [first, citation],
          });
        }
        seen.push({ name, code, citation });
      }
    }
    return findings;
  },
};

function registryParties({ extraction, options }: RuleContext) {
  if (!options.registry) return [];
  const entries = new Map(options.registry.entries.map((entry) => [entry.code, entry]));
  return companyParties(extraction.documents).flatMap((side) => {
    const entry = entries.get(side.code);
    return entry ? [{ ...side, entry }] : [];
  });
}

export const taxpayerName: Rule = {
  id: "TAX-01",
  run(ctx) {
    const seen = new Set<string>();
    return registryParties(ctx).flatMap(({ doc, role, party, code, entry }): Finding[] => {
      // A reply with several rows does not identify which name belongs in the comparison.
      const registered = "answer" in entry && entry.answer.length === 1 ? entry.answer[0]!.FullName : null;
      const printed = text(party.name);
      if (!registered || !printed) return [];
      const a = nameTokens(printed).join(" ");
      const b = nameTokens(registered).join(" ");
      if (scriptOf(a) === "other" || scriptOf(a) !== scriptOf(b)) return [];
      const key = `${code}/${a}`;
      if (!a || !b || a === b || seen.has(key)) return [];
      seen.add(key);
      return [{
        rule: "TAX-01", severity: "warning", key: "TAX-01.name",
        params: { printed, registered, snapshotDate: entry.checkedAt.slice(0, 10) },
        evidence: [evidence(doc, `${role}.name`, party.name), evidence(doc, `${role}.taxId`, party.taxId)],
      }];
    });
  },
};

export const taxpayerVat: Rule = {
  id: "TAX-02",
  run(ctx) {
    return registryParties(ctx).flatMap(({ doc, role, party, entry }): Finding[] => {
      if (doc.type !== "commercial_invoice" || role !== "seller" || num(doc.tax) === null ||
          !("answer" in entry) || !entry.answer.length || !entry.answer.every((row) => row.VatPayer === "არა")) return [];
      return [{
        rule: "TAX-02", severity: "warning", key: "TAX-02.vat",
        params: { code: entry.code, checkedAt: entry.checkedAt },
        evidence: [evidence(doc, "seller.taxId", party.taxId), evidence(doc, "tax", doc.tax)],
      }];
    });
  },
};

export const taxpayerNotRegistered: Rule = {
  id: "TAX-03",
  run(ctx) {
    const seen = new Set<string>();
    return registryParties(ctx).flatMap(({ doc, role, party, code, entry }): Finding[] => {
      if (!("error" in entry) || !("Status" in entry.error) || entry.error.Status !== -1 || seen.has(code)) return [];
      seen.add(code);
      return [{
        rule: "TAX-03", severity: "warning", key: "TAX-03.reply",
        params: { code, reply: entry.error.Message },
        evidence: [evidence(doc, `${role}.taxId`, party.taxId)],
      }];
    });
  },
};
