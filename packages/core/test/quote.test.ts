import { describe, expect, it } from "vitest";
import { parseExtraction, SCHEMA_VERSION, blankDocument, type CommercialInvoice } from "../src/index.ts";
import { MONTH_WORDS, monthNameDate, otherCurrency, printedDates, printedNegative, printedNumbers, readingsWith, shownDecimalSign } from "../src/quote.ts";

const readings = (quote: string) => printedNumbers(quote).numbers.map((n) => n.readings.map((r) => r.value));

describe("printedNumbers", () => {
  it.each<[string, string[][]]>([
    ["EUR 13,300.00", [["13300.00"]]],
    ["9.684,00", [["9684.00"]]],
    ["13 300,00", [["13300.00"]]],
    ["13 300,00", [["13300.00"]]],
    ["13'300.00", [["13300.00"]]],
    ["1,880 კგ", [["1880", "1.880"]]],
    ["16.560", [["16560", "16.560"]]],
    ["145.00", [["145.00"]]],
    ["0,880", [["0.880"]]],
    ["1234,567", [["1234.567"]]],
    ["1.234.567", [["1234567"]]],
    ["100 ყუთი / 100 ცალი", [["100"], ["100"]]],
    ["2 400", [["2400"]]],
    ["no digits", []],
  ])("%s", (quote, expected) => {
    expect(readings(quote)).toEqual(expected);
  });

  it("also reads space-separated groups as separate numbers", () => {
    const { numbers, fragments } = printedNumbers("60 100");
    expect(numbers.map((n) => n.text)).toEqual(["60 100"]);
    expect(fragments.map((n) => n.text)).toEqual(["60", "100"]);
    expect(printedNumbers("12 6").fragments).toEqual([]);
    expect(printedNumbers("12 6").numbers.map((n) => n.text)).toEqual(["12", "6"]);
  });

  it("is unsure about patterns it does not know", () => {
    expect(printedNumbers("1.2.3")).toMatchObject({ numbers: [], unsure: true });
    expect(printedNumbers("1,23,456.00").unsure).toBe(true);
    expect(printedNumbers("1,2.3,4").unsure).toBe(true);
  });

  it("knows which decimal sign a number shows", () => {
    const sign = (quote: string) => shownDecimalSign(printedNumbers(quote).numbers[0]!);
    expect(sign("13,300.00")).toBe(".");
    expect(sign("9.684,00")).toBe(",");
    expect(sign("20 820,00")).toBe(",");
    expect(sign("2,5")).toBe(",");
    expect(sign("1.234.567")).toBe(",");
    expect(sign("1,880")).toBeNull();
    expect(sign("1880")).toBeNull();
    const [number] = printedNumbers("1,880").numbers;
    expect(readingsWith(number!, ".").map((r) => r.value)).toEqual(["1880"]);
    expect(readingsWith(number!, ",").map((r) => r.value)).toEqual(["1.880"]);
    // A convention never removes the only reading.
    expect(readingsWith(printedNumbers("145,5").numbers[0]!, ".").map((r) => r.value)).toEqual(["145.5"]);
  });

  it("sees a percent sign on either side", () => {
    expect(printedNumbers("5%").numbers[0]?.percent).toBe(true);
    expect(printedNumbers("5 %").numbers[0]?.percent).toBe(true);
    expect(printedNumbers("%18").numbers[0]?.percent).toBe(true);
    expect(printedNumbers("VAT 18%: 2,790.00").numbers.map((n) => n.percent)).toEqual([true, false]);
    expect(printedNumbers("% 5").numbers[0]?.percent).toBe(true);
  });

  it("gives a percent sign to the number it touches, never across a space to the next one", () => {
    const percents = (quote: string) => printedNumbers(quote).numbers.map((n) => n.percent);
    expect(percents("20% 3,124.00")).toEqual([true, false]);
    expect(percents("%18 1.743,12")).toEqual([true, false]);
    expect(percents("3,124.00 20%")).toEqual([false, true]);
    expect(percents("1.743,12 %18")).toEqual([false, true]);
    expect(percents("20%18")).toEqual([true, false]);
    expect(percents("5% 10%")).toEqual([true, true]);
    // A sign that stands free belongs to the one number beside it, and to neither between two numbers.
    expect(percents("VAT 18 % (2,790.00)")).toEqual([true, false]);
    expect(percents("KDV % 18")).toEqual([true]);
    expect(percents("20 % 3,124.00")).toEqual([false, false]);
  });
});

