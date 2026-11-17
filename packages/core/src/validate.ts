/**
 * Parses an extraction and reports problems without throwing:
 * - shape problems (wrong types, missing fields, another schema version) make
 *   the extraction unusable (see shape.ts for their wording);
 * - field problems are listed per field so the extractor can fix them: a
 *   wrong format ("13,300.00" instead of "13300.00"), a value without a
 *   quote, a value that is not a reading of its own quote ("1.880" quoted as
 *   "1,880" in a document that prints "13,300.00"; November for "14 Oct
 *   2026"; 500.00 for the charge "(500.00)"; EUR for "USD"), a percentage
 *   where an amount belongs.
 *
 * A value with a format, quote or percentage problem is unusable: the rules
 * treat it as unreadable and never build a finding on it.
 */
import { isIsoDate } from "./dates.ts";
import { abs, compare, equals, isCanonicalDecimal, parseDecimal, ZERO, type Decimal } from "./decimal.ts";
import { walkCited, type CitedVisit } from "./introspect.ts";
import {
  dateReadingsWith,
  monthNameDate,
  otherCurrency,
  printedDates,
  printedNegative,
  printedNumbers,
  readingsWith,
  shownDecimalSign,
  type DecimalSign,
  type PrintedNumber,
} from "./quote.ts";
import { documentSchema, extractionSchema, type Extraction, type TradeDocument } from "./schema.ts";
import { shapeIssues, TOP_LEVEL } from "./shape.ts";

export { isIsoDate } from "./dates.ts";

export type ExtractionIssueCode =
  | "EXT_SHAPE"
  | "EXT_DUPLICATE_ID"
  | "EXT_DECIMAL_FORMAT"
  | "EXT_DATE_FORMAT"
  | "EXT_CURRENCY_FORMAT"
  /** The value is not a reading of its own quote: a number, a date, the sign of a charge, or a currency. */
  | "EXT_QUOTE_MISMATCH"
  /** A percentage ("5%") in a field that takes an amount. */
  | "EXT_PERCENTAGE"
  | "EXT_UNCITED"
  | "EXT_PAGE"
  /** CLI only: a model call for one file failed, so the file was left out. */
  | "EXT_MODEL";

export interface ExtractionIssue {
  code: ExtractionIssueCode;
  path: string;
  message: string;
}

export type ParseResult =
  | { ok: true; extraction: Extraction; issues: ExtractionIssue[] }
  | { ok: false; extraction: null; issues: ExtractionIssue[] };

const ISO_CURRENCY = /^[A-Z]{3}$/;

export function isIsoCurrency(text: string): boolean {
  return ISO_CURRENCY.test(text);
}

type FieldIssue = Pick<ExtractionIssue, "code" | "message">;

/** How one document prints its numbers and dates, where its own quotes show it beyond doubt. */
interface Convention {
  decimal: { sign: DecimalSign; example: string } | null;
  date: { order: "dmy" | "mdy"; example: string } | null;
  /** The document's language: a month name is read in it (or in English). */
  language: string | null;
}

/** The one value all entries agree on, with the first entry's example; null when there is none or they disagree. */
function agreed<T>(shown: { value: T; example: string }[]): { value: T; example: string } | null {
  const first = shown[0];
  return first && shown.every((entry) => entry.value === first.value) ? first : null;
}

function conventionOf(doc: TradeDocument): Convention {
  const signs: { value: DecimalSign; example: string }[] = [];
  const orders: { value: "dmy" | "mdy"; example: string }[] = [];
  walkCited(documentSchema, doc, ({ kind, field }) => {
    if (field.value === null || field.quote === null) return;
    if (kind === "decimal") {
      for (const number of printedNumbers(field.quote).numbers) {
        const sign = shownDecimalSign(number);
        if (sign) signs.push({ value: sign, example: number.text });
      }
    } else if (kind === "date") {
      for (const date of printedDates(field.quote)) {
        if (date.shows) orders.push({ value: date.shows, example: date.text });
      }
    }
  });
  const sign = agreed(signs);
  const order = agreed(orders);
  return {
    decimal: sign && { sign: sign.value, example: sign.example },
    date: order && { order: order.value, example: order.example },
    language: doc.language,
  };
}

