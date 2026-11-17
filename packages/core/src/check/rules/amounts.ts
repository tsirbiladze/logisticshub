import { add, compare, equals, mul, sub, toFixed, ZERO, type Decimal } from "../../decimal.ts";
import type { CitedDecimal, Cmr, CommercialInvoice, Contract, PackingList } from "../../schema.ts";
import { isIsoCurrency } from "../../validate.ts";
import { parseAmountInWords } from "../../words/index.ts";
import { currencyCode, evidence, num, roundingTolerance, sameWithin, show, sumAll } from "../helpers.ts";
import type { Metric } from "../messages.ts";
import type { Evidence, Finding, Rule } from "../types.ts";

/** Finding.units for the money params whose currency is known; nothing when none is. */
function moneyUnits(currencies: Record<string, string | null>): { units?: Record<string, string> } {
  const known = Object.entries(currencies).filter((entry): entry is [string, string] => entry[1] !== null);
  return known.length > 0 ? { units: Object.fromEntries(known) } : {};
}

/** AMT-01: amount in words equals amount in figures (invoices and contracts). */
export const amountInWords: Rule = {
  id: "AMT-01",
  run({ invoices, contracts }) {
    const findings: Finding[] = [];
    const docs: [CommercialInvoice | Contract, "total" | "totalAmount"][] = [
      ...invoices.map((doc) => [doc, "total"] as [CommercialInvoice, "total"]),
      ...contracts.map((doc) => [doc, "totalAmount"] as [Contract, "totalAmount"]),
    ];
    for (const [doc, amountField] of docs) {
      const words = doc.totalInWords;
      if (words.value === null) continue;
      const wordsEvidence = evidence(doc, "totalInWords", words);
      const parsed = parseAmountInWords(words.value, doc.language);
      if (!parsed.ok) {
        // The reason is a code (+ the word it is about), translated by formatMessage.
        const { code, word } = parsed.error;
        findings.push({
          rule: "AMT-01",
          severity: "warning",
          key: "AMT-01.unreadable",
          params: word === undefined ? { reason: code } : { reason: code, word },
          evidence: [wordsEvidence],
        });
        continue;
      }
      const amountCited = doc.type === "commercial_invoice" ? doc.total : doc.totalAmount;
      const amount = num(amountCited);
      const currency = currencyCode(doc.currency);
      if (amount && !equals(parsed.value.amount, amount)) {
        // Each amount with its own currency: the one the words name (when they name exactly one) and the document's.
        const named = parsed.value.currency;
        findings.push({
          rule: "AMT-01",
          severity: "error",
          key: "AMT-01.mismatch",
          params: {
            words: words.value,
            wordsAmount: toFixed(parsed.value.amount, Math.max(parsed.value.amount.scale, amount.scale)),
            amount: amountCited.value ?? "",
          },
          ...moneyUnits({ wordsAmount: named && isIsoCurrency(named) ? named : null, amount: currency }),
          evidence: [wordsEvidence, evidence(doc, amountField, amountCited)],
        });
      }
      // A word that names several currencies ("manat": AZN/TMT) agrees with any of them.
      if (parsed.value.currency && currency && !parsed.value.currency.split("/").includes(currency)) {
        findings.push({
          rule: "AMT-01",
          severity: "error",
          key: "AMT-01.currency",
          params: { wordsCurrency: parsed.value.currency, currency },
          evidence: [wordsEvidence, evidence(doc, "currency", doc.currency)],
        });
      }
    }
    return findings;
  },
};

/** SUM-01: quantity × unit price = line total, on every invoice line. */
export const lineArithmetic: Rule = {
  id: "SUM-01",
  run({ invoices }) {
    const findings: Finding[] = [];
    for (const invoice of invoices) {
      const currency = currencyCode(invoice.currency);
      invoice.lines.forEach((line, index) => {
        const quantity = num(line.quantity);
        const unitPrice = num(line.unitPrice);
        const lineTotal = num(line.lineTotal);
        if (!quantity || !unitPrice || !lineTotal) return;
        const expected = mul(quantity, unitPrice);
        if (sameWithin(expected, lineTotal, roundingTolerance(lineTotal))) return;
        const path = `lines[${index}]`;
        findings.push({
          rule: "SUM-01",
          severity: "error",
          key: "SUM-01.line",
          params: {
            line: String(index + 1),
            quantity: line.quantity.value ?? "",
            unitPrice: line.unitPrice.value ?? "",
            expected: show(expected, lineTotal),
            found: line.lineTotal.value ?? "",
          },
          ...moneyUnits({ expected: currency, found: currency }),
          evidence: [
            evidence(invoice, `${path}.quantity`, line.quantity),
            evidence(invoice, `${path}.unitPrice`, line.unitPrice),
            evidence(invoice, `${path}.lineTotal`, line.lineTotal),
          ],
        });
      });
    }
    return findings;
  },
};

/** A printed discount rate that takes something off: any rate but a readable 0. */
function givesDiscount(rate: CitedDecimal): boolean {
  if (rate.value === null) return false;
  const percent = num(rate);
  return !percent || !equals(percent, ZERO);
}

/**
 * SUM-02: line totals → subtotal → total, where
 * total = subtotal − discount + freight + insurance + other charges + tax.
 * The total is left alone when a part of the formula is printed but cannot
 * be used: a discount given only as a rate, or a value the extraction check
 * rejected.
 */
