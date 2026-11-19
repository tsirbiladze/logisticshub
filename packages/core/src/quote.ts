/**
 * How the numbers and dates printed in a quote can be read. The extraction
 * check compares every decimal and date value with its own quote before a
 * rule may use it: "1,880" reads 1880 or 1.880, never 1500.
 *
 * Generous by design: a quote yields every reading it could have, and a
 * pattern this module does not know makes the quote "unsure", so a value is
 * called a mismatch only when no reading of the printed text gives it.
 */
import { isIsoDate } from "./dates.ts";

export type DecimalSign = "." | ",";

export interface NumberReading {
  /** Canonical decimal, e.g. "1880" or "1.880". */
  value: string;
  /** The decimal sign this reading takes the number to use; null when it has no bearing (a plain integer). */
  decimal: DecimalSign | null;
}

export interface PrintedNumber {
  /** The number as printed, e.g. "13,300.00". */
  text: string;
  readings: NumberReading[];
  /** A "%" belongs to the number: it touches it, or stands free beside it with no other number on its far side. */
  percent: boolean;
  /** Where the number stands in the quote: [start, end). */
  start: number;
  end: number;
}

export interface QuoteNumbers {
  /** The numbers of the quote, digit groups joined into the longest numbers ("13 300,00" is one number). */
  numbers: PrintedNumber[];
  /** The same digits read as separate numbers where a space or apostrophe could also divide two numbers. */
  fragments: PrintedNumber[];
  /** Some digits are in a pattern with no known reading ("1.2.3"), so a mismatch cannot be claimed. */
  unsure: boolean;
}

