import { describe, expect, it } from "vitest";
import {
  blankDocument,
  buildReport,
  checkDocuments,
  checkExtraction,
  formatMessage,
  type Cmr,
  type CommercialInvoice,
  type Contract,
  type Extraction,
  type Finding,
  type PackingList,
  type ReportLanguage,
} from "../src/index.ts";
import { normalizeRef, sameParty } from "../src/check/helpers.ts";
import { incotermCode } from "../src/check/rules/cross.ts";
import { c, kaPack } from "./support/ka-pack.ts";

function setup() {
  const pack = kaPack();
  const [invoice, pl, cmr, contract] = pack.documents as [CommercialInvoice, PackingList, Cmr, Contract];
  return { pack, invoice, pl, cmr, contract };
}

const run = (pack: Extraction) => checkExtraction(pack);
const keys = (findings: Finding[]) => findings.map((f) => f.key);
const find = (findings: Finding[], key: Finding["key"]) => findings.find((f) => f.key === key);
const text = (f: Finding, language: ReportLanguage = "en") => formatMessage(f.key, f.params, language, undefined, f.units);

describe("clean Georgian pack", () => {
  it("has no findings and no extraction issues", () => {
    const result = checkDocuments(kaPack());
    expect(result.ok).toBe(true);
    expect(result.extractionIssues).toEqual([]);
    expect(result.findings.map((f) => formatMessage(f.key, f.params))).toEqual([]);
    expect(result.summary).toEqual({ documents: 4, errors: 0, warnings: 0 });
  });
});

describe("AMT-01 amount in words", () => {
  it("catches words that disagree with figures", () => {
    const { pack, invoice } = setup();
    invoice.totalInWords = c("ცამეტი ათას ხუთასი ევრო და ნული ცენტი");
    const finding = find(run(pack), "AMT-01.mismatch");
    expect(finding).toMatchObject({ severity: "error", params: { wordsAmount: "13500.00", amount: "13300.00" } });
    expect(finding?.evidence.map((e) => e.path)).toEqual(["totalInWords", "total"]);
    expect(formatMessage(finding!.key, finding!.params, "en", undefined, finding!.units)).toBe(
      "Amount in words reads 13,500.00 EUR, but the amount in figures is 13,300.00 EUR.",
    );
  });

  it("catches a currency word that disagrees", () => {
    const { pack, contract } = setup();
    contract.totalInWords = c("ცამეტი ათას სამასი ლარი");
    expect(find(run(pack), "AMT-01.currency")?.params).toEqual({ wordsCurrency: "GEL", currency: "EUR" });
  });

  it("accepts a currency word that names two currencies for either", () => {
    const { pack, invoice, contract } = setup();
    invoice.currency = c("AZN");
    contract.currency = c("AZN");
    invoice.totalInWords = c("thirteen thousand three hundred manat");
    contract.totalInWords = c("thirteen thousand three hundred Azerbaijani manat");
    expect(run(pack)).toEqual([]);
    invoice.currency = c("TMT");
    contract.currency = c("TMT");
    const finding = find(run(pack), "AMT-01.currency")!;
    expect(finding.evidence[0]?.documentType).toBe("contract");
    expect(finding.params).toEqual({ wordsCurrency: "AZN", currency: "TMT" });
    // A currency that manat never names is a mismatch, said with both codes.
    invoice.currency = c("USD");
    contract.currency = c("USD");
    contract.totalInWords = c(null);
    expect(text(find(run(pack), "AMT-01.currency")!)).toBe("Amount in words is in AZN/TMT, but the document currency is USD.");
    // "francs" alone does not say which franc: nothing to compare.
    invoice.totalInWords = c("thirteen thousand three hundred francs");
    expect(run(pack)).toEqual([]);
  });

  it("warns when the words cannot be read", () => {
    const { pack, invoice } = setup();
    invoice.totalInWords = c("ცამეტი ათას ბანანი ევრო");
    expect(find(run(pack), "AMT-01.unreadable")?.severity).toBe("warning");
  });

  it("gives the reason as a code and translates it", () => {
    const { pack, invoice } = setup();
    invoice.totalInWords = c("ცამეტი ათას ბანანი ევრო");
    const finding = find(run(pack), "AMT-01.unreadable")!;
    expect(finding.params).toEqual({ reason: "UNKNOWN_WORD", word: "ბანანი" });
    expect(text(finding)).toBe('Amount in words could not be read: unknown word "ბანანი".');
    expect(text(finding, "ka")).toBe("სიტყვიერი თანხა ვერ იკითხება: უცნობი სიტყვა „ბანანი“.");
    expect(text(finding, "ru")).toBe("Не удалось прочитать сумму прописью: неизвестное слово «ბანანი».");
    expect(text(finding, "tr")).toBe('Yazıyla tutar okunamadı: bilinmeyen kelime "ბანანი".');
    invoice.totalInWords = c("ხუთი ოცი ევრო");
    expect(text(find(run(pack), "AMT-01.unreadable")!, "ka")).toBe("სიტყვიერი თანხა ვერ იკითხება: „ხუთ ოც“ სწორი რიცხვი არ არის.");
  });

  it("reads words written in another language than the document", () => {
    const { pack, invoice } = setup();
    invoice.totalInWords = c("Thirteen thousand three hundred euro");
    expect(run(pack).filter((f) => f.rule === "AMT-01")).toEqual([]);
    invoice.totalInWords = c("Twenty thousand euro");
    expect(find(run(pack), "AMT-01.mismatch")?.params).toMatchObject({ wordsAmount: "20000.00", amount: "13300.00" });
  });

  it("splits the cents off at 'and' after a leading currency", () => {
    const { pack, invoice } = setup();
    invoice.totalInWords = c("SAY EURO THIRTEEN THOUSAND THREE HUNDRED AND ZERO CENTS ONLY");
    expect(run(pack)).toEqual([]);
  });
});