export const invoiceTotals: Rule = {
  id: "SUM-02",
  run({ invoices }) {
    const findings: Finding[] = [];
    for (const invoice of invoices) {
      const currency = currencyCode(invoice.currency);
      const money = moneyUnits({ expected: currency, found: currency });
      const linesSum = sumAll(invoice.lines, (line) => line.lineTotal);
      const subtotal = num(invoice.subtotal);
      if (linesSum && subtotal && !sameWithin(linesSum, subtotal, roundingTolerance(subtotal))) {
        findings.push({
          rule: "SUM-02",
          severity: "error",
          key: "SUM-02.subtotal",
          params: { expected: show(linesSum, subtotal), found: invoice.subtotal.value ?? "" },
          ...money,
          evidence: [evidence(invoice, "subtotal", invoice.subtotal)],
        });
      }

      const total = num(invoice.total);
      const base = subtotal ?? linesSum;
      if (!total || !base) continue;
      let expected: Decimal = base;
      const parts = [show(base, total)];
      const used: Evidence[] = [];
      if (subtotal) used.push(evidence(invoice, "subtotal", invoice.subtotal));
      const discount = num(invoice.discount);
      if (discount) {
        // Printed as "500.00" or "-500.00": always a reduction.
        const reduction = compare(discount, ZERO) < 0 ? sub(ZERO, discount) : discount;
        expected = sub(expected, reduction);
        parts.push(`− ${show(reduction, total)}`);
        used.push(evidence(invoice, "discount", invoice.discount));
      } else if (invoice.discount.value !== null || givesDiscount(invoice.discountPercent)) {
        // A discount is printed, but not as an amount the checker can use.
        continue;
      }
      const charges: [string, CitedDecimal][] = [
        ["freight", invoice.freight],
        ["insurance", invoice.insurance],
        ...invoice.otherCharges.map((charge, index) => [`otherCharges[${index}]`, charge] as [string, CitedDecimal]),
        ["tax", invoice.tax],
      ];
      const printed = charges.filter(([, field]) => field.value !== null);
      if (printed.some(([, field]) => !num(field))) continue;
      for (const [path, field] of printed) {
        const charge = num(field)!;
        expected = add(expected, charge);
        // An amount taken off (an advance already paid) is negative.
        parts.push(compare(charge, ZERO) < 0 ? `− ${show(sub(ZERO, charge), total)}` : `+ ${show(charge, total)}`);
        used.push(evidence(invoice, path, field));
      }
      if (sameWithin(expected, total, roundingTolerance(total))) continue;
      findings.push({
        rule: "SUM-02",
        severity: "error",
        key: "SUM-02.total",
        params: { expected: show(expected, total), formula: parts.join(" "), found: invoice.total.value ?? "" },
        ...money,
        evidence: [evidence(invoice, "total", invoice.total), ...used],
      });
    }
    return findings;
  },
};

type MetricRule = { code: Metric; tolerance: (printed: Decimal) => Decimal | string };

/** SUM-03: packing list and CMR lines add up to their stated totals. */
export const documentTotals: Rule = {
  id: "SUM-03",
  run({ packingLists, cmrs, options }) {
    const findings: Finding[] = [];
    const exact: MetricRule["tolerance"] = roundingTolerance;
    const weight: MetricRule["tolerance"] = () => options.weightToleranceKg;
    const volume: MetricRule["tolerance"] = () => options.volumeToleranceM3;

    const compareTotal = (
      doc: PackingList | Cmr,
      linesTotal: Decimal | null,
      totalPath: string,
      total: PackingList["totalNetWeightKg"],
      metric: MetricRule,
    ) => {
      const stated = num(total);
      if (!linesTotal || !stated) return;
      if (sameWithin(linesTotal, stated, metric.tolerance(stated))) return;
      findings.push({
        rule: "SUM-03",
        severity: "error",
        key: "SUM-03.total",
        params: {
          document: doc.type,
          metric: metric.code,
          expected: show(linesTotal, stated),
          found: total.value ?? "",
        },
        evidence: [evidence(doc, totalPath, total)],
      });
    };

    for (const pl of packingLists) {
      compareTotal(pl, sumAll(pl.lines, (l) => l.quantity), "totalQuantity", pl.totalQuantity, { code: "quantity", tolerance: exact });
      compareTotal(pl, sumAll(pl.lines, (l) => l.packages), "totalPackages", pl.totalPackages, { code: "packages", tolerance: exact });
      compareTotal(pl, sumAll(pl.lines, (l) => l.netWeightKg), "totalNetWeightKg", pl.totalNetWeightKg, { code: "netWeightKg", tolerance: weight });
      compareTotal(pl, sumAll(pl.lines, (l) => l.grossWeightKg), "totalGrossWeightKg", pl.totalGrossWeightKg, { code: "grossWeightKg", tolerance: weight });
      compareTotal(pl, sumAll(pl.lines, (l) => l.volumeM3), "totalVolumeM3", pl.totalVolumeM3, { code: "volumeM3", tolerance: volume });
    }
    for (const cmr of cmrs) {
      compareTotal(cmr, sumAll(cmr.goods, (g) => g.packages), "totalPackages", cmr.totalPackages, { code: "packages", tolerance: exact });
      compareTotal(cmr, sumAll(cmr.goods, (g) => g.grossWeightKg), "totalGrossWeightKg", cmr.totalGrossWeightKg, { code: "grossWeightKg", tolerance: weight });
    }
    return findings;
  },
};