const listed = (values: string[]) => [...new Set(values)].slice(0, 4).join(" or ");

function decimalIssue(value: string, quote: string, path: string, convention: Convention): FieldIssue | null {
  const target = abs(parseDecimal(value)!);
  const { numbers, fragments, unsure } = printedNumbers(quote);
  const reads = (number: PrintedNumber, sign?: DecimalSign) =>
    (sign ? readingsWith(number, sign) : number.readings).some((reading) => equals(parseDecimal(reading.value) as Decimal, target));
  const matching = [...numbers, ...fragments].filter((number) => reads(number));
  if (matching.length === 0) {
    // No digits in the quote ("two cartons") or a pattern with no known reading: nothing to compare with.
    if (numbers.length === 0 || unsure) return null;
    return {
      code: "EXT_QUOTE_MISMATCH",
      message: `"${value}" does not match the quote "${quote}", which reads ${listed(numbers.flatMap((n) => n.readings.map((r) => r.value)))}.`,
    };
  }
  const { decimal } = convention;
  if (decimal && !matching.some((number) => reads(number, decimal.sign))) {
    const expected = listed(matching.flatMap((n) => readingsWith(n, decimal.sign).map((r) => r.value)));
    return {
      code: "EXT_QUOTE_MISMATCH",
      message: `"${value}" does not match the quote "${quote}": this document writes decimals with "${decimal.sign}" (as in "${decimal.example}"), so the quote reads ${expected}.`,
    };
  }
  if (matching.every((number) => number.percent) && !path.endsWith(".discountPercent")) {
    return {
      code: "EXT_PERCENTAGE",
      message: `"${value}" is a percentage in the quote "${quote}", and this field takes an amount. Give the printed amount, or null when only a rate is printed.`,
    };
  }
  // The sign of a charge the total adds: "(500.00)" or "-500.00" given as 500.00 would be added where it is taken off.
  const [only] = numbers;
  const amount = parseDecimal(value)!;
  if (SIGNED_FIELD.test(path) && only && numbers.length === 1 && fragments.length === 0 && !unsure && compare(amount, ZERO) > 0 && printedNegative(quote, only.start, only.end)) {
    return {
      code: "EXT_QUOTE_MISMATCH",
      message: `"${value}" does not match the quote "${quote}": an amount printed in brackets or with a minus is negative, so the quote reads -${value}.`,
    };
  }
  return null;
}

/** The charges SUM-02 adds to the subtotal with their sign. A discount is left out: it is a reduction whichever way it is printed. */
const SIGNED_FIELD = /\.(?:freight|insurance|tax|otherCharges\[[0-9]+\])$/;

function currencyIssue(value: string, quote: string): FieldIssue | null {
  const named = otherCurrency(value, quote);
  return named === null ? null : { code: "EXT_QUOTE_MISMATCH", message: `"${value}" does not match the quote "${quote}", which names ${named}.` };
}

function dateIssue(value: string, quote: string, convention: Convention): FieldIssue | null {
  const dates = printedDates(quote);
  if (dates.length === 0) {
    // No all-numeric date: a date with a month name, when the quote is one beyond doubt, or nothing to compare with.
    const named = monthNameDate(quote, convention.language);
    return named === null || named === value ? null : { code: "EXT_QUOTE_MISMATCH", message: `"${value}" does not match the quote "${quote}", which reads ${named}.` };
  }
  const matching = dates.filter((date) => date.readings.some((reading) => reading.iso === value));
  if (matching.length === 0) {
    return {
      code: "EXT_QUOTE_MISMATCH",
      message: `"${value}" does not match the quote "${quote}", which reads ${listed(dates.flatMap((d) => d.readings.map((r) => r.iso)))}.`,
    };
  }
  const { date } = convention;
  if (date && !matching.some((printed) => dateReadingsWith(printed, date.order).some((reading) => reading.iso === value))) {
    const expected = listed(matching.flatMap((printed) => dateReadingsWith(printed, date.order).map((r) => r.iso)));
    const order = date.order === "dmy" ? "the day before the month" : "the month before the day";
    return {
      code: "EXT_QUOTE_MISMATCH",
      message: `"${value}" does not match the quote "${quote}": this document writes ${order} (as in "${date.example}"), so the quote reads ${expected}.`,
    };
  }
  return null;
}

