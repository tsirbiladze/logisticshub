import { GEORGIA_COUNTRIES } from "./hs.ts";
import type { CitedText, Party, TradeDocument } from "./schema.ts";

const georgia = new Set<string>(GEORGIA_COUNTRIES);
const isGeorgia = (value: string | null) => georgia.has(value?.trim().replaceAll("İ", "i").toLowerCase() ?? "");

export function georgianParty({ country }: Party): boolean {
  return isGeorgia(country.value) && isGeorgia(country.quote);
}

export function documentParties(doc: TradeDocument): [string, Party][] {
  switch (doc.type) {
    case "commercial_invoice": return [["seller", doc.seller], ["buyer", doc.buyer], ["consignee", doc.consignee]];
    case "packing_list": return [["shipper", doc.shipper], ["consignee", doc.consignee]];
    case "cmr": return [["sender", doc.sender], ["carrier", doc.carrier], ["consignee", doc.consignee]];
    case "contract": return [["seller", doc.seller], ["buyer", doc.buyer]];
    default: return [];
  }
}

export function taxDigits({ value, quote, page }: CitedText): string | null {
  const digits = (printed: string) => printed.trim().replace(/^[A-Za-z]{2}(?=[\s\p{Pd}0-9])/u, "").replace(/[\s\p{Pd}]/gu, "");
  if (value === null || quote === null || page === null || page < 1) return null;
  const code = digits(value);
  return /^[0-9]+$/.test(code) && code === digits(quote) ? code : null;
}

export function companyParties(documents: readonly TradeDocument[]) {
  return documents.flatMap((doc) => documentParties(doc).flatMap(([role, party]) => {
    if (!georgianParty(party)) return [];
    const code = taxDigits(party.taxId);
    return code && code.length === 9 ? [{ doc, role, party, code }] : [];
  }));
}