describe("SUM rules", () => {
  it("SUM-01 catches quantity × price ≠ line total", () => {
    const { pack, invoice } = setup();
    invoice.lines[0]!.lineTotal = c("8600.00");
    const findings = run(pack);
    expect(find(findings, "SUM-01.line")?.params).toMatchObject({ line: "1", expected: "8700.00", found: "8600.00" });
    expect(find(findings, "SUM-02.subtotal")?.params).toEqual({ expected: "13200.00", found: "13300.00" });
  });

  it("SUM-01 tolerates rounding to the printed precision", () => {
    const { pack, invoice } = setup();
    const line = invoice.lines[0]!;
    line.quantity = c("3");
    line.unitPrice = c("33.333");
    line.lineTotal = c("100.00"); // 99.999 printed with two decimals
    expect(keys(run(pack))).not.toContain("SUM-01.line");
    line.unitPrice = c("33.30");
    expect(keys(run(pack))).toContain("SUM-01.line");
  });

  it("SUM-02 catches a total that ignores charges", () => {
    const { pack, invoice } = setup();
    invoice.freight = c("1800.00");
    const finding = find(run(pack), "SUM-02.total");
    expect(finding?.params).toEqual({ expected: "15100.00", formula: "13300.00 − 0.00 + 1800.00", found: "13300.00" });
  });

  it("SUM-02 adds tax and other charges, and takes off an advance", () => {
    const { pack, invoice } = setup();
    // 13,300.00 + VAT 18% = 15,694.00: an ordinary invoice.
    invoice.tax = c("2394.00", "EUR 2,394.00");
    invoice.total = c("15694.00", "EUR 15,694.00");
    invoice.totalInWords = c("თხუთმეტი ათას ექვსას ოთხმოცდათოთხმეტი ევრო და ნული ცენტი");
    expect(run(pack)).toEqual([]);
    // Packing 120.00 added, an advance of 5,000.00 taken off.
    invoice.otherCharges = [c("120.00"), c("-5000.00", "5,000.00")];
    invoice.total = c("10814.00", "EUR 10,814.00");
    invoice.totalInWords = c("ათი ათას რვაას თოთხმეტი ევრო და ნული ცენტი");
    expect(run(pack)).toEqual([]);
    // A total that leaves the tax out is an error, with the tax in the formula.
    invoice.total = c("8420.00", "EUR 8,420.00");
    invoice.totalInWords = c(null);
    const finding = find(run(pack), "SUM-02.total")!;
    expect(finding.params).toEqual({ expected: "10814.00", formula: "13300.00 − 0.00 + 120.00 − 5000.00 + 2394.00", found: "8420.00" });
    expect(finding.evidence.map((e) => e.path)).toEqual(["total", "subtotal", "discount", "otherCharges[0]", "otherCharges[1]", "tax"]);
    expect(text(finding)).toBe("Expected total 10,814.00 EUR (13,300.00 − 0.00 + 120.00 − 5,000.00 + 2,394.00), but the invoice total is 8,420.00 EUR.");
  });

  it("SUM-02 does not subtract a discount rate as an amount", () => {
    const { pack, invoice } = setup();
    // "Discount 5%" with no amount printed: 13,300.00 less 5% is 12,635.00.
    invoice.discount = c(null);
    invoice.discountPercent = c("5", "5%");
    invoice.total = c("12635.00", "EUR 12,635.00");
    invoice.totalInWords = c(null);
    expect(run(pack)).toEqual([]);
    // "Discount 0%" takes nothing off, so the total is still checked.
    invoice.discountPercent = c("0", "0%");
    expect(find(run(pack), "SUM-02.total")?.params).toEqual({ expected: "13300.00", formula: "13300.00", found: "12635.00" });
    // With the amount printed as well, the amount is used.
    invoice.discountPercent = c("5", "5%");
    invoice.discount = c("665.00", "EUR 665.00");
    expect(run(pack)).toEqual([]);
    invoice.total = c("12700.00", "EUR 12,700.00");
    expect(find(run(pack), "SUM-02.total")?.params).toEqual({ expected: "12635.00", formula: "13300.00 − 665.00", found: "12700.00" });
  });

  it("SUM-02 leaves the total alone when a charge is not a number", () => {
    const { pack, invoice } = setup();
    invoice.freight = c("1,800.00");
    invoice.total = c("15100.00", "EUR 15,100.00");
    invoice.totalInWords = c(null);
    expect(keys(run(pack))).toEqual([]);
    invoice.freight = c("1800.00", "1,800.00");
    invoice.total = c("15000.00", "EUR 15,000.00");
    expect(keys(run(pack))).toEqual(["SUM-02.total"]);
  });

  it("SUM-03 catches packing list totals that do not add up", () => {
    const { pack, pl } = setup();
    pl.totalGrossWeightKg = c("1850");
    const findings = run(pack);
    const sum = find(findings, "SUM-03.total")!;
    expect(sum.params).toMatchObject({ document: "packing_list", metric: "grossWeightKg", expected: "1880", found: "1850" });
    expect(text(sum)).toBe("Packing list: lines add up to 1,880 (gross weight, kg), but the stated total is 1,850.");
    expect(text(sum, "ka")).toBe("შეფუთვის ფურცელი: სტრიქონების ჯამი 1\u00a0880-ია (ბრუტო, კგ), ჯამში კი წერია 1\u00a0850.");
    expect(text(find(findings, "WGT-02.gross")!)).toBe("Gross weight differs: packing list 1,850 kg, CMR 1,880 kg.");
  });
});