describe("printedDates", () => {
  const isos = (quote: string) => printedDates(quote).map((d) => d.readings.map((r) => r.iso));

  it.each<[string, string[][]]>([
    ["18.09.2026", [["2026-09-18"]]],
    ["19.09.2026, 09:00", [["2026-09-19"]]],
    ["2026-09-18", [["2026-09-18"]]],
    ["09/18/2026", [["2026-09-18"]]],
    ["05.10.2026", [["2026-10-05", "2026-05-10"]]],
    ["05.05.2026", [["2026-05-05"]]],
    ["18. 09. 2026", [["2026-09-18"]]],
    // Two-digit years: day first, or year first, in this century or the last.
    ["18.09.26", [["2026-09-18", "2018-09-26", "1926-09-18", "1918-09-26"]]],
    ["14 Oct 2026", []],
    ["«05» октября 2026 г.", []],
    ["31.02.2026", []],
    ["05.10.2026 / 12.10.2026", [["2026-10-05", "2026-05-10"], ["2026-10-12", "2026-12-10"]]],
  ])("%s", (quote, expected) => {
    expect(isos(quote)).toEqual(expected);
  });

  it("knows which order a date shows", () => {
    const shows = (quote: string) => printedDates(quote)[0]?.shows;
    expect(shows("18.09.2026")).toBe("dmy");
    expect(shows("09/18/2026")).toBe("mdy");
    expect(shows("05.10.2026")).toBeNull();
    expect(shows("05.05.2026")).toBeNull();
    expect(shows("2026-09-18")).toBeNull();
    expect(shows("18.09.26")).toBeNull();
  });
});

