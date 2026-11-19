/**
 * references/rules.md is built from RULE_REFERENCE. These tests keep it in
 * step with the rules: every finding key is stated once under its own rule,
 * and with the severity the rule's code gives it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  blankDocument,
  checkDocuments,
  CMR_PARTICULARS,
  EXTRACTION_CHECKS,
  MESSAGES,
  NOT_CHECKED,
  RULE_DESCRIPTIONS,
  RULE_IDS,
  RULE_PRINCIPLES,
  RULE_REFERENCE,
  SCHEMA_VERSION,
  type Language,
  type TradeDocument,
} from "../src/index.ts";

const source = ["amounts", "cross", "cmr", "checklist", "hs"]
  .map((name) => readFileSync(fileURLToPath(new URL(`../src/check/rules/${name}.ts`, import.meta.url)), "utf8"))
  .join("\n");

describe("rule reference", () => {
  const stated = RULE_IDS.flatMap((id) => RULE_REFERENCE[id].findings.map((finding) => ({ id, ...finding })));

  it("states every finding key once, under its own rule", () => {
    expect(stated.map((finding) => finding.key).sort()).toEqual(Object.keys(MESSAGES.en).sort());
    for (const finding of stated) expect(finding.key.startsWith(`${finding.id}.`), finding.key).toBe(true);
  });

  it("gives each finding the severity its rule reports it with", () => {
    // Every finding is built as { …, severity: "…", key: "…" }; CMR-01 takes its severity from the particular.
    const inCode = new Map([...source.matchAll(/severity: "(error|warning)",\s+key: "([A-Z]+-\d+\.[a-z-]+)"/g)].map((match) => [match[2]!, match[1]!]));
    for (const finding of stated) {
      if (finding.key === "CMR-01.missing") continue;
      expect(inCode.get(finding.key), finding.key).toBe(finding.severity);
    }
    expect(inCode.size).toBe(stated.length - 1);
    expect(stated.find((finding) => finding.key === "CMR-01.missing")!.severity).toBe("error or warning");
  });

  it("names the CMR particulars with the severities of the code", () => {
    const { when } = RULE_REFERENCE["CMR-01"].findings[0]!;
    const letters = (severity: string) => CMR_PARTICULARS.filter((p) => p.severity === severity).map((p) => p.item).join("");
    expect(letters("error")).toBe("bcdefgh");
    expect(letters("warning")).toBe("aijk");
    expect(when).toContain("(b) to (h) are errors; (a), (i), (j) and (k) are warnings");
    for (const particular of CMR_PARTICULARS) expect(RULE_REFERENCE["CMR-01"].details!.join(" ")).toContain(`(${particular.item}) `);
  });

  it("says something for every rule and every section", () => {
    for (const id of RULE_IDS) {
      const rule = RULE_REFERENCE[id];
      expect(RULE_DESCRIPTIONS[id].length, id).toBeGreaterThan(20);
      expect(rule.reads.length, id).toBeGreaterThan(10);
      expect(rule.tolerance.length, id).toBeGreaterThan(3);
      expect(rule.silent.length, id).toBeGreaterThan(0);
    }
    expect(RULE_PRINCIPLES.length).toBeGreaterThan(3);
    expect(NOT_CHECKED.length).toBeGreaterThan(8);
  });
});

/**
 * "Before the rules" in references/rules.md says how a value is held against
 * its own quote, and when the check is silent. Every example those sentences
 * give is run here, so a sentence cannot say what the code does not do.
 */
