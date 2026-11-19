import { equals } from "../../decimal.ts";
import { hsNomenclature, normalizeHsCode } from "../../hs.ts";
import { taxDigits } from "../../parties.ts";
import type { CitedDecimal, CitedText, CustomsDeclaration, DeclarationItem } from "../../schema.ts";
import { citedWrittenText, currencyCode, evidence, foldName, isoDate, num, quoted, sameParty, sameWithin, scriptOf, show, sumAll } from "../helpers.ts";
import type { Finding, Rule } from "../types.ts";
import { cite, observe, packageCounts, packingKind, statedOrSum } from "./cross.ts";

/** Fixed list for exact name/code matches, with aliases in the four report languages. */
export const COUNTRIES: Record<string, string[]> = {
  AM: ["Armenia", "სომხეთი", "Армения", "Ermenistan"],
  AZ: ["Azerbaijan", "აზერბაიჯანი", "Азербайджан", "Azerbaycan"],
  BG: ["Bulgaria", "ბულგარეთი", "Болгария", "Bulgaristan"],
  CN: ["China", "ჩინეთი", "Китай", "Çin"],
  DE: ["Germany", "გერმანია", "Германия", "Almanya"],
  FR: ["France", "საფრანგეთი", "Франция", "Fransa"],
  GB: ["United Kingdom", "გაერთიანებული სამეფო", "Великобритания", "Birleşik Krallık"],
  GE: ["Georgia", "საქართველო", "Грузия", "Gürcistan"],
  IL: ["Israel", "ისრაელი", "Израиль", "İsrail"],
  IN: ["India", "ინდოეთი", "Индия", "Hindistan"],
  IR: ["Iran", "ირანი", "Иран", "İran"],
  IT: ["Italy", "იტალია", "Италия", "İtalya"],
  JP: ["Japan", "იაპონია", "Япония", "Japonya"],
  KG: ["Kyrgyzstan", "ყირგიზეთი", "Киргизия", "Кыргызстан", "Kırgızistan"],
  KZ: ["Kazakhstan", "ყაზახეთი", "Казахстан", "Kazakistan"],
  NL: ["Netherlands", "ნიდერლანდები", "Нидерланды", "Hollanda"],
  PL: ["Poland", "პოლონეთი", "Польша", "Polonya"],
  RO: ["Romania", "რუმინეთი", "Румыния", "Romanya"],
  RU: ["Russia", "რუსეთი", "Россия", "Rusya"],
  TR: ["Turkey", "Türkiye", "თურქეთი", "Турция"],
  UA: ["Ukraine", "უკრაინა", "Украина", "Ukrayna"],
  US: ["United States", "United States of America", "USA", "აშშ", "США", "Amerika Birleşik Devletleri", "ABD"],
  UZ: ["Uzbekistan", "უზბეკეთი", "Узбекистан", "Özbekistan"],
};

const COUNTRY_CODES = new Map(Object.entries(COUNTRIES).flatMap(([code, names]) =>
  [code, ...names].map((name) => [foldName(name).trim(), code] as const)));

const decParties: Rule = {
  id: "DEC-01",
  run({ invoices: [invoice], declarations: [declaration] }) {
    if (!invoice || !declaration) return [];
    const findings: Finding[] = [];
    for (const [aRole, bRole] of [["seller", "exporter"], ["buyer", "importer"]] as const) {
      const a = invoice[aRole];
      const b = declaration[bRole];
      const key = a.taxId.value !== null && b.taxId.value !== null ? "taxId" : "name";
      const aValue = key === "taxId" ? taxDigits(a.taxId) : citedWrittenText(a.name);
      const bValue = key === "taxId" ? taxDigits(b.taxId, declaration.sourceKind === "rs_json") : citedWrittenText(b.name);
      if (!aValue || !bValue || !quoted(a[key]) || !quoted(b[key])) continue;
      if (key === "taxId" ? aValue === bValue : (scriptOf(aValue) === "other" || sameParty(aValue, bValue) !== false)) continue;
      findings.push({
        rule: "DEC-01", severity: "error", key: key === "taxId" ? "DEC-01.tax-id" : "DEC-01.name",
        params: { role: aRole, invoice: aValue, declaration: bValue },
        evidence: [evidence(invoice, `${aRole}.${key}`, a[key]), evidence(declaration, `${bRole}.${key}`, b[key])],
      });
    }
    return findings;
  },
};

function usableCode(field: CitedText, pattern: RegExp): string | null {
  if (!quoted(field) || field.value === null) return null;
  const code = normalizeHsCode(field.value);
  return pattern.test(code) && code === normalizeHsCode(field.quote!) ? code : null;
}

const itemNumber = (item: DeclarationItem, i: number) =>
  quoted(item.itemNumber) ? item.itemNumber.value ?? String(i + 1) : String(i + 1);