describe("cross-document rules", () => {
  it("CUR-01 catches different currencies", () => {
    const { pack, contract } = setup();
    contract.currency = c("USD");
    const finding = find(run(pack), "CUR-01.mismatch")!;
    expect(JSON.parse(finding.params.currencies!)).toEqual([["commercial_invoice", "EUR"], ["contract", "USD"]]);
    expect(text(finding, "ru")).toBe("В документах разные валюты: EUR (инвойс), USD (договор).");
  });

  it("QTY-01 compares package counts across invoice, packing list and CMR", () => {
    const { pack, cmr } = setup();
    cmr.totalPackages = c("90");
    const finding = find(run(pack), "QTY-01.packages")!;
    expect(text(finding)).toBe("Number of packages differs: invoice 100, packing list 100, CMR 90.");
    expect(text(finding, "tr")).toBe("Kap sayısı farklı: faturada 100, çeki listesinde 100, CMR'de 90.");
  });

  it("QTY-01 compares total quantity when lines cannot be matched", () => {
    const { pack, pl } = setup();
    pl.totalQuantity = c("95");
    expect(find(run(pack), "QTY-01.quantity")?.params).toEqual({ invoice: "100", packingList: "95" });
  });

  it("QTY-01 matches lines by model when both documents have quantities", () => {
    const { pack, pl } = setup();
    pl.lines[0]!.quantity = c("60");
    pl.lines[1]!.quantity = c("50");
    for (const line of pl.lines) line.unit = c("ცალი");
    pl.totalQuantity = c("110");
    const finding = find(run(pack), "QTY-01.line");
    expect(finding?.params).toEqual({ model: "AOS-MP2", invoice: "40", packingList: "50" });
    expect(finding?.evidence.map((e) => `${e.documentId}:${e.path}`)).toEqual([
      "invoice-1:lines[1].quantity",
      "packing-list-1:lines[1].quantity",
    ]);
  });

  it("QTY-01 sums a model split over several lines", () => {
    const { pack, pl } = setup();
    const [mp3, mp2] = pl.lines as [PackingList["lines"][number], PackingList["lines"][number]];
    pl.lines = [
      { ...mp3, quantity: c("35"), packages: c("35"), netWeightKg: c("630"), grossWeightKg: c("700"), volumeM3: c("5.2861") },
      { ...mp3, quantity: c("25"), packages: c("25"), netWeightKg: c("450"), grossWeightKg: c("500"), volumeM3: c("3.7758") },
      { ...mp2, quantity: c("40") },
    ].map((line) => ({ ...line, unit: c("ცალი") }));
    expect(run(pack)).toEqual([]);
    pl.lines[1]!.quantity = c("20");
    const finding = find(run(pack), "QTY-01.line")!;
    expect(finding.params).toEqual({ model: "AOS-MP3", invoice: "60", packingList: "55" });
    expect(finding.evidence.map((e) => `${e.documentId}:${e.path}`)).toEqual([
      "invoice-1:lines[0].quantity",
      "packing-list-1:lines[0].quantity",
      "packing-list-1:lines[1].quantity",
    ]);
  });

  it("QTY-01 does not compare pallets with cartons", () => {
    const { pack, cmr, invoice, pl } = setup();
    cmr.goods = [{ ...cmr.goods[0]!, packages: c("6"), packingMethod: c("პალეტი"), grossWeightKg: c("1880", "1,880") }];
    cmr.totalPackages = c("6", "6 პალეტი");
    expect(keys(run(pack))).not.toContain("QTY-01.packages");
    // Cartons are still compared with cartons…
    invoice.packages = c("90", "90 მუყაოს ყუთი");
    const finding = find(run(pack), "QTY-01.packages")!;
    expect(text(finding)).toBe("Number of packages differs: invoice 90, packing list 100.");
    // …and a count with no stated method with the one method named.
    invoice.packages = c("100");
    pl.totalPackages = c("100");
    expect(text(find(run(pack), "QTY-01.packages")!)).toBe("Number of packages differs: invoice 100, packing list 100, CMR 6.");
  });

  it("QTY-01 compares quantities only in the same unit", () => {
    const { pack, pl } = setup();
    // The invoice counts pieces (60 and 40 ცალი); this packing list counts cartons of ten.
    pl.lines[0]!.quantity = c("6");
    pl.lines[1]!.quantity = c("4");
    pl.totalQuantity = c("10");
    expect(pl.lines.map((l) => l.unit.value)).toEqual(["ყუთი", "ყუთი"]);
    expect(run(pack)).toEqual([]);
    // The same unit in another spelling is the same unit.
    pl.lines[0]!.unit = c("ც.");
    pl.lines[1]!.unit = c("PCS");
    expect(run(pack).map((f) => [f.key, f.params.model])).toEqual([["QTY-01.line", "AOS-MP3"], ["QTY-01.line", "AOS-MP2"]]);
    // A line with no unit is compared; a line in another unit is not.
    pl.lines[0]!.unit = c(null);
    pl.lines[1]!.unit = c("ყუთი");
    expect(run(pack).map((f) => [f.key, f.params.model])).toEqual([["QTY-01.line", "AOS-MP3"]]);
  });

  it("QTY-01 takes a plain plural for the same unit: roll and rolls, box and boxes", () => {
    const units = (invoiceUnit: string, listUnit: string) => {
      const { pack, invoice, pl } = setup();
      for (const line of invoice.lines) line.unit = c(invoiceUnit);
      pl.lines[0]!.quantity = c("60");
      pl.lines[1]!.quantity = c("50");
      for (const line of pl.lines) line.unit = c(listUnit);
      pl.totalQuantity = c("110");
      return run(pack).map((f) => [f.key, f.params.model]);
    };
    const mismatch = [["QTY-01.line", "AOS-MP2"]];
    // Was silently not compared: "roll" and "rolls" looked like two units.
    expect(units("roll", "rolls")).toEqual(mismatch);
    expect(units("Rolls", "ROLL.")).toEqual(mismatch);
    expect(units("box", "boxes")).toEqual(mismatch);
    expect(units("batch", "batches")).toEqual(mismatch);
    expect(units("bottle", "bottles")).toEqual(mismatch);
    expect(units("case", "cases")).toEqual(mismatch);
    expect(units("meter", "meters")).toEqual(mismatch);
    // Still two units: nothing is compared, so nothing is reported.
    expect(units("roll", "boxes")).toEqual([]);
    expect(units("gross", "gros")).toEqual([]);
    expect(units("pc", "set")).toEqual([]);
    expect(units("bus", "bu")).toEqual([]);
  });

  it("QTY-01 compares total quantities only in the same unit", () => {
    const { pack, pl } = setup();
    // No item codes on the packing list, so only the totals can be compared: 100 pieces against 10 cartons.
    for (const line of pl.lines) line.model = c(null);
    pl.lines[0]!.quantity = c("6");
    pl.lines[1]!.quantity = c("4");
    pl.totalQuantity = c("10");
    expect(run(pack)).toEqual([]);
    pl.lines[0]!.unit = c("ცალი");
    pl.lines[1]!.unit = c("ცალი");
    expect(find(run(pack), "QTY-01.quantity")?.params).toEqual({ invoice: "100", packingList: "10" });
  });

  it("QTY-01 takes the packing list's packing method from its own field", () => {
    const { pack, pl } = setup();
    // 100 cartons on 6 pallets: the packing list counts pallets and says so once, in its header.
    pl.lines[0]!.packages = c("4");
    pl.lines[1]!.packages = c("2");
    pl.totalPackages = c("6");
    pl.packingMethod = c("პალეტი");
    expect(run(pack)).toEqual([]);
    // …or per line, in its own column.
    pl.packingMethod = c(null);
    for (const line of pl.lines) line.packingMethod = c("palet");
    expect(run(pack)).toEqual([]);
    // With no method named, 6 is compared with the 100 cartons of the invoice and the CMR.
    for (const line of pl.lines) line.packingMethod = c(null);
    expect(text(find(run(pack), "QTY-01.packages")!)).toBe("Number of packages differs: invoice 100, packing list 6, CMR 100.");
  });

  it("QTY-01 marks a sum of lines as computed evidence", () => {
    const { pack, pl, cmr } = setup();
    pl.totalPackages = c(null);
    cmr.totalPackages = c("90", "90 ყუთი");
    const finding = find(run(pack), "QTY-01.packages")!;
    expect(finding.evidence.map((e) => e.computed ?? false)).toEqual([false, true, false]);
    expect(finding.evidence[1]).toMatchObject({ path: "lines[*]", value: "100", quote: null });
  });

  it("QTY-01 holds two package counts to the coarser of the two, whichever document prints it", () => {
    // Whole counts must be equal. Should a count ever carry decimals, "100" is what "100.4" rounds to, on either side.
    const packages = (pack: Extraction) => keys(run(pack)).filter((key) => key === "QTY-01.packages");
    const finer = setup();
    finer.invoice.packages = c("100.4");
    expect(packages(finer.pack)).toEqual([]);
    const { pack, cmr } = setup();
    cmr.totalPackages = c("100.4");
    expect(packages(pack)).toEqual([]);
    cmr.totalPackages = c("100.6");
    expect(packages(pack)).toEqual(["QTY-01.packages"]);
  });

  it("WGT-01 catches gross below net", () => {
    const { pack, pl } = setup();
    pl.lines[1]!.grossWeightKg = c("580");
    const finding = find(run(pack), "WGT-01.gross-below-net")!;
    expect(finding.params).toEqual({ where: "packing_list:line:2", net: "600", gross: "580" });
    expect(text(finding)).toBe("Packing list, line 2: gross weight 580 kg is less than net weight 600 kg.");
    expect(text(finding, "ka")).toBe("შეფუთვის ფურცელი, სტრიქონი 2: ბრუტო წონა 580 კგ ნეტო წონაზე (600 კგ) ნაკლებია.");
  });

  it("WGT-02 holds every two documents to the tolerance, whichever of them prints which weight", () => {
    // 1,880.0, 1,880.5 and 1,879.5 kg: the first is within 0.5 kg of each of the others, and those two are 1.0 kg apart.
    const weights = ["1880.0", "1880.5", "1879.5"] as const;
    for (const [onPackingList, onCmr, onInvoice] of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]] as const) {
      const { pack, invoice, pl, cmr } = setup();
      pl.totalGrossWeightKg = c(weights[onPackingList]);
      cmr.totalGrossWeightKg = c(weights[onCmr]);
      invoice.grossWeightKg = c(weights[onInvoice]);
      expect(keys(run(pack)), `${onPackingList}${onCmr}${onInvoice}`).toEqual(["WGT-02.gross"]);
      // The order of the documents in the extraction changes nothing either.
      pack.documents.reverse();
      expect(keys(run(pack)), `${onPackingList}${onCmr}${onInvoice}, reversed`).toEqual(["WGT-02.gross"]);
    }
    const { pack, invoice, pl, cmr } = setup();
    pl.totalGrossWeightKg = c("1880.0");
    cmr.totalGrossWeightKg = c("1880.5");
    invoice.grossWeightKg = c("1879.5");
    expect(text(find(run(pack), "WGT-02.gross")!)).toBe("Gross weight differs: packing list 1,880.0 kg, CMR 1,880.5 kg, invoice 1,879.5 kg.");
  });

  it("WGT-02 passes three weights that are within the tolerance of each other", () => {
    const { pack, invoice, pl, cmr } = setup();
    pl.totalGrossWeightKg = c("1880.0");
    cmr.totalGrossWeightKg = c("1880.5");
    invoice.grossWeightKg = c("1880.25");
    expect(run(pack)).toEqual([]);
    // Exactly 0.5 kg between the lightest and the heaviest still passes; 0.6 kg does not.
    invoice.grossWeightKg = c("1880.0");
    expect(run(pack)).toEqual([]);
    invoice.grossWeightKg = c("1879.9");
    expect(keys(run(pack))).toEqual(["WGT-02.gross"]);
  });

  it("WGT-02 compares two documents with the same tolerance", () => {
    const { pack, invoice } = setup();
    // Only the packing list (1,680 kg) and the invoice print a net weight.
    invoice.netWeightKg = c("1680.5");
    expect(run(pack)).toEqual([]);
    invoice.netWeightKg = c("1680.6");
    expect(text(find(run(pack), "WGT-02.net")!)).toBe("Net weight differs: packing list 1,680 kg, invoice 1,680.6 kg.");
  });

  it("REF-01 catches a wrong invoice reference but ignores formatting", () => {
    const { pack, pl } = setup();
    pl.invoiceRef.number = c("aos inv 2026 0918 01");
    expect(keys(run(pack))).not.toContain("REF-01.invoice-number");
    pl.invoiceRef.number = c("AOS-INV-2026-0918-02");
    expect(find(run(pack), "REF-01.invoice-number")?.params).toEqual({ expected: "AOS-INV-2026-0918-01", found: "AOS-INV-2026-0918-02" });
  });

  it("REF-01 finds numbers as whole numbers only", async () => {
    const { containsRef } = await import("../src/check/helpers.ts");
    expect(containsRef("Invoice AT-2026/118, dated 05.10.2026", "AT-2026/118")).toBe(true);
    expect(containsRef("Инвойс AT 2026 118", "AT-2026/118")).toBe(true);
    expect(containsRef("Упаковочный лист AT-2026/118-УЛ", "AT-2026/118")).toBe(false);
    expect(containsRef("ESR2026000781-ÇL", "ESR2026000781")).toBe(false);
    expect(containsRef("XAT-2026/118", "AT-2026/118")).toBe(false);
  });

  it("REF-01 strips a No/Nr prefix only when it is one", () => {
    expect(normalizeRef("NOR-2026-118")).toBe("NOR2026118");
    expect(normalizeRef("NR-2026/118")).toBe("NR2026118");
    expect(normalizeRef("No. NOR-1")).toBe("NOR1");
    expect(normalizeRef("NO123")).toBe("123");
    expect(normalizeRef("Nr: 5/7")).toBe("57");
    expect(normalizeRef("No 12")).toBe("12");
    expect(normalizeRef("#AB-1")).toBe("AB1");
    const { pack, invoice, pl, cmr } = setup();
    invoice.number = c("NOR-2026-118");
    pl.invoiceRef.number = c("NOR-2026-118");
    cmr.attachedDocuments[0] = c("ინვოისი NOR-2026-118");
    expect(run(pack)).toEqual([]);
  });

  it("REF-01 warns when the CMR does not list the invoice", () => {
    const { pack, cmr } = setup();
    cmr.attachedDocuments = cmr.attachedDocuments.slice(1);
    expect(find(run(pack), "REF-01.cmr-missing-document")).toMatchObject({
      severity: "warning",
      params: { document: "commercial_invoice", number: "AOS-INV-2026-0918-01" },
    });
  });

  it("DATE-01 checks contract → invoice → shipment order", () => {
    const { pack, contract, invoice } = setup();
    contract.date = c("2026-09-20");
    invoice.date = c("2026-09-25");
    const findings = run(pack);
    expect(find(findings, "DATE-01.invoice-after-shipment")).toMatchObject({ severity: "warning" });
    contract.date = c("2026-09-26");
    expect(find(run(pack), "DATE-01.contract-after-invoice")).toMatchObject({ severity: "error" });
  });

  it("PTY-01 warns about a different consignee, not about legal forms or scripts", () => {
    const { pack, cmr, pl } = setup();
    pl.shipper.name = c("ANATOLIA OFFICE SYSTEMS");
    cmr.consignee.name = c("Test Company");
    expect(keys(run(pack))).not.toContain("PTY-01.name");
    cmr.consignee.name = c("სხვა კომპანია");
    const finding = find(run(pack), "PTY-01.name")!;
    expect(finding.params).toMatchObject({ role: "consignee", b: "სხვა კომპანია", bDocument: "cmr" });
    expect(text(finding, "ka")).toBe("მიმღები განსხვავდება: „ტესტ კომპანია“ (ინვოისი) და „სხვა კომპანია“ (CMR).");
  });

  it("PTY-01 ignores case, Turkish dotted capitals and written-out legal forms", () => {
    const same: [string, string][] = [
      ["EGE TEKSTİL A.Ş.", "Ege Tekstil A.Ş."],
      ["KAYSERİ MOBİLYA SANAYİ A.Ş.", "Kayseri Mobilya Sanayi A.Ş."],
      ["Ege Tekstil Sanayi ve Ticaret Anonim Şirketi", "EGE TEKSTİL SAN. VE TİC. A.Ş."],
      ["Anadolu İplik Limited Şirketi", "ANADOLU İPLİK LTD. ŞTİ."],
      ["Kartli Retail Limited Liability Company", "Kartli Retail L.L.C."],
      ["Общество с ограниченной ответственностью «Колхида Хоум»", "ООО «Колхида Хоум»"],
      ["შეზღუდული პასუხისმგებლობის საზოგადოება „ტესტ კომპანია“", "შ.პ.ს. „ტესტ კომპანია“"],
      ["Kartli Retail LLC", "Kartli Retail Group LLC"],
    ];
    for (const [a, b] of same) expect(sameParty(a, b), `${a} = ${b}`).toBe(true);
    const { pack, pl, cmr } = setup();
    pl.shipper.name = c("ANATOLİA OFFİCE SYSTEMS LİMİTED");
    cmr.consignee.name = c("შეზღუდული პასუხისმგებლობის საზოგადოება ტესტ კომპანია");
    expect(keys(run(pack))).not.toContain("PTY-01.name");
  });

  it("PTY-01 matches names by whole words", () => {
    expect(sameParty("Tex LLC", "Cortex LLC")).toBe(false);
    const { pack, invoice, contract } = setup();
    invoice.seller.name = c("Tex LLC");
    contract.seller.name = c("Cortex LLC");
    expect(find(run(pack), "PTY-01.name")?.params).toMatchObject({ role: "seller", a: "Tex LLC", b: "Cortex LLC", bDocument: "contract" });
  });

  it("INC-01 catches different and unknown Incoterms", () => {
    const { pack, contract } = setup();
    contract.incoterm.code = c("EXW");
    expect(text(find(run(pack), "INC-01.mismatch")!)).toBe("Incoterms differ: FCA (invoice), EXW (contract).");
    contract.incoterm.code = c("FOT");
    expect(keys(run(pack))).toContain("INC-01.unknown");
  });

  it("INC-01 reads dotted codes and written-out rule names", () => {
    const codes: [string, string | null][] = [
      ["C.I.F.", "CIF"],
      ["D.A.P.", "DAP"],
      ["dap Tbilisi", "DAP"],
      ["FCA, Kayseri", "FCA"],
      ["Ex Works", "EXW"],
      ["EX-WORKS Kayseri", "EXW"],
      ["Free on Board", "FOB"],
      ["Cost, Insurance and Freight", "CIF"],
      ["Delivered at Place Unloaded", "DPU"],
      ["Франко-завод", "EXW"],
      ["Поставка в месте назначения с разгрузкой", "DPU"],
      ["İŞYERİNDE TESLİM", "EXW"],
      ["Gemide Teslim", "FOB"],
      ["FOT", null],
      ["Fason", null],
      ["Incoterms 2020", null],
    ];
    for (const [value, code] of codes) expect(incotermCode(value), value).toBe(code);
  });

  it("INC-01 compares rules, not spellings, and leaves unknown ones out", () => {
    const { pack, invoice, contract } = setup();
    invoice.incoterm.code = c("F.C.A.");
    contract.incoterm.code = c("Free Carrier");
    expect(run(pack)).toEqual([]);
    contract.incoterm.code = c("Franco");
    expect(keys(run(pack))).toEqual(["INC-01.unknown"]);
    invoice.incoterm.code = c("Ex Works");
    contract.incoterm.code = c("FCA");
    expect(text(find(run(pack), "INC-01.mismatch")!)).toBe("Incoterms differ: Ex Works (invoice), FCA (contract).");
  });

  it("INC-02 warns about a sea-only rule on a road shipment", () => {
    const { pack, invoice, contract } = setup();
    invoice.incoterm.code = c("FOB");
    contract.incoterm.code = c("FOB");
    expect(find(run(pack), "INC-02.sea-term-road")?.params).toEqual({ code: "FOB" });
  });

  it("INC-03 accepts an insurance policy titled in Turkish capitals", () => {
    const { pack, invoice, contract } = setup();
    invoice.incoterm.code = c("CIP");
    contract.incoterm.code = c("CIP");
    const policy = blankDocument("other", "policy");
    policy.title = c("SİGORTA POLİÇESİ");
    pack.documents.push(policy);
    expect(keys(run(pack))).not.toContain("INC-03.no-insurance");
  });

  it("list params with ; or = and odd names render safely", () => {
    const { pack, contract } = setup();
    contract.incoterm.code = c("EXW; a=b");
    const finding = find(run(pack), "INC-01.mismatch")!;
    expect(text(finding)).toBe("Incoterms differ: FCA (invoice), EXW; a=b (contract).");
  });

  it("INC-03 asks for insurance under CIP unless it is charged", () => {
    const { pack, invoice, contract } = setup();
    invoice.incoterm.code = c("CIP");
    contract.incoterm.code = c("CIP");
    expect(keys(run(pack))).toContain("INC-03.no-insurance");
    invoice.insurance = c("50.00");
    invoice.total = c("13350.00");
    expect(keys(run(pack))).not.toContain("INC-03.no-insurance");
  });
});