describe("monthNameDate", () => {
  it.each<[string, string, string]>([
    ["en", "14 Oct 2026", "2026-10-14"],
    ["en", "14 October 2026", "2026-10-14"],
    ["en", "October 14, 2026", "2026-10-14"],
    ["en", "Oct. 14th, 2026", "2026-10-14"],
    ["en", "14-Oct-2026", "2026-10-14"],
    ["en", "1st of May 2026", "2026-05-01"],
    ["en", "Sept 3, 2026", "2026-09-03"],
    ["en", "2026 March 9", "2026-03-09"],
    ["en", "Wed 14 OCTOBER 2026, 09:30", "2026-10-14"],
    ["ru", "«05» октября 2026 г.", "2026-10-05"],
    ["ru", "от «22» сентября 2026 г.", "2026-09-22"],
    ["ru", "5 мая 2026 года", "2026-05-05"],
    ["ru", "3 марта 2026", "2026-03-03"],
    ["ru", "12 авг. 2026 г.", "2026-08-12"],
    ["ru", "7 Февраля 2026", "2026-02-07"],
    ["ka", "5 ოქტომბერი, 2026", "2026-10-05"],
    ["ka", "2026 წლის 5 ოქტომბერი", "2026-10-05"],
    ["ka", "2026 წლის 5 ოქტომბერს", "2026-10-05"],
    ["ka", "2026 წლის 5 ოქტომბრის", "2026-10-05"],
    ["ka", "18 სექტემბერი 2026 წ.", "2026-09-18"],
    ["ka", "1 აგვისტოს, 2026", "2026-08-01"],
    ["ka", "3 თებერვლიდან, 2026", "2026-02-03"],
    ["ka", "9 იანვ. 2026", "2026-01-09"],
    ["tr", "5 Ekim 2026", "2026-10-05"],
    ["tr", "05 EKİM 2026", "2026-10-05"],
    ["tr", "12 Şubat 2026", "2026-02-12"],
    ["tr", "3 Ağustos 2026 Pazartesi", "2026-08-03"],
    ["tr", "21 Aralık 2026", "2026-12-21"],
    ["tr", "1 MAYIS 2026", "2026-05-01"],
    // English month names are read on a document in any of the four languages.
    ["ka", "14 Oct 2026", "2026-10-14"],
    ["ru", "14 October 2026", "2026-10-14"],
    ["tr", "14 Oct 2026", "2026-10-14"],
  ])("a document in %s: %s", (language, quote, iso) => {
    expect(monthNameDate(quote, language)).toBe(iso);
  });

  it.each<[string | null, string]>([
    ["en", "14.10.2026"], // no month name
    ["en", "Oct 2026"], // no day
    ["en", "14 Oct"], // no year
    ["en", "14 Oct 26"], // a two-digit year: which number is the day?
    ["en", "14 Oct 2026 / 16 Oct 2026"], // two dates
    ["en", "from 1 Oct to 31 Dec 2026"], // two months
    ["en", "14 Oktober 2026"], // a language this table does not know
    ["en", "14 oct. 2026 ref 118"], // another number
    ["en", "31 Feb 2026"], // not a date
    ["en", "0 Oct 2026"],
    ["en", "32 Oct 2026"],
    ["en", "14 Oct 1026"],
    ["ru", "5 marta 2026"], // Russian in Latin letters
    ["en", "maybe 14, 2026"], // "may" only as a word of its own
    ["en", ""],
    // A month is read in the document's language or in English only.
    ["en", "5 октября 2026"],
    ["ru", "5 Ekim 2026"],
    ["tr", "2026 წლის 5 ოქტომბერი"],
    // In a language outside the four, a word that looks like a month may be something else: "mar." is Tuesday in French and Spanish.
    ["other", "mar. 14 avr. 2026"],
    ["other", "mar 14 abr 2026"],
    ["other", "14 Oct 2026"],
    [null, "14 Oct 2026"],
    ["de", "14 Oct 2026"],
    ["constructor", "14 Oct 2026"],
  ])("a document in %s: is silent about %j", (language, quote) => {
    expect(monthNameDate(quote, language)).toBeNull();
  });

  it("knows the twelve months of each language, in every case form the guide names", () => {
    const months = (language: "en" | "ka" | "ru" | "tr", words: string[]) => words.map((word) => MONTH_WORDS[language][word]);
    const all = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    expect(months("en", ["january", "feb", "march", "apr", "may", "june", "jul", "august", "sept", "oct", "november", "dec"])).toEqual(all);
    // Folded: Turkish without dots and cedillas, Russian й as и.
    expect(months("tr", ["ocak", "subat", "mart", "nisan", "mayis", "haziran", "temmuz", "agustos", "eylul", "ekim", "kasim", "aralik"])).toEqual(all);
    expect(months("ru", ["января", "февраль", "марте", "апреля", "маи", "июня", "июль", "августа", "сентября", "октябрь", "ноября", "декабря"])).toEqual(all);
    expect(months("ka", ["იანვარი", "თებერვალს", "მარტის", "აპრილი", "მაისს", "ივნისის", "ივლისი", "აგვისტო", "სექტემბრის", "ოქტომბერს", "ნოემბერი", "დეკემბრის"])).toEqual(all);
    expect(Object.keys(MONTH_WORDS).sort()).toEqual(["en", "ka", "ru", "tr"]);
    for (const table of Object.values(MONTH_WORDS)) expect([...new Set(Object.values(table))].sort((a, b) => a - b)).toEqual(all);
  });
});

describe("printedNegative", () => {
  const negative = (quote: string) => {
    const { numbers } = printedNumbers(quote);
    expect(numbers).toHaveLength(1);
    return printedNegative(quote, numbers[0]!.start, numbers[0]!.end);
  };

  it.each(["(500.00)", "( 500.00 )", "(USD 500.00)", "USD (500.00)", "(500.00 €)", "-500.00", "USD -500.00", "\u2212500.00", "\u2212 500,00", "(-500.00)", "Advance paid: (5,000.00)"])(
    "%s is a negative amount",
    (quote) => {
      expect(negative(quote)).toBe(true);
    },
  );

  it.each(["500.00", "USD 500.00", "- 500.00", "Freight - 500.00", "INV-500", "500.00-", "15,500.-", "15,500/-", "(net) 500.00", "(500.00", "500.00)", "500.00 (five hundred)", "-USD 500.00"])(
    "%s is not said to be negative",
    (quote) => {
      expect(negative(quote)).toBe(false);
    },
  );
});