describe("the extraction check, as rules.md states it", () => {
  type Invoice = Extract<TradeDocument, { type: "commercial_invoice" }>;
  const fact = (value: string, quote: string) => ({ value, quote, page: 1 });
  /** The codes of the issues an invoice gets after `change`. */
  const codes = (change: (doc: Invoice) => void, language: Language = "en") => {
    const doc: Invoice = { ...blankDocument("commercial_invoice", "invoice"), sourceFile: "invoice.pdf", language };
    change(doc);
    const result = checkDocuments({ schemaVersion: SCHEMA_VERSION, documents: [doc] });
    // An issue never becomes a finding: only the missing documents are reported for an invoice on its own.
    expect(result.findings.map((finding) => finding.rule)).toEqual(["DOC-01", "DOC-01"]);
    return result.extractionIssues.map((issue) => issue.code);
  };
  const statement = (lead: string) => EXTRACTION_CHECKS.find((line) => line.startsWith(`**${lead}**`))!;
  const MISMATCH = ["EXT_QUOTE_MISMATCH"];

  it("states six checks, each with its examples", () => {
    expect(EXTRACTION_CHECKS.map((line) => /^\*\*(.+?)\*\*/.exec(line)?.[1])).toEqual(["A number", "A date in figures", "A date with a month name", "The sign of a charge", "A currency", "A percentage"]);
  });

  it("a number: a reading of the quote, with the document's decimal sign; silent without digits or a known pattern", () => {
    const text = statement("A number");
    for (const example of ["`1,880` reads 1880 or 1.880", "`two cartons`", "`1.2.3`"]) expect(text).toContain(example);
    expect(codes((doc) => void (doc.packages = fact("1880", "1,880")))).toEqual([]);
    expect(codes((doc) => void (doc.packages = fact("1.880", "1,880")))).toEqual([]);
    expect(codes((doc) => void (doc.packages = fact("1500", "1,880")))).toEqual(MISMATCH);
    // The sign is not compared here.
    expect(codes((doc) => void (doc.packages = fact("-1880", "1,880")))).toEqual([]);
    // Another number shows the decimal sign: the reading must use it.
    const withPoint = (doc: Invoice) => void (doc.netWeightKg = fact("9.0619", "9.0619"));
    expect(codes((doc) => (withPoint(doc), void (doc.packages = fact("1.880", "1,880"))))).toEqual(MISMATCH);
    expect(codes((doc) => (withPoint(doc), void (doc.packages = fact("1880", "1,880"))))).toEqual([]);
    // Two numbers that show different signs settle nothing.
    expect(codes((doc) => (withPoint(doc), (doc.total = fact("9684.00", "9.684,00")), void (doc.packages = fact("1.880", "1,880"))))).toEqual([]);
    expect(codes((doc) => void (doc.packages = fact("2", "two cartons")))).toEqual([]);
    expect(codes((doc) => void (doc.packages = fact("9", "1.2.3")))).toEqual([]);
  });

  it("a date in figures: a reading of the date, in the order the document's other dates show", () => {
    const text = statement("A date in figures");
    for (const example of ["`18.09.2026`", "`2026-09-18`", "`10/14/26`"]) expect(text).toContain(example);
    expect(codes((doc) => void (doc.date = fact("2026-09-18", "18.09.2026")))).toEqual([]);
    expect(codes((doc) => void (doc.date = fact("2026-09-18", "2026-09-18")))).toEqual([]);
    expect(codes((doc) => void (doc.date = fact("2026-10-14", "10/14/26")))).toEqual([]);
    expect(codes((doc) => void (doc.date = fact("2026-09-19", "18.09.2026")))).toEqual(MISMATCH);
    // Alone, 05.10.2026 has two readings; next to 18.09.2026 it has one.
    expect(codes((doc) => void (doc.date = fact("2026-05-10", "05.10.2026")))).toEqual([]);
    expect(codes((doc) => ((doc.contractRef.date = fact("2026-09-18", "18.09.2026")), void (doc.date = fact("2026-05-10", "05.10.2026"))))).toEqual(MISMATCH);
  });

  it("a date with a month name: read in the document's language or in English, and only when the quote is one date", () => {
    const text = statement("A date with a month name");
    for (const example of ["`14 Oct 2026`", "`5 октября 2026 г.`", "`2026 წლის 5 ოქტომბერი`", "none for Turkish", "`language` is `other` or null"]) expect(text).toContain(example);
    expect(codes((doc) => void (doc.date = fact("2026-10-14", "14 Oct 2026")))).toEqual([]);
    expect(codes((doc) => void (doc.date = fact("2026-11-14", "14 Oct 2026")))).toEqual(MISMATCH);
    expect(codes((doc) => void (doc.date = fact("2026-11-05", "5 октября 2026 г.")), "ru")).toEqual(MISMATCH);
    expect(codes((doc) => void (doc.date = fact("2026-11-05", "2026 წლის 5 ოქტომბერი")), "ka")).toEqual(MISMATCH);
    expect(codes((doc) => void (doc.date = fact("2026-11-05", "5 Ekim 2026")), "tr")).toEqual(MISMATCH);
    // English is read in every document of the four languages; another language's names are not.
    expect(codes((doc) => void (doc.date = fact("2026-11-14", "14 Oct 2026")), "ka")).toEqual(MISMATCH);
    expect(codes((doc) => void (doc.date = fact("2026-11-05", "5 октября 2026 г.")), "en")).toEqual([]);
    // Silent: language other, a Turkish abbreviation, two days, another number, a date in figures beside it.
    expect(codes((doc) => void (doc.date = fact("2026-11-14", "14 Oct 2026")), "other")).toEqual([]);
    expect(codes((doc) => void (doc.date = fact("2026-11-05", "5 Eki 2026")), "tr")).toEqual([]);
    expect(codes((doc) => void (doc.date = fact("2026-11-14", "14 to 16 Oct 2026")))).toEqual([]);
    expect(codes((doc) => void (doc.date = fact("2026-11-14", "14 Oct 2026, week 42")))).toEqual([]);
    // A time of day is no other number.
    expect(codes((doc) => void (doc.date = fact("2026-11-14", "14 Oct 2026 10:30")))).toEqual(MISMATCH);
    // With a date in figures in the quote, that date is read and the month name is not.
    expect(codes((doc) => void (doc.date = fact("2026-10-14", "14.10.2026 (14 Nov 2026)")))).toEqual([]);
  });

  it("the sign of a charge: brackets or an attached minus, on the four charges the total adds", () => {
    const text = statement("The sign of a charge");
    for (const example of ["`(500.00)`", "`(USD 500.00)`", "`-500.00`", "`−500.00`", "`− 500.00`", "`Freight - 500.00`", "`500.00-`", "`15,500.-`"]) expect(text).toContain(example);
    for (const quote of ["(500.00)", "(USD 500.00)", "-500.00", "−500.00", "− 500.00"]) {
      expect(codes((doc) => void (doc.freight = fact("500.00", quote))), quote).toEqual(MISMATCH);
      expect(codes((doc) => void (doc.insurance = fact("500.00", quote))), quote).toEqual(MISMATCH);
      expect(codes((doc) => void (doc.tax = fact("500.00", quote))), quote).toEqual(MISMATCH);
      expect(codes((doc) => void (doc.otherCharges = [fact("500.00", quote)])), quote).toEqual(MISMATCH);
      expect(codes((doc) => void (doc.freight = fact("-500.00", quote))), quote).toEqual([]);
      // Every other field is left alone: a discount, a total.
      expect(codes((doc) => void (doc.discount = fact("500.00", quote))), quote).toEqual([]);
      expect(codes((doc) => void (doc.total = fact("500.00", quote))), quote).toEqual([]);
    }
    expect(codes((doc) => void (doc.freight = fact("500.00", "Freight - 500.00")))).toEqual([]);
    expect(codes((doc) => void (doc.freight = fact("500.00", "500.00-")))).toEqual([]);
    expect(codes((doc) => void (doc.freight = fact("15500", "15,500.-")))).toEqual([]);
    // More than one number in the quote: a rate beside the amount.
    expect(codes((doc) => void (doc.tax = fact("500.00", "18% (500.00)")))).toEqual([]);
  });

  it("a currency: a code or sign, alone or with its amount, that names one other currency", () => {
    const text = statement("A currency");
    for (const example of ["`USD`", "`USD 15,500.00`", "`$ 15,500.00`", "`US dollars`", "`ლარი`", "`RUR`", "`TRL`", "`ALL`", "`TOP`"]) expect(text).toContain(example);
    for (const quote of ["USD", "USD 15,500.00", "$ 15,500.00"]) {
      expect(codes((doc) => void (doc.currency = fact("EUR", quote))), quote).toEqual(MISMATCH);
      expect(codes((doc) => void (doc.currency = fact("USD", quote))), quote).toEqual([]);
    }
    // A sign agrees with every currency it can stand for.
    for (const value of ["USD", "CAD", "AUD"]) expect(codes((doc) => void (doc.currency = fact(value, "$"))), value).toEqual([]);
    // Silent: another word, several currencies, a code no longer in use, ALL and TOP.
    for (const quote of ["US dollars", "ლარი", "USD or GBP", "USD/GBP", "RUR", "TRL", "ALL", "TOP"]) expect(codes((doc) => void (doc.currency = fact("EUR", quote))), quote).toEqual([]);
  });

  it("a percentage: a number that carries the sign, in any field but discountPercent", () => {
    const text = statement("A percentage");
    for (const example of ["`20%`", "`%18`", "`5 %`", "`20% 3,124.00`"]) expect(text).toContain(example);
    for (const [value, quote] of [["20", "20%"], ["18", "%18"], ["5", "5 %"]] as const) {
      expect(codes((doc) => void (doc.tax = fact(value, quote))), quote).toEqual(["EXT_PERCENTAGE"]);
      expect(codes((doc) => void (doc.discount = fact(value, quote))), quote).toEqual(["EXT_PERCENTAGE"]);
      expect(codes((doc) => void (doc.discountPercent = fact(value, quote))), quote).toEqual([]);
    }
    expect(codes((doc) => void (doc.tax = fact("3124.00", "20% 3,124.00")))).toEqual([]);
  });

  it("QTY-01 says which spellings are one unit, plain plurals among them", () => {
    const silent = RULE_REFERENCE["QTY-01"].silent.join(" ");
    expect(silent).toContain("a plain English plural with its singular (`roll` and `rolls`, `box` and `boxes`: a Latin word of four letters or more ending in one `s`)");
  });
});