/** Digits with single separators between them: one printed number, or several divided by spaces. */
const CHUNK = /[0-9]+(?:[.,'    ’][0-9]+)*/g;
/** Separators that only ever group thousands: spaces and apostrophes ("13 300,00", "13'300.00"). */
const GROUPING = "    '’";
const BLANK = " \t   ";

interface Segment {
  parts: string[];
  seps: DecimalSign[];
  /** The whole part was joined from space- or apostrophe-separated groups. */
  grouped: boolean;
  start: number;
  end: number;
}

const otherSign = (sign: DecimalSign): DecimalSign => (sign === "." ? "," : ".");

/** Readings of one number, or null when its separators follow no known pattern. */
function readSegment(segment: Segment): NumberReading[] | null {
  const { parts, seps, grouped } = segment;
  const last = seps[seps.length - 1];
  if (last === undefined) return [{ value: parts[0]!, decimal: null }];
  const other = otherSign(last);
  const threes = (groups: string[]) => groups.every((group) => group.length === 3);
  if (seps.includes(other)) {
    // Both signs: the last one is the decimal sign, once, after every thousands sign ("13,300.00", "9.684,00").
    if (seps.slice(0, -1).includes(last) || !threes(parts.slice(1, -1))) return null;
    return [{ value: `${parts.slice(0, -1).join("")}.${parts[parts.length - 1]!}`, decimal: last }];
  }
  if (seps.length > 1) {
    // One sign several times: thousands ("1.234.567").
    return threes(parts.slice(1)) ? [{ value: parts.join(""), decimal: other }] : null;
  }
  // One sign once: a decimal sign, or a thousands sign when three digits follow ("1,880").
  const whole = parts[0]!;
  const fraction = parts[1]!;
  const readings: NumberReading[] = [];
  if (!grouped && fraction.length === 3 && whole.length <= 3 && !whole.startsWith("0")) {
    readings.push({ value: `${whole}${fraction}`, decimal: other });
  }
  readings.push({ value: `${whole}.${fraction}`, decimal: last });
  return readings;
}

/** Splits a chunk into numbers; `join` reads a space or apostrophe before three digits as a thousands separator. */
function segments(chunk: string, offset: number, join: boolean): Segment[] {
  const out: Segment[] = [];
  let current: Segment | null = null;
  let firstGroup = 0;
  const groups = /[0-9]+/g;
  let previousEnd = 0;
  for (let match = groups.exec(chunk); match !== null; match = groups.exec(chunk)) {
    const group = match[0];
    const sep = match.index > 0 ? chunk.slice(previousEnd, match.index) : "";
    previousEnd = match.index + group.length;
    const end = offset + previousEnd;
    if (current && (sep === "." || sep === ",")) {
      current.parts.push(group);
      current.seps.push(sep);
      current.end = end;
    } else if (current && join && current.seps.length === 0 && group.length === 3 && firstGroup <= 3 && sep !== "" && GROUPING.includes(sep)) {
      current.parts[0] = `${current.parts[0]!}${group}`;
      current.grouped = true;
      current.end = end;
    } else {
      current = { parts: [group], seps: [], grouped: false, start: offset + match.index, end };
      firstGroup = group.length;
      out.push(current);
    }
  }
  return out;
}

const isDigitChar = (ch: string | undefined) => ch !== undefined && ch >= "0" && ch <= "9";

/**
 * Does a percent sign belong to the number at [start, end)? A sign belongs to
 * the number it touches ("20%", "%18"), never across a space to the next
 * number: in "20% 3,124.00" the amount is not a percentage. A sign that
 * stands free ("5 %", "% 5") belongs to the one number beside it, and to
 * neither when a number stands on each side.
 */
function percentAround(quote: string, start: number, end: number): boolean {
  if (quote[end] === "%") return true;
  // "%18": the sign touches this number, unless it already closes the one before it ("20%18").
  if (quote[start - 1] === "%") return !isDigitChar(quote[start - 2]);
  let after = end;
  while (after < quote.length && BLANK.includes(quote[after]!)) after++;
  if (quote[after] === "%") {
    let beyond = after + 1;
    while (beyond < quote.length && BLANK.includes(quote[beyond]!)) beyond++;
    if (!isDigitChar(quote[beyond])) return true;
  }
  let before = start - 1;
  while (before >= 0 && BLANK.includes(quote[before]!)) before--;
  if (before >= 0 && quote[before] === "%") {
    let beyond = before - 1;
    while (beyond >= 0 && BLANK.includes(quote[beyond]!)) beyond--;
    if (beyond < 0 || !isDigitChar(quote[beyond])) return true;
  }
  return false;
}

/** Every number printed in a quote with the ways it can be read. */
export function printedNumbers(quote: string): QuoteNumbers {
  const result: QuoteNumbers = { numbers: [], fragments: [], unsure: false };
  for (const match of quote.matchAll(CHUNK)) {
    const offset = match.index;
    const joined = segments(match[0], offset, true);
    const split = segments(match[0], offset, false);
    const add = (list: PrintedNumber[], segment: Segment) => {
      const readings = readSegment(segment);
      if (!readings) {
        result.unsure = true;
        return;
      }
      list.push({
        text: quote.slice(segment.start, segment.end),
        readings,
        percent: percentAround(quote, segment.start, segment.end),
        start: segment.start,
        end: segment.end,
      });
    };
    for (const segment of joined) add(result.numbers, segment);
    if (split.length !== joined.length) for (const segment of split) add(result.fragments, segment);
  }
  return result;
}

/** A currency code or sign that may stand between a bracket and its number: "(USD 500.00)", "(500.00 €)". */
const BRACKET_OPEN = /\((?:[ \t\u00a0\u202f]*(?:[A-Z]{3}|[$€£₾₺₽]))?[ \t\u00a0\u202f]*$/u;
const BRACKET_CLOSE = /^[ \t\u00a0\u202f]*(?:(?:[A-Z]{3}|[$€£₾₺₽])[ \t\u00a0\u202f]*)?\)/u;
const MINUS = "-\u2212";

/**
 * Is the number at [start, end) printed as a negative amount? Yes when it
 * stands in brackets, alone or with its currency ("(500.00)", "(USD 500.00)"),
 * or when a minus is attached to it ("-500.00", "−500.00", "− 500.00" with
 * the real minus sign). A hyphen that follows a letter or a digit is part of
 * a code or a range ("INV-500", "1-100"), a hyphen set apart by a space is a
 * dash ("Freight - 500.00"), and a hyphen after the number is not read at all
 * ("15,500.-"): none of them is a minus.
 */
export function printedNegative(quote: string, start: number, end: number): boolean {
  if (BRACKET_OPEN.test(quote.slice(0, start)) && BRACKET_CLOSE.test(quote.slice(end))) return true;
  const opensField = (index: number) => index < 0 || BLANK.includes(quote[index]!) || quote[index] === "(";
  if (MINUS.includes(quote[start - 1] ?? " ")) return opensField(start - 2);
  let before = start - 1;
  while (before >= 0 && BLANK.includes(quote[before]!)) before--;
  return before < start - 1 && quote[before] === "\u2212" && opensField(before - 1);
}

/** The decimal sign a printed number shows beyond doubt ("13,300.00" shows "."), or null. */
export function shownDecimalSign(number: PrintedNumber): DecimalSign | null {
  return number.readings.length === 1 ? number.readings[0]!.decimal : null;
}

/** The readings of a number in a document that writes decimals with `sign`; all of them when none fits. */
export function readingsWith(number: PrintedNumber, sign: DecimalSign): NumberReading[] {
  const fitting = number.readings.filter((reading) => reading.decimal === null || reading.decimal === sign);
  return fitting.length > 0 ? fitting : number.readings;
}

export type DateOrder = "dmy" | "mdy" | "ymd";

export interface DateReading {
  /** YYYY-MM-DD. */
  iso: string;
  order: DateOrder;
}

export interface PrintedDate {
  /** The date as printed, e.g. "18.09.2026". */
  text: string;
  readings: DateReading[];
  /** The year is printed with four digits at the end ("18.09.2026"), so only day and month can swap. */
  fullYearLast: boolean;
  /** The order the date shows beyond doubt ("18.09.2026" can only be day first), or null. */
  shows: "dmy" | "mdy" | null;
}

/** Three numbers with the same separator twice: "18.09.2026", "2026-09-18", "9/18/26". */
const NUMERIC_DATE = /(?<![0-9])([0-9]{1,4})[  ]*([./-])[  ]*([0-9]{1,2})[  ]*\2[  ]*([0-9]{1,4})(?![0-9])/g;

function dateReadings(a: string, b: string, c: string): DateReading[] {
  const [A, B, C] = [Number(a), Number(b), Number(c)];
  const out: DateReading[] = [];
  const push = (year: number, month: number, day: number, order: DateOrder) => {
    const iso = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (isIsoDate(iso) && !out.some((reading) => reading.iso === iso)) out.push({ iso, order });
  };
  if (a.length === 4) {
    if (c.length <= 2) push(A, B, C, "ymd");
  } else if (c.length === 4) {
    if (a.length <= 2) {
      push(C, B, A, "dmy");
      push(C, A, B, "mdy");
    }
  } else if (a.length <= 2 && c.length <= 2) {
    // A two-digit year, at the end or at the start.
    for (const century of [2000, 1900]) {
      push(century + C, B, A, "dmy");
      push(century + C, A, B, "mdy");
      push(century + A, B, C, "ymd");
    }
  }
  return out;
}

/** Every all-numeric date printed in a quote with the ways it can be read. Dates with month names are not listed. */
export function printedDates(quote: string): PrintedDate[] {
  const dates: PrintedDate[] = [];
  for (const match of quote.matchAll(NUMERIC_DATE)) {
    const [a, b, c] = [match[1]!, match[3]!, match[4]!];
    const readings = dateReadings(a, b, c);
    if (readings.length === 0) continue;
    const fullYearLast = c.length === 4 && a.length <= 2;
    // Day and month can swap only when both numbers are 12 or less; when they are equal the order shows nothing.
    const dayFirst = fullYearLast && Number(b) <= 12;
    const monthFirst = fullYearLast && Number(a) <= 12;
    const shows = readings.length !== 1 || dayFirst === monthFirst ? null : dayFirst ? "dmy" : "mdy";
    dates.push({ text: match[0], readings, fullYearLast, shows });
  }
  return dates;
}

/** The readings of a date in a document that writes dates in `order`; all of them when none fits. */
export function dateReadingsWith(date: PrintedDate, order: "dmy" | "mdy"): DateReading[] {
  if (!date.fullYearLast) return date.readings;
  const fitting = date.readings.filter((reading) => reading.order === order);
  return fitting.length > 0 ? fitting : date.readings;
}

/** Lower case without accents, Turkish İ/I/ı as i: "Şubat" -> "subat", "май" -> "маи". The same folding as names get. */
const foldWord = (value: string) =>
  value
    .replace(/[İIı]/gu, "i")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "");

/** Each stem with every ending; an empty stem gives no word. */
const cases = (stems: string[], endings: string[]) => stems.map((stem) => (stem ? endings.map((ending) => `${stem}${ending}`) : []));
const each = (names: string) => names.split(" ").map((name) => (name === "-" ? [] : name.split("/")));

/**
 * The words that name a month, per language, twelve entries per table
 * (January first): the names, their usual abbreviations, and the case forms
 * Georgian and Russian print ("5 ოქტომბრის", "5 октября").
 */
const MONTH_NAMES: Record<MonthLanguage, string[][][]> = {
  en: [each("january february march april may june july august september october november december"), each("jan feb mar apr may jun jul aug sep/sept oct nov dec")],
  // Names only: the Turkish abbreviations are also everyday words ("ara", "tem").
  tr: [each("ocak şubat mart nisan mayıs haziran temmuz ağustos eylül ekim kasım aralık")],
  // The stem with its case endings, then the abbreviations.
  ru: [
    cases(["январ", "феврал", "", "апрел", "", "июн", "июл", "", "сентябр", "октябр", "ноябр", "декабр"], ["ь", "я", "е", "ю", "ем"]),
    cases(["", "", "март", "", "", "", "", "август", "", "", "", ""], ["", "а", "е", "у", "ом"]),
    each("- - - - май/мая/мае/маю/маем - - - - - - -"),
    each("янв фев/февр - апр - - - авг сен/сент окт ноя/нояб дек"),
  ],
  // The name with its case endings (the stem shortens in the genitive: ოქტომბერი, ოქტომბრის), then the abbreviations.
  ka: [
    cases(["იანვარ", "თებერვალ", "მარტ", "აპრილ", "მაის", "ივნის", "ივლის", "", "სექტემბერ", "ოქტომბერ", "ნოემბერ", "დეკემბერ"], ["ი", "ს", "ის", "ში", "ით", "იდან", "ამდე"]),
    cases(["იანვრ", "თებერვლ", "", "", "", "", "", "", "სექტემბრ", "ოქტომბრ", "ნოემბრ", "დეკემბრ"], ["ის", "ით", "იდან", "ამდე"]),
    cases(["", "", "", "", "", "", "", "აგვისტო", "", "", "", ""], ["", "ს", "ში", "დან", "მდე"]),
    each("იანვ თებ - აპრ - ივნ ივლ აგვ სექ/სექტ ოქტ ნოემ დეკ"),
  ],
};

export type MonthLanguage = "en" | "ka" | "ru" | "tr";

/** Every word that names a month in a language, folded, with the month it names (1 to 12). */
export const MONTH_WORDS = Object.fromEntries(
  Object.entries(MONTH_NAMES).map(([language, tables]) => [
    language,
    Object.fromEntries(tables.flatMap((table) => table.flatMap((words, index) => words.map((word) => [foldWord(word), index + 1] as const)))),
  ]),
) as Record<MonthLanguage, Record<string, number>>;

const CLOCK_TIME = /[0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?/g;

/**
 * The date a quote prints with a month name: "14 Oct 2026", "October 14,
 * 2026", "«05» октября 2026 г.", "2026 წლის 5 ოქტომბერი", "5 Ekim 2026".
 * Returned as YYYY-MM-DD, or null when the quote is not such a date beyond
 * doubt: it must name exactly one month and print exactly one day (1 to 31)
 * and one four-digit year, and no other number apart from a time of day.
 *
 * A month is read in the document's own language or in English, and in no
 * other: in a French or Spanish date "mar." is Tuesday, not March, so a
 * document in a language this module does not know is left alone.
 */
export function monthNameDate(quote: string, language: string | null): string | null {
  if (language === null || !Object.hasOwn(MONTH_WORDS, language)) return null;
  const own = MONTH_WORDS[language as MonthLanguage];
  const monthOf = (word: string): number | undefined => (Object.hasOwn(own, word) ? own[word] : Object.hasOwn(MONTH_WORDS.en, word) ? MONTH_WORDS.en[word] : undefined);
  const months = (foldWord(quote).match(/\p{L}+/gu) ?? []).flatMap((word) => monthOf(word) ?? []);
  if (months.length !== 1) return null;
  let day: string | null = null;
  let year: string | null = null;
  for (const digits of quote.replace(CLOCK_TIME, " ").match(/[0-9]+/g) ?? []) {
    const number = Number(digits);
    if (digits.length === 4 && number >= 1900 && number <= 2100 && year === null) year = digits;
    else if (digits.length <= 2 && number >= 1 && number <= 31 && day === null) day = digits;
    else return null;
  }
  if (day === null || year === null) return null;
  const iso = `${year}-${String(months[0]).padStart(2, "0")}-${day.padStart(2, "0")}`;
  return isIsoDate(iso) ? iso : null;
}

/**
 * ISO 4217 codes in use, without ALL and TOP: in capitals those two are
 * ordinary words ("ALL PRICES IN US DOLLARS"). Codes no longer in use (RUR,
 * BYR, TRL) are left out too: a document may still print one where the value
 * rightly gives its successor.
 */
export const CURRENCY_CODES: readonly string[] = (
  "AED AFN AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD CAD CDF CHF CLP CNY COP CRC CUP CVE CZK " +
  "DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR " +
  "KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB " +
  "PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TRY TTD TWD TZS " +
  "UAH UGX USD UYU UZS VES VND VUV WST XAF XCD XCG XOF XPF YER ZAR ZMW ZWG"
).split(" ");

/** Currency signs with the codes each can stand for; the first is the usual one. */
export const CURRENCY_SIGNS: Record<string, readonly string[]> = {
  "€": ["EUR"],
  "₾": ["GEL"],
  "₺": ["TRY"],
  "₽": ["RUB"],
  "₴": ["UAH"],
  "₸": ["KZT"],
  "₼": ["AZN"],
  "֏": ["AMD"],
  "₹": ["INR"],
  "₪": ["ILS"],
  "£": ["GBP", "EGP", "LBP", "SYP", "SDG", "SSP", "GIP", "FKP", "SHP"],
  "¥": ["JPY", "CNY"],
  $: ["USD", "CAD", "AUD", "NZD", "SGD", "HKD", "TWD", "MXN", "ARS", "CLP", "COP", "UYU", "BRL", "BSD", "BBD", "BZD", "BMD", "BND", "KYD", "XCD", "FJD", "GYD", "JMD", "LRD", "NAD", "SBD", "SRD", "TTD", "DOP", "CUP", "ZWG"],
};

const CODE_IN_TEXT = /(?<![\p{L}\p{N}])[A-Z]{3}(?![\p{L}\p{N}])/gu;

/**
 * The one currency a quote names by code or sign when the value is not it:
 * "USD 15,500.00" for a value of EUR. Null when the quote names the value's
 * own currency (a sign that can stand for it counts: "$" for CAD), names no
 * currency this module knows, or names several. Null too when the quote has
 * any other word in it: in "US dollars, payment CAD" the code is a payment
 * term (cash against documents), so only a quote of a code or sign, alone or
 * with its amount, is read.
 */
export function otherCurrency(value: string, quote: string): string | null {
  const known = (code: string) => CURRENCY_CODES.includes(code);
  const codes = [...new Set(quote.match(CODE_IN_TEXT) ?? [])].filter(known);
  if (/\p{L}/u.test(quote.replace(CODE_IN_TEXT, (code) => (known(code) ? "" : code)))) return null;
  const signs = [...new Set(Array.from(quote))].filter((sign) => Object.hasOwn(CURRENCY_SIGNS, sign));
  if (codes.includes(value) || signs.some((sign) => CURRENCY_SIGNS[sign]!.includes(value))) return null;
  const named = [...new Set([...codes, ...signs.map((sign) => CURRENCY_SIGNS[sign]![0]!)])];
  return named.length === 1 ? named[0]! : null;
}

export function rsDate(quote: string): string | null {
  const m = /^([0-9]{2})\.([0-9]{2})\.([0-9]{4})$/.exec(quote);
  if (!m) return null;
  const value = `${m[3]}-${m[2]}-${m[1]}`;
  return isIsoDate(value) ? value : null;
}

/** Expand scientific notation using digits, never floating-point arithmetic. */
export function jsonDecimal(quote: string): string | null {
  const m = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(quote);
  if (!m) return null;
  const [, sign, whole, fraction = "", exponent] = m;
  if (exponent === undefined) return quote;
  const shift = Number(exponent);
  // shortcut: cap exponent expansion to bound allocation on untrusted input; raise for a documented larger range.
  if (!Number.isInteger(shift) || Math.abs(shift) > 1000) return null;
  const digits = whole! + fraction;
  const point = whole!.length + shift;
  if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
  const left = digits.slice(0, point).padEnd(point, "0").replace(/^0+(?=[0-9])/, "");
  return `${sign}${left}${point < digits.length ? "." + digits.slice(point) : ""}`;
}