describe("otherCurrency", () => {
  it.each<[string, string, string | null]>([
    ["EUR", "USD", "USD"],
    ["EUR", "USD 15,500.00", "USD"],
    ["EUR", "$ 15,500.00", "USD"],
    ["USD", "€", "EUR"],
    ["USD", "13 300,00 ₾", "GEL"],
    ["EUR", "USD $", "USD"],
    // The quote names the value's own currency, or a sign that can stand for it.
    ["USD", "USD", null],
    ["USD", "US$ 15,500.00", null],
    ["CAD", "$ 100.00", null],
    ["EUR", "EUR / 18.10.2026", null],
    ["EUR", "EUR (USD 14,400.00)", null],
    ["GBP", "£120", null],
    // Nothing this module knows, or more than one thing.
    ["USD", "US dollars", null],
    ["GEL", "ლარი", null],
    ["RUB", "RUR", null],
    ["TRY", "TL", null],
    ["EUR", "usd", null],
    ["EUR", "USD / GEL", null],
    ["EUR", "USD ₾", null],
    ["USD", "ALL PRICES IN US DOLLARS", null],
    ["EUR", "FCA", null],
    ["EUR", "USDT", null],
    ["EUR", "XUSD", null],
    ["EUR", "USD1", null],
    ["EUR", "ლUSD", null],
    ["EUR", "", null],
    // Any other word in the quote: it is more than a currency with its amount, and a code in it may be something else.
    ["EUR", "Currency: USD", null],
    ["USD", "US dollars, payment CAD", null],
    ["EUR", "USD only", null],
    ["EUR", "USD 15,500.00 (fifteen thousand)", null],
    ["EUR", "USD ლარი", null],
    ["EUR", "15,500.00 USD", "USD"],
    ["EUR", "(USD) 15 500,00", "USD"],
  ])("a value of %s quoted as %j names %s", (value, quote, named) => {
    expect(otherCurrency(value, quote)).toBe(named);
  });
});

