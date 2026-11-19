import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { checkDocuments, lookupHsCode, type CommercialInvoice } from "../src/index.ts";
import { c, kaPack } from "./support/ka-pack.ts";

describe("Georgian commodity nomenclature", () => {
  it("retains the pinned annex's code rows, provenance and skipped row count", () => {
    const bytes = readFileSync(new URL("../src/hs-nomenclature.json.gz", import.meta.url));
    const data = JSON.parse(gunzipSync(bytes).toString("utf8"));
    expect(data.sha256).toBe("7fee741dfcb966846e572580cdc96733528c548c2b75b1554691414971a2e51d");
    expect(data.fetchedOn).toBe("2026-11-19");
    expect(data.skippedRows).toBe(2771);
    expect(data.countsByLength).toEqual({ 4: 959, 6: 1824, 8: 313, 9: 15, 11: 10242 });
    const codes: string[] = data.entries.map(([code]: [string]) => code);
    expect(codes).toHaveLength(13353);
    expect([...new Set(codes)].sort()).toEqual(codes);
  });

  it("looks up exact and prefix matches, official descriptions, depth and ancestors", () => {
    const { edition, sourceUrl, matches } = lookupHsCode("94 03.30");
    expect(edition).toMatchObject({ orderNumber: 21, publication: 0, laterAmendmentsVerified: false });
    expect(sourceUrl).toBe("https://matsne.gov.ge/ka/document/download/6086072/0/1");
    expect(matches.map((row) => row.code)).toEqual(["940330", "94033011000", "94033019000", "94033091000", "94033099000"]);
    expect(matches[0]).toMatchObject({ code: "940330", description: "ხის ავეჯი დაწესებულებებში გამოსაყენებელი ტიპის:", level: "subheading" });
    expect(lookupHsCode("9403 30\u00a0110 00").matches).toEqual([matches[1]]);
    expect(matches[1]).toMatchObject({ code: "94033011000", description: "საწერი მაგიდები", depth: 3, level: "national code", supplementaryUnit: null });
    expect(matches[1]!.ancestors.map(({ code, level }) => [code, level])).toEqual([["9403", "heading"], ["940330", "subheading"]]);
    expect(lookupHsCode("94037000001").matches[0]!.ancestors.map((row) => row.code)).toEqual(["9403", "94037000"]);
    expect(lookupHsCode("08094005001").matches[0]!.ancestors.at(-1)?.code).toBe("080940050");
    expect(lookupHsCode("01012100000").matches[0]!.supplementaryUnit).toBe("ცალი");
  });

  it("ignores case and spacing for descriptions and applies the limit", () => {
    const query = "საწერი  მაგიდ".toUpperCase();
    expect(lookupHsCode(query, 1).matches[0]!.description).toBe("საწერი მაგიდები");
    expect(lookupHsCode(query, 1).matches).toHaveLength(1);
    expect(lookupHsCode("დანარჩენი").matches).toHaveLength(20);
    expect(lookupHsCode("999999").matches).toEqual([]);
    expect(() => lookupHsCode(query, 0)).toThrow("Limit must be a positive integer.");
  });
});

function hsFindings(change: (invoice: CommercialInvoice) => void) {
  const pack = kaPack();
  const invoice = pack.documents[0] as CommercialInvoice;
  invoice.lines[0]!.hsCode = c("9403 10 999 99");
  change(invoice);
  return checkDocuments(pack).findings.filter((finding) => finding.rule === "HS-01");
}

describe("HS-01", () => {
  it("runs from the order date for every eligible role and recognized country spelling", () => {
    for (const [role, country] of [
      ["seller", "GE"], ["buyer", "GEO"], ["consignee", "Georgia"],
      ["seller", "საქართველო"], ["buyer", "Грузия"], ["consignee", "GÜRCİSTAN"],
    ] as const) {
      const findings = hsFindings((invoice) => {
        invoice.buyer.country = c(null);
        invoice[role].country = c(country);
        invoice.date = c("2024-01-26", "26.01.2024");
      });
      expect(findings).toMatchObject([{
        key: "HS-01.unknown-national", severity: "error",
        evidence: [{ path: "lines[0].hsCode", quote: "9403 10 999 99", page: 1 }],
      }]);
      expect(findings[0]!.params.neighbours!.match(/[0-9]{11} · /g)).toHaveLength(5);
    }
  });

  it("is silent with earlier, missing or unusable dates and ambiguous or uncited countries", () => {
    expect(hsFindings((invoice) => { invoice.date = c("2024-01-25", "25.01.2024"); })).toEqual([]);
    expect(hsFindings((invoice) => { invoice.date = c(null); })).toEqual([]);
    expect(hsFindings((invoice) => { invoice.date = c("2024-01-26", "25.01.2024"); })).toEqual([]);
    for (const country of [c(null), c("West Georgia"), c("Georgia, USA"), c("Georgia", "Tbilisi"), c("GE", null)]) {
      expect(hsFindings((invoice) => {
        invoice.buyer.country = country;
        invoice.countryOfOrigin = c("საქართველო");
      })).toEqual([]);
    }
  });

  it("checks the prefix for non-national codes, including implicit subheadings", () => {
    for (const code of ["01 01.21", "0101219", "94037099", "940370999", "9403709999", "940370999999", "9403\u00a030 110.00"]) {
      expect(hsFindings((invoice) => { invoice.lines[0]!.hsCode = c(code); }), code).toEqual([]);
    }
  });

  it("warns for unreadable codes and refuses to treat a misquoted code as an error", () => {
    for (const field of [c("9403"), c("9403109999900"), c("9403 1O 999 99"), c("94031099999", "94031058000")]) {
      expect(hsFindings((invoice) => { invoice.lines[0]!.hsCode = field; })).toMatchObject([{ key: "HS-01.unreadable", severity: "warning" }]);
    }
  });
});
