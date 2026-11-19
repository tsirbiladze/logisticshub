import { GEORGIA_COUNTRIES, hsNomenclature, normalizeHsCode } from "../../hs.ts";
import { evidence, isoDate } from "../helpers.ts";
import type { Finding, Rule } from "../types.ts";

const rule = "HS-01";
const georgia = new Set<string>(GEORGIA_COUNTRIES);
const isGeorgia = (value: string | null) => georgia.has(value?.trim().replaceAll("İ", "i").toLowerCase() ?? "");

/** HS-01: check printed invoice codes against the saved Georgian edition. */
export const hsCodes: Rule = {
  id: rule,
  run({ invoices }) {
    const findings: Finding[] = [];
    for (const invoice of invoices) {
      const date = isoDate(invoice.date);
      if (!date || !invoice.lines.some(({ hsCode }) => hsCode.value !== null)) continue;
      if (![invoice.seller, invoice.buyer, invoice.consignee].some(({ country }) => isGeorgia(country.value) && isGeorgia(country.quote))) continue;

      const { edition, byCode, bySubheading } = hsNomenclature();
      if (date < edition.inForceFrom) continue;
      invoice.lines.forEach(({ hsCode }, index) => {
        if (hsCode.value === null) return;
        const code = normalizeHsCode(hsCode.value);
        const line = String(index + 1);
        const subheading = code.slice(0, 6);
        const cited = [evidence(invoice, `lines[${index}].hsCode`, hsCode)];
        if (!/^[0-9]{6,12}$/.test(code) || code !== normalizeHsCode(hsCode.quote ?? "")) {
          findings.push({ rule, severity: "warning", key: "HS-01.unreadable", params: { line }, evidence: cited });
          return;
        }
        const rows = bySubheading.get(subheading);
        if (!rows) {
          const heading = byCode.get(code.slice(0, 4));
          findings.push(heading
            ? { rule, severity: "warning", key: "HS-01.unknown-subheading-heading", params: { line, subheading, heading: heading[0], description: heading[1] }, evidence: cited }
            : { rule, severity: "warning", key: "HS-01.unknown-subheading", params: { line, subheading }, evidence: cited });
          return;
        }
        if (code.length !== 11 || byCode.has(code)) return;
        const alternatives = rows.filter(([digits]) => digits.length === 11).slice(0, 5);
        findings.push({
          rule,
          severity: "error",
          key: "HS-01.unknown-national",
          params: { line, code, subheading, neighbours: alternatives.map(([digits, description]) => `${digits} · ${description}`).join("; ") },
          evidence: cited,
        });
      });
    }
    return findings;
  },
};