describe("values against their quotes", () => {
  const c = (value: string | null, quote: string | null = value) => ({ value, quote, page: value === null ? null : 1 });

  function checkAll(change: (invoice: CommercialInvoice) => void) {
    const invoice = blankDocument("commercial_invoice", "invoice");
    change(invoice);
    const result = parseExtraction({ schemaVersion: SCHEMA_VERSION, documents: [invoice] });
    return result.issues.map((i) => `${i.path.replace("documents[0].", "")}: ${i.code}: ${i.message}`);
  }
  const check = checkAll;

  it("accepts every reading when the document does not show its decimal sign", () => {
    expect(check((d) => void (d.grossWeightKg = c("1880", "1,880")))).toEqual([]);
    expect(check((d) => void (d.grossWeightKg = c("1.880", "1,880")))).toEqual([]);
    expect(check((d) => void (d.grossWeightKg = c("1.88", "1,880 kg")))).toEqual([]);
  });

  it("rejects a value no reading of the quote gives", () => {
    expect(check((d) => void (d.grossWeightKg = c("1800", "1,880 kg")))).toEqual([
      'grossWeightKg: EXT_QUOTE_MISMATCH: "1800" does not match the quote "1,880 kg", which reads 1880 or 1.880.',
    ]);
    expect(check((d) => void (d.total = c("15500.00", "USD 15,550.00")))).toEqual([
      'total: EXT_QUOTE_MISMATCH: "15500.00" does not match the quote "USD 15,550.00", which reads 15550.00.',
    ]);
  });

  it("reads thousands and decimals the way the document's other numbers show", () => {
    // Turkish: 9.684,00 shows the comma is the decimal sign, so 16.560 is sixteen thousand.
    const turkish = (weight: string) =>
      check((d) => {
        d.total = c("9684.00", "9.684,00");
        d.grossWeightKg = c(weight, "16.560");
      });
    expect(turkish("16560")).toEqual([]);
    expect(turkish("16.560")).toEqual([
      'grossWeightKg: EXT_QUOTE_MISMATCH: "16.560" does not match the quote "16.560": this document writes decimals with "," (as in "9.684,00"), so the quote reads 16560.',
    ]);
    // Numbers that show different signs: no convention, both readings stand.
    expect(
      check((d) => {
        d.total = c("9684.00", "9.684,00");
        d.subtotal = c("9684.00", "9,684.00");
        d.grossWeightKg = c("16.560", "16.560");
      }),
    ).toEqual([]);
  });

  it("compares sizes, not signs, and leaves what it cannot read alone", () => {
    expect(check((d) => void (d.discount = c("-500.00", "(500.00)")))).toEqual([]);
    expect(check((d) => void (d.discount = c("500.00", "- 500,00")))).toEqual([]);
    expect(check((d) => void (d.packages = c("2", "two cartons")))).toEqual([]);
    expect(check((d) => void (d.packages = c("123", "1.2.3")))).toEqual([]);
    expect(check((d) => void (d.packages = c("100", "100 ცალი / 100 მუყაოს ყუთი")))).toEqual([]);
    expect(check((d) => void (d.total = c("20820.00", "20 820,00")))).toEqual([]);
    expect(check((d) => void (d.total = c("20820", "20 820,00")))).toEqual([]);
  });

  it("does not call an amount a percentage because a rate stands next to it", () => {
    // A rate printed before the amount, in the English and in the Turkish form.
    expect(check((d) => void (d.tax = c("3124.00", "20% 3,124.00")))).toEqual([]);
    expect(check((d) => void (d.tax = c("1743.12", "%18 1.743,12")))).toEqual([]);
    expect(check((d) => void (d.tax = c("3124.00", "3,124.00 (20%)")))).toEqual([]);
    expect(check((d) => void (d.tax = c("3124.00", "20 % 3,124.00")))).toEqual([]);
    // The rate itself is still a percentage, wherever the amount stands.
    const percentage = (value: string, quote: string) =>
      `tax: EXT_PERCENTAGE: "${value}" is a percentage in the quote "${quote}", and this field takes an amount. Give the printed amount, or null when only a rate is printed.`;
    expect(check((d) => void (d.tax = c("20", "20%")))).toEqual([percentage("20", "20%")]);
    expect(check((d) => void (d.tax = c("18", "%18")))).toEqual([percentage("18", "%18")]);
    expect(check((d) => void (d.tax = c("20", "20% 3,124.00")))).toEqual([percentage("20", "20% 3,124.00")]);
    expect(check((d) => void (d.tax = c("18", "%18 1.743,12")))).toEqual([percentage("18", "%18 1.743,12")]);
    expect(check((d) => void (d.discountPercent = c("5", "5%")))).toEqual([]);
  });

  it("checks a date written with a month name, and stays silent where the quote is not one beyond doubt", () => {
    // The month is read in the document's language (or in English), so the document has to say what it is.
    const check = (change: (invoice: CommercialInvoice) => void, language: CommercialInvoice["language"] = "en") =>
      checkAll((d) => {
        d.language = language;
        change(d);
      });
    expect(check((d) => void (d.date = c("2026-10-14", "14 Oct 2026")))).toEqual([]);
    expect(check((d) => void (d.date = c("2026-11-14", "14 Oct 2026")))).toEqual([
      'date: EXT_QUOTE_MISMATCH: "2026-11-14" does not match the quote "14 Oct 2026", which reads 2026-10-14.',
    ]);
    expect(check((d) => void (d.date = c("2026-10-15", "14 Oct 2026")))).toEqual([
      'date: EXT_QUOTE_MISMATCH: "2026-10-15" does not match the quote "14 Oct 2026", which reads 2026-10-14.',
    ]);
    expect(check((d) => void (d.contractRef.date = c("2026-09-21", "от «22» сентября 2026 г.")), "ru")).toEqual([
      'contractRef.date: EXT_QUOTE_MISMATCH: "2026-09-21" does not match the quote "от «22» сентября 2026 г.", which reads 2026-09-22.',
    ]);
    expect(check((d) => void (d.date = c("2026-10-05", "2026 წლის 5 ოქტომბერი")), "ka")).toEqual([]);
    expect(check((d) => void (d.date = c("2026-10-05", "5 Ekim 2026")), "tr")).toEqual([]);
    expect(check((d) => void (d.date = c("2026-11-05", "5 Ekim 2026")), "tr")).toEqual(['date: EXT_QUOTE_MISMATCH: "2026-11-05" does not match the quote "5 Ekim 2026", which reads 2026-10-05.']);
    // A document in another language, or in none: a word that looks like a month is not trusted ("mar." is Tuesday in French).
    expect(check((d) => void (d.date = c("2026-04-14", "mar. 14 avr. 2026")), "other")).toEqual([]);
    expect(check((d) => void (d.date = c("2026-04-14", "mar 14 abr 2026")), "other")).toEqual([]);
    expect(check((d) => void (d.date = c("2026-01-01", "14 Oct 2026")), "other")).toEqual([]);
    expect(check((d) => void (d.date = c("2026-01-01", "14 Oct 2026")), null)).toEqual([]);
    // Not a month-name date beyond doubt: whatever the value, nothing is said.
    for (const quote of ["14 Oct 26", "14 Oktober 2026", "1 Oct to 31 Dec 2026", "Oct 2026", "the fourteenth of October"]) {
      expect(check((d) => void (d.date = c("2026-01-01", quote))), quote).toEqual([]);
    }
  });

  it("checks the sign of a charge printed in brackets or with a minus", () => {
    const negative = (path: string, value: string, quote: string) =>
      `${path}: EXT_QUOTE_MISMATCH: "${value}" does not match the quote "${quote}": an amount printed in brackets or with a minus is negative, so the quote reads -${value}.`;
    expect(check((d) => void (d.otherCharges = [c("500.00", "(500.00)")]))).toEqual([negative("otherCharges[0]", "500.00", "(500.00)")]);
    expect(check((d) => void (d.freight = c("500.00", "-500.00")))).toEqual([negative("freight", "500.00", "-500.00")]);
    expect(check((d) => void (d.insurance = c("120.5", "(USD 120.5)")))).toEqual([negative("insurance", "120.5", "(USD 120.5)")]);
    expect(check((d) => void (d.tax = c("500.00", "\u2212 500,00")))).toEqual([negative("tax", "500.00", "\u2212 500,00")]);
    // The right sign, and an amount the invoice takes off without printing a sign (an advance), are both fine.
    expect(check((d) => void (d.otherCharges = [c("-500.00", "(500.00)"), c("-5000.00", "USD 5,000.00"), c("-120.00", "-120.00")]))).toEqual([]);
    // Not a minus beyond doubt: a dash, a code, a trailing sign, a second number in the quote.
    for (const quote of ["- 500.00", "Freight - 500.00", "F-500.00", "500.00-", "500.00 (5%)", "(500.00) 2", "500.00"]) {
      expect(check((d) => void (d.freight = c("500.00", quote))), quote).toEqual([]);
    }
    expect(check((d) => void (d.freight = c("0.00", "(0.00)")))).toEqual([]);
    // A discount is a reduction whichever way it is printed, and the other fields are not charges.
    expect(check((d) => void (d.discount = c("500.00", "(500.00)")))).toEqual([]);
    expect(check((d) => void (d.total = c("500.00", "(500.00)")))).toEqual([]);
    expect(check((d) => void (d.packages = c("82", "(82)")))).toEqual([]);
  });

  it("checks a currency against the code or sign its quote names", () => {
    expect(check((d) => void (d.currency = c("EUR", "USD")))).toEqual(['currency: EXT_QUOTE_MISMATCH: "EUR" does not match the quote "USD", which names USD.']);
    expect(check((d) => void (d.currency = c("EUR", "$ 15,500.00")))).toEqual(['currency: EXT_QUOTE_MISMATCH: "EUR" does not match the quote "$ 15,500.00", which names USD.']);
    expect(check((d) => void (d.currency = c("USD", "13 300,00 ₾")))).toEqual(['currency: EXT_QUOTE_MISMATCH: "USD" does not match the quote "13 300,00 ₾", which names GEL.']);
    for (const [value, quote] of [["USD", "USD"], ["USD", "$"], ["CAD", "$"], ["USD", "US dollars"], ["GEL", "ლარი"], ["RUB", "RUR"], ["TRY", "TL"], ["EUR", "EUR (USD 14,400.00)"], ["EUR", "USD / GEL"], ["USD", "ALL PRICES IN US DOLLARS"]] as const) {
      expect(check((d) => void (d.currency = c(value, quote))), `${value} ${quote}`).toEqual([]);
    }
  });

  it("checks all-numeric dates", () => {
    expect(check((d) => void (d.date = c("2026-09-18", "18.09.2026")))).toEqual([]);
    expect(check((d) => void (d.date = c("2026-09-19", "18.09.2026")))).toEqual([
      'date: EXT_QUOTE_MISMATCH: "2026-09-19" does not match the quote "18.09.2026", which reads 2026-09-18.',
    ]);
    // Day or month first: either, until another date of the document settles it.
    expect(check((d) => void (d.date = c("2026-05-10", "05/10/2026")))).toEqual([]);
    expect(
      check((d) => {
        d.date = c("2026-05-10", "05/10/2026");
        d.contractRef.date = c("2026-09-18", "09/18/2026");
      }),
    ).toEqual([]);
    expect(
      check((d) => {
        d.date = c("2026-10-05", "05/10/2026");
        d.contractRef.date = c("2026-09-18", "09/18/2026");
      }),
    ).toEqual([
      'date: EXT_QUOTE_MISMATCH: "2026-10-05" does not match the quote "05/10/2026": this document writes the month before the day (as in "09/18/2026"), so the quote reads 2026-05-10.',
    ]);
  });
});