export interface Inspection {
  issues: ExtractionIssue[];
  /** Cited fields (the objects themselves) whose value no rule may use. */
  unusable: Set<object>;
}

/** Checks every cited field of a well-shaped extraction. */
export function inspectExtraction(extraction: Extraction): Inspection {
  const issues: ExtractionIssue[] = [];
  const unusable = new Set<object>();

  const seen = new Set<string>();
  extraction.documents.forEach((doc, index) => {
    if (seen.has(doc.id)) {
      issues.push({ code: "EXT_DUPLICATE_ID", path: `documents[${index}].id`, message: `Duplicate document id "${doc.id}".` });
    }
    seen.add(doc.id);
  });

  extraction.documents.forEach((doc, index) => {
    const convention = conventionOf(doc);
    const visit = ({ kind, path, field }: CitedVisit) => {
      const { value, quote, page } = field;
      if (value === null) return;
      const cited = quote !== null && quote.trim() !== "" ? quote : null;
      if (cited === null) issues.push({ code: "EXT_UNCITED", path, message: "Value has no supporting quote." });
      if (page !== null && page < 1) {
        issues.push({ code: "EXT_PAGE", path, message: `Page must be 1 or more, got ${page}.` });
      }
      let problem: FieldIssue | null = null;
      if (kind === "decimal") {
        problem = !isCanonicalDecimal(value)
          ? { code: "EXT_DECIMAL_FORMAT", message: `"${value}" is not a canonical decimal like 13300.00.` }
          : cited === null
            ? null
            : decimalIssue(value, cited, path, convention);
      } else if (kind === "date") {
        problem = !isIsoDate(value)
          ? { code: "EXT_DATE_FORMAT", message: `"${value}" is not a valid YYYY-MM-DD date.` }
          : cited === null
            ? null
            : dateIssue(value, cited, convention);
      } else if (kind === "currency") {
        problem = !isIsoCurrency(value)
          ? { code: "EXT_CURRENCY_FORMAT", message: `"${value}" is not an ISO 4217 code like EUR.` }
          : cited === null
            ? null
            : currencyIssue(value, cited);
      }
      if (problem) {
        issues.push({ code: problem.code, path, message: problem.message });
        unusable.add(field);
      }
    };
    walkCited(documentSchema, doc, visit, `documents[${index}]`);
  });

  return { issues, unusable };
}

/** parseExtraction() plus the fields the rules must leave alone. */
export function parseAndInspect(
  input: unknown,
): { ok: true; extraction: Extraction; issues: ExtractionIssue[]; unusable: Set<object> } | { ok: false; extraction: null; issues: ExtractionIssue[] } {
  const shape = shapeIssues(input);
  if (shape.length > 0) return { ok: false, extraction: null, issues: shape.map((issue) => ({ code: "EXT_SHAPE", ...issue })) };
  // The shape check above is the one that words the problems; Zod then drops unknown keys and types the result.
  const parsed = extractionSchema.safeParse(input);
  if (!parsed.success) {
    const path = (keys: PropertyKey[]) => keys.reduce<string>((at, key) => (typeof key === "number" ? `${at}[${key}]` : at ? `${at}.${String(key)}` : String(key)), "");
    return {
      ok: false,
      extraction: null,
      issues: parsed.error.issues.map((issue) => ({ code: "EXT_SHAPE", path: path(issue.path) || TOP_LEVEL, message: issue.message })),
    };
  }
  return { ok: true, extraction: parsed.data, ...inspectExtraction(parsed.data) };
}

export function parseExtraction(input: unknown): ParseResult {
  const result = parseAndInspect(input);
  return result.ok ? { ok: true, extraction: result.extraction, issues: result.issues } : result;
}