const decCodes: Rule = {
  id: "DEC-02",
  run({ invoices, declarations }) {
    const findings: Finding[] = [];
    for (const declaration of declarations) {
      const date = quoted(declaration.date) && isoDate(declaration.date);
      if (!date || !declaration.items.some((item) => item.hsCode.value !== null)) continue;
      const { edition, byCode, bySubheading } = hsNomenclature();
      if (date < edition.inForceFrom) continue;
      declaration.items.forEach((item, i) => {
        if (item.hsCode.value === null) return;
        const line = itemNumber(item, i);
        const cited = [evidence(declaration, `items[${i}].hsCode`, item.hsCode)];
        const code = usableCode(item.hsCode, /^[0-9]{11}$/);
        if (!code) {
          findings.push({ rule: "DEC-02", severity: "warning", key: "DEC-02.unreadable", params: { line }, evidence: cited });
          return;
        }
        if (byCode.has(code)) return;
        const subheading = code.slice(0, 6);
        const neighbours = (bySubheading.get(subheading) ?? []).filter(([digits]) => digits.length === 11).slice(0, 5)
          .map(([digits, description]) => `${digits} · ${description}`).join("; ");
        const heading = byCode.get(code.slice(0, 4));
        findings.push({
          rule: "DEC-02", severity: "error",
          key: neighbours ? "DEC-02.unknown-national" : heading ? "DEC-02.unknown-national-heading" : "DEC-02.unknown-national-alone",
          params: { line, code, subheading, neighbours, heading: heading?.[0] ?? "", description: heading?.[1] ?? "" }, evidence: cited,
        });
      });
    }

    const [declaration] = declarations;
    if (!declaration || !invoices.length || invoices.some((invoice) => !invoice.lines.length) || !declaration.items.length) return findings;
    const printed = (field: CitedText) => usableCode(field, /^[0-9]{6,12}$/);
    const lines = invoices.flatMap((invoice) => invoice.lines.map((line, i) => ({
      code: printed(line.hsCode), label: String(i + 1), cite: evidence(invoice, `lines[${i}].hsCode`, line.hsCode),
    })));
    const items = declaration.items.map((item, i) => ({
      code: printed(item.hsCode), label: itemNumber(item, i), cite: evidence(declaration, `items[${i}].hsCode`, item.hsCode),
    }));
    if ([...lines, ...items].some(({ code }) => !code)) return findings;
    for (const [side, other, key] of [[lines, items, "DEC-02.invoice-prefix"], [items, lines, "DEC-02.declaration-prefix"]] as const) {
      const prefixes = new Set(other.map(({ code }) => code!.slice(0, 6)));
      for (const { code, label, cite } of side) {
        if (!prefixes.has(code!.slice(0, 6))) {
          findings.push({ rule: "DEC-02", severity: "warning", key, params: { code: code!, line: label }, evidence: [cite] });
        }
      }
    }
    return findings;
  },
};

function quotedSum(declaration: CustomsDeclaration, key: "grossWeightKg" | "netWeightKg" | "invoiceValue") {
  if (!declaration.items.every((item) => quoted(item[key]))) return null;
  return statedOrSum(declaration, "", undefined, declaration.items, "items", (item) => item[key]);
}

function itemEvidence(declaration: CustomsDeclaration, key: keyof DeclarationItem) {
  return declaration.items.map((item, i) => evidence(declaration, `items[${i}].${key}`, item[key]));
}

const decWeights: Rule = {
  id: "DEC-03",
  run({ invoices: [invoice], packingLists: [pl], cmrs: [cmr], declarations: [declaration], options }) {
    if (!declaration) return [];
    const findings: Finding[] = [];
    for (const [key, total, sources] of [
      ["DEC-03.gross", "grossWeightKg", [observe(pl, "totalGrossWeightKg", pl?.totalGrossWeightKg), observe(cmr, "totalGrossWeightKg", cmr?.totalGrossWeightKg), observe(invoice, "grossWeightKg", invoice?.grossWeightKg)]],
      ["DEC-03.net", "netWeightKg", [observe(pl, "totalNetWeightKg", pl?.totalNetWeightKg), observe(invoice, "netWeightKg", invoice?.netWeightKg)]],
    ] as const) {
      const expected = sources.find((source) => source && quoted(source.field));
      const actual = quotedSum(declaration, total);
      if (!expected || !actual || sameWithin(expected.value, actual.value, options.weightToleranceKg)) continue;
      findings.push({
        rule: "DEC-03", severity: "error", key,
        params: { expected: expected.field.value!, found: actual.field.value!, document: expected.doc.type },
        evidence: [cite(actual), ...itemEvidence(declaration, total), cite(expected)],
      });
    }
    return findings;
  },
};