describe("CMR-01 and DOC-01", () => {
  it("CMR-01 lists missing Art. 6(1) particulars with severity", () => {
    const { pack, cmr } = setup();
    cmr.carrier.address = c(null);
    cmr.convention = c(null);
    const findings = run(pack).filter((f) => f.rule === "CMR-01");
    expect(findings.map((f) => [f.params.item, f.severity, f.params.fields])).toEqual([
      ["c", "error", "carrier.address"],
      ["k", "warning", "convention"],
    ]);
  });

  it("DOC-01 reports missing and duplicate documents", () => {
    const { pack } = setup();
    pack.documents = pack.documents.filter((d) => d.type !== "cmr");
    pack.documents.push(blankDocument("commercial_invoice", "invoice-2"));
    const findings = run(pack).filter((f) => f.rule === "DOC-01");
    expect(findings.map((f) => f.key)).toEqual(["DOC-01.missing", "DOC-01.multiple"]);
  });

  it("CMR-01 cites the article in Georgian as მუხ.", () => {
    const { pack, cmr } = setup();
    cmr.convention = c(null);
    expect(text(find(run(pack), "CMR-01.missing")!, "ka")).toBe(
      "CMR-ს აკლია მუხ. 6(1)(k): ჩანაწერი, რომ გადაზიდვას CMR კონვენცია არეგულირებს.",
    );
  });

  it("DOC-01 counts documents with the right plural", () => {
    const say = (count: number, language: ReportLanguage) =>
      formatMessage("DOC-01.multiple", { document: "commercial_invoice", count: String(count) }, language);
    expect([1, 2, 4, 5, 11, 12, 14, 21, 22, 25, 101, 111].map((n) => say(n, "ru").split(";")[0])).toEqual([
      "Инвойс: 1 документ",
      "Инвойс: 2 документа",
      "Инвойс: 4 документа",
      "Инвойс: 5 документов",
      "Инвойс: 11 документов",
      "Инвойс: 12 документов",
      "Инвойс: 14 документов",
      "Инвойс: 21 документ",
      "Инвойс: 22 документа",
      "Инвойс: 25 документов",
      "Инвойс: 101 документ",
      "Инвойс: 111 документов",
    ]);
    expect(say(1, "en")).toBe("1 document of type invoice; cross-checks use the first one.");
    expect(say(2, "en")).toBe("2 documents of type invoice; cross-checks use the first one.");
    expect(say(3, "ka")).toBe("ინვოისი: 3 დოკუმენტი; შედარებისას პირველი გამოიყენება.");
    expect(say(3, "tr")).toBe("Fatura: 3 belge; karşılaştırmada ilki kullanılır.");
  });
});