const decPackages: Rule = {
  id: "DEC-04",
  run({ invoices: [invoice], packingLists: [pl], cmrs: [cmr], declarations: [declaration] }) {
    if (!declaration || !quoted(declaration.totalPackages)) return [];
    const actual = observe(declaration, "totalPackages", declaration.totalPackages);
    if (!actual) return [];
    const [inv, packing, road] = packageCounts(invoice, pl, cmr);
    const counts = [packing, road, inv].flatMap((entry) => {
      const [observed, method] = entry;
      if (!observed) return [];
      const supported = observed.computed
        ? (observed.doc.type === "packing_list" ? observed.doc.lines : cmr?.goods)?.every((line) => quoted(line.packages))
        : quoted(observed.field);
      return supported ? [{ observed, method }] : [];
    });
    const first = counts[0];
    if (!first) return [];
    const { observed: expected, method: kind } = first;
    const actualKind = packingKind([declaration.totalPackages.quote]) ??
      packingKind(declaration.items.flatMap((item) => [citedWrittenText(item.packingMethod), item.packages.quote]));
    const kinds = new Set([actualKind, ...counts.map(({ method }) => method)].filter(Boolean));
    if ((kinds.size > 1 && (!actualKind || !kind || actualKind !== kind)) || equals(actual.value, expected.value)) return [];
    return [{
      rule: "DEC-04", severity: "error", key: "DEC-04.packages",
      params: { expected: expected.field.value!, found: actual.field.value!, document: expected.doc.type },
      evidence: [cite(actual), cite(expected)],
    }];
  },
};

function usableAmount(field: CitedDecimal) {
  return quoted(field) ? num(field) : null;
}

function usableCurrency(field: CitedText) {
  return quoted(field) ? currencyCode(field) : null;
}

const decValues: Rule = {
  id: "DEC-05",
  run({ invoices, declarations }) {
    const findings: Finding[] = [];
    const [first] = declarations;
    if (!first) return findings;
    const found = usableCurrency(first.currency);
    const expected = invoices[0] && usableCurrency(invoices[0].currency);
    if (found && expected && invoices.every((invoice) => usableCurrency(invoice.currency) === expected)) {
      if (found !== expected) {
        findings.push({
          rule: "DEC-05", severity: "error", key: "DEC-05.currency", params: { expected, found },
          evidence: [evidence(first, "currency", first.currency), ...invoices.map((d) => evidence(d, "currency", d.currency))],
        });
      } else {
        const actual = usableAmount(first.totalInvoiceAmount);
        const total = invoices.every((invoice) => quoted(invoice.total)) ? sumAll(invoices, (invoice) => invoice.total) : null;
        if (actual && total && !equals(total, actual)) {
          findings.push({
            rule: "DEC-05", severity: "error", key: "DEC-05.invoice-total",
            params: { expected: show(total), found: first.totalInvoiceAmount.value! }, units: { expected, found },
            evidence: [evidence(first, "totalInvoiceAmount", first.totalInvoiceAmount), ...invoices.map((d) => evidence(d, "total", d.total))],
          });
        }
      }
    }
    for (const declaration of declarations) {
      const total = usableAmount(declaration.totalInvoiceAmount);
      const actual = quotedSum(declaration, "invoiceValue");
      if (!total || !actual || equals(actual.value, total)) continue;
      const currency = usableCurrency(declaration.currency);
      findings.push({
        rule: "DEC-05", severity: "error", key: "DEC-05.item-total",
        params: { expected: declaration.totalInvoiceAmount.value!, found: actual.field.value! },
        ...(currency ? { units: { expected: currency, found: currency } } : {}),
        evidence: [cite(actual), ...itemEvidence(declaration, "invoiceValue"), evidence(declaration, "totalInvoiceAmount", declaration.totalInvoiceAmount)],
      });
    }
    return findings;
  },
};

function origin(field: CitedText): string | null {
  const value = citedWrittenText(field);
  return value ? COUNTRY_CODES.get(foldName(value).trim()) ?? null : null;
}

const decOrigins: Rule = {
  id: "DEC-06",
  run({ invoices: [invoice], declarations }) {
    const expected = invoice && origin(invoice.countryOfOrigin);
    return declarations.flatMap((declaration, index) => declaration.items.flatMap((item, i): Finding[] => {
      const field = item.countryOfOrigin;
      const line = itemNumber(item, i);
      const cited = evidence(declaration, `items[${i}].countryOfOrigin`, field);
      if (citedWrittenText(field) === "999") {
        return [{ rule: "DEC-06", severity: "warning", key: "DEC-06.unestablished", params: { line }, evidence: [cited] }];
      }
      const country = origin(field);
      if (index || !invoice || !expected || !country || country === expected) return [];
      return [{
        rule: "DEC-06", severity: "warning", key: "DEC-06.origin",
        params: { line, invoice: invoice.countryOfOrigin.value!, declaration: field.value! },
        evidence: [cited, evidence(invoice, "countryOfOrigin", invoice.countryOfOrigin)],
      }];
    }));
  },
};

export const declarationRules = [decParties, decCodes, decWeights, decPackages, decValues, decOrigins];