describe("values the extraction check rejects", () => {
  const issues = (pack: Extraction) => checkDocuments(pack).extractionIssues.map((i) => [i.code, i.path]);

  it("a weight read with the wrong decimal sign is one extraction issue, not three findings", () => {
    const { pack, pl } = setup();
    // The document prints 1,880 kg next to 9.0619 m³, so its decimal sign is the point: 1,880 is 1880, not 1.880.
    pl.totalGrossWeightKg = c("1.880", "1,880 კგ");
    const result = checkDocuments(pack);
    expect(result.findings).toEqual([]);
    expect(result.extractionIssues).toEqual([
      {
        code: "EXT_QUOTE_MISMATCH",
        path: "documents[1].totalGrossWeightKg",
        message: '"1.880" does not match the quote "1,880 კგ": this document writes decimals with "." (as in "9.0619"), so the quote reads 1880.',
      },
    ]);
  });

  it("a currency that is not a code gives no currency finding", () => {
    const { pack, invoice } = setup();
    invoice.currency = c("€");
    invoice.totalInWords = c("ცამეტი ათას სამასი ევრო და ნული ცენტი");
    expect(run(pack)).toEqual([]);
    expect(issues(pack)).toEqual([["EXT_CURRENCY_FORMAT", "documents[0].currency"]]);
    // The same symbol on a readable document is still compared.
    invoice.currency = c("USD", "$");
    expect(keys(run(pack))).toEqual(["AMT-01.currency", "CUR-01.mismatch"]);
  });

  describe("a misread the quote shows becomes one extraction issue and no finding", () => {
    // English month names and a taxed invoice, so each of the three readings has something to break.
    function english() {
      const s = setup();
      s.invoice.date = c("2026-10-14", "14 Oct 2026");
      s.invoice.contractRef.date = c("2026-10-01", "1 Oct 2026");
      s.contract.date = c("2026-10-01", "1 Oct 2026");
      s.cmr.date = c("2026-10-16", "16 Oct 2026");
      s.cmr.dateOfTakingOver = c("2026-10-16", "16 Oct 2026");
      s.pl.date = c("2026-10-15", "15 Oct 2026");
      return s;
    }

    it("the starting point is clean", () => {
      const result = checkDocuments(english().pack);
      expect(result.findings).toEqual([]);
      expect(result.extractionIssues).toEqual([]);
    });

    it("a month name read as the wrong month: was two findings", () => {
      const { pack, invoice } = english();
      // "14 Oct 2026" given as November: after the taking over, and not the date the packing list would cite.
      invoice.date = c("2026-11-14", "14 Oct 2026");
      const result = checkDocuments(pack);
      expect(result.findings).toEqual([]);
      expect(result.extractionIssues).toEqual([
        { code: "EXT_QUOTE_MISMATCH", path: "documents[0].date", message: '"2026-11-14" does not match the quote "14 Oct 2026", which reads 2026-10-14.' },
      ]);
    });

    it("a charge in brackets read as an addition: was a false SUM-02", () => {
      const { pack, invoice } = english();
      invoice.discount = c(null);
      invoice.otherCharges = [c("-500.00", "(500.00)")];
      invoice.total = c("12800.00", "EUR 12,800.00");
      invoice.totalInWords = c(null);
      pack.documents = pack.documents.filter((d) => d.type !== "contract");
      expect(checkDocuments(pack)).toMatchObject({ findings: [], extractionIssues: [] });
      invoice.otherCharges = [c("500.00", "(500.00)")];
      const result = checkDocuments(pack);
      expect(result.findings).toEqual([]);
      expect(result.extractionIssues).toEqual([
        {
          code: "EXT_QUOTE_MISMATCH",
          path: "documents[0].otherCharges[0]",
          message: '"500.00" does not match the quote "(500.00)": an amount printed in brackets or with a minus is negative, so the quote reads -500.00.',
        },
      ]);
    });

    it("a currency read as another one: was two errors", () => {
      const { pack, invoice } = english();
      invoice.currency = c("EUR", "USD");
      const result = checkDocuments(pack);
      expect(result.findings).toEqual([]);
      expect(result.extractionIssues).toEqual([{ code: "EXT_QUOTE_MISMATCH", path: "documents[0].currency", message: '"EUR" does not match the quote "USD", which names USD.' }]);
      // A real second currency, quoted as printed, is still the finding it was.
      invoice.currency = c("USD", "USD");
      expect(keys(run(pack))).toEqual(["AMT-01.currency", "CUR-01.mismatch"]);
    });

    it("an unusable currency is not shown as the unit of an amount", () => {
      const { pack, invoice } = english();
      invoice.currency = c("EUR", "USD");
      invoice.lines[1]!.lineTotal = c("4700.00", "4,700.00");
      const sum = find(run(pack), "SUM-01.line")!;
      expect(sum.units).toBeUndefined();
      expect(text(sum)).toBe("Line 2: 40 × 115.00 = 4,600.00, but the line total is 4,700.00.");
    });
  });

  it("a date that is not what its quote says takes no part in the date rules", () => {
    const { pack, cmr, invoice } = setup();
    // The invoice is dated 18.09.2026. The CMR prints 19.09.2026 and 10.05.2026: it writes the day first.
    invoice.date = c("2026-09-18", "18.09.2026");
    cmr.dateOfTakingOver = c("2026-05-10", "10.05.2026");
    expect(checkDocuments(pack).extractionIssues).toEqual([]);
    expect(keys(run(pack))).toEqual(["DATE-01.invoice-after-shipment"]);
    // Read month first, the same quote would be 5 October: an extraction issue, and no finding built on it.
    cmr.dateOfTakingOver = c("2026-10-05", "10.05.2026");
    const result = checkDocuments(pack);
    expect(result.extractionIssues).toEqual([
      {
        code: "EXT_QUOTE_MISMATCH",
        path: "documents[2].dateOfTakingOver",
        message: '"2026-10-05" does not match the quote "10.05.2026": this document writes the day before the month (as in "19.09.2026"), so the quote reads 2026-05-10.',
      },
    ]);
    expect(result.findings).toEqual([]);
  });

  it("an unusable CMR date is not a missing particular", () => {
    const { pack, cmr } = setup();
    cmr.date = c("19.09.2026");
    cmr.dateOfTakingOver = c("2026-09-91", "19.09.2026");
    expect(run(pack)).toEqual([]);
    expect(issues(pack)).toEqual([
      ["EXT_DATE_FORMAT", "documents[2].date"],
      ["EXT_DATE_FORMAT", "documents[2].dateOfTakingOver"],
    ]);
  });

  it("a percentage is not an amount", () => {
    const { pack, invoice } = setup();
    invoice.discount = c("5", "5%");
    invoice.total = c("12635.00", "EUR 12,635.00");
    invoice.totalInWords = c(null);
    const result = checkDocuments(pack);
    expect(result.findings).toEqual([]);
    expect(result.extractionIssues).toEqual([
      {
        code: "EXT_PERCENTAGE",
        path: "documents[0].discount",
        message: '"5" is a percentage in the quote "5%", and this field takes an amount. Give the printed amount, or null when only a rate is printed.',
      },
    ]);
    // Turkish writes the sign first: %18.
    invoice.discount = c(null);
    invoice.discountPercent = c("5", "%5");
    invoice.tax = c("18", "KDV %18");
    expect(issues(pack)).toEqual([["EXT_PERCENTAGE", "documents[0].tax"]]);
    expect(run(pack)).toEqual([]);
    // The amount printed next to the rate is an amount.
    invoice.discountPercent = c(null);
    invoice.tax = c("2394.00", "18%: EUR 2,394.00");
    invoice.total = c("15694.00", "EUR 15,694.00");
    expect(issues(pack)).toEqual([]);
    expect(run(pack)).toEqual([]);
  });

  it("an unusable part of the invoice formula leaves the total unchecked", () => {
    const { pack, invoice } = setup();
    invoice.tax = c("2.394", "EUR 2,394.00");
    invoice.total = c("15694.00", "EUR 15,694.00");
    invoice.totalInWords = c(null);
    expect(run(pack)).toEqual([]);
    expect(issues(pack)).toEqual([["EXT_QUOTE_MISMATCH", "documents[0].tax"]]);
  });

  it("evidence names its document by position when two documents share an id", () => {
    const { pack, pl, invoice } = setup();
    pl.id = invoice.id;
    pl.invoiceRef.number = c("AOS-INV-2026-0918-02");
    const result = checkDocuments(pack);
    expect(result.extractionIssues.map((i) => i.code)).toEqual(["EXT_DUPLICATE_ID"]);
    const evidence = buildReport(result, "en").errors[0]!.evidence;
    expect(evidence.map((e) => [e.documentId, e.documentType, e.sourceFile, e.number])).toEqual([
      ["invoice-1", "packing_list", "logisticshub-test-02-packing-list.pdf", "AOS-PL-2026-0919-01"],
      ["invoice-1", "commercial_invoice", "logisticshub-test-01-commercial-invoice.pdf", "AOS-INV-2026-0918-01"],
    ]);
  });
});

describe("result shape", () => {
  it("puts errors before warnings", () => {
    const { pack, cmr, invoice } = setup();
    cmr.convention = c(null);
    invoice.lines[0]!.lineTotal = c("8600.00");
    const severities = run(pack).map((f) => f.severity);
    expect(severities.indexOf("warning")).toBeGreaterThan(severities.lastIndexOf("error"));
  });

  it("reports unreadable input instead of throwing", () => {
    const result = checkDocuments({ documents: "nope" });
    expect(result.ok).toBe(false);
    expect(result.extractionIssues[0]?.code).toBe("EXT_SHAPE");
  });
});
