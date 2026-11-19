import { isIsoDate } from "../dates.ts";
import { abs, dec, parseDecimal, sum, toFixed, within, type Decimal } from "../decimal.ts";
import type { CitedDate, CitedDecimal, CitedText, Extraction, TradeDocument } from "../schema.ts";
import { isIsoCurrency } from "../validate.ts";
import type { Evidence } from "./types.ts";

type Cited = CitedText | CitedDecimal | CitedDate;

/**
 * What the rules know about the extraction they are running on: the fields
 * the extraction check found unusable, and each document's position (ids may
 * repeat, positions cannot). Set by checkExtraction for the length of a run.
 */
let unusableFields: ReadonlySet<object> = new Set();
let documentIndexes: ReadonlyMap<object, number> = new Map();

export function beginRun(extraction: Extraction, unusable: ReadonlySet<object>): void {
  unusableFields = unusable;
  documentIndexes = new Map(extraction.documents.map((doc, index) => [doc, index]));
}

export function endRun(): void {
  unusableFields = new Set();
  documentIndexes = new Map();
}

/** Evidence for a cited field. `computed`: the value is a sum the checker worked out, not printed. */
export function evidence(doc: TradeDocument, path: string, field: Cited, computed = false): Evidence {
  return {
    documentId: doc.id,
    documentIndex: documentIndexes.get(doc) ?? -1,
    documentType: doc.type,
    path,
    value: field.value,
    quote: field.quote,
    page: field.page,
    ...(computed ? { computed: true as const } : {}),
  };
}

/** Decimal value of a cited field, or null if absent, malformed or unusable. */
export function num(field: CitedDecimal): Decimal | null {
  return field.value === null || unusableFields.has(field) ? null : parseDecimal(field.value);
}

export function text(field: CitedText): string | null {
  const value = field.value?.trim();
  return value ? value : null;
}

/** Declaration comparisons require supporting evidence on both sides. */
export function quoted(field: CitedText): boolean {
  return !unusableFields.has(field) && (field.page === null || field.page >= 1) && Boolean(field.quote?.trim());
}

export function citedWrittenText(field: CitedText): string | null {
  const value = text(field);
  return quoted(field) && value === field.quote?.trim() ? value : null;
}

export function isoDate(field: CitedDate): string | null {
  return field.value !== null && !unusableFields.has(field) && isIsoDate(field.value) ? field.value : null;
}

/** ISO 4217 code of a currency field, or null if absent, not a code ("€") or unusable (another currency than its quote names). */
export function currencyCode(field: CitedText): string | null {
  return field.value !== null && !unusableFields.has(field) && isIsoCurrency(field.value) ? field.value : null;
}

/** Sum of a field over all items, or null if any item lacks it. */
export function sumAll<T>(items: readonly T[], pick: (item: T) => CitedDecimal): Decimal | null {
  if (items.length === 0) return null;
  const values = items.map((item) => num(pick(item)));
  return values.every((v): v is Decimal => v !== null) ? sum(values) : null;
}

/** Half a unit of the last printed digit: "8700.00" -> 0.005, "1880" -> 0.5. */
export function roundingTolerance(printed: Decimal): Decimal {
  return { units: 5n, scale: printed.scale + 1 };
}

export function sameWithin(a: Decimal, b: Decimal, tolerance: string | Decimal): boolean {
  return within(a, b, typeof tolerance === "string" ? dec(tolerance) : tolerance);
}

/** Prints a computed decimal with the precision of the printed value it is compared to. */
export function show(value: Decimal, like?: Decimal | null): string {
  return toFixed(value, like ? like.scale : value.scale);
}

export function showAbs(value: Decimal): string {
  return toFixed(abs(value), value.scale);
}

/**
 * Document numbers: "No. AOS-INV 2026/01" and "aos-inv-2026/01" compare equal.
 * "No"/"Nr" is a prefix only before ".", ":", "#", a space or a digit, so
 * "NOR-2026-118" keeps its letters.
 */
export function normalizeRef(value: string): string {
  return value
    .normalize("NFKC")
    .toUpperCase()
    .replace(/^(?:(?:NO|NR)(?:[.:#]|(?=[\s\d]))|№|#|N°)\s*/u, "")
    .replace(/[\s\-_./\\:]+/gu, "");
}

export const REF_SEPARATORS = "[\\s\\-_./\\\\:]*";

/**
 * Does `text` mention document number `ref` as a whole number? Separators may
 * differ ("AT 2026/118" matches "AT-2026-118"), but "AT-2026/118" is not found
 * inside "AT-2026/118-УЛ" (another document's number).
 */
export function containsRef(text: string, ref: string): boolean {
  const chars = [...normalizeRef(ref)];
  if (chars.length === 0) return false;
  const body = chars.map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(REF_SEPARATORS);
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}][\\-_./\\\\:]?)${body}(?![\\-_./\\\\:]?[\\p{L}\\p{N}])`, "u");
  return pattern.test(text.normalize("NFKC").toUpperCase());
}

export const LEGAL_FORMS = new Set([
  "ltd", "limited", "llc", "llp", "inc", "corp", "corporation", "co", "plc", "gmbh", "ag", "sa", "sas",
  "srl", "spa", "bv", "nv", "jsc", "ojsc", "cjsc", "as", "aş", "şti", "sti", "tic", "san", "ve", "oü",
  "ооо", "оао", "зао", "пао", "ао", "ип", "тоо",
  "შპს", "სს", "იმ", "ი/მ",
]);

/**
 * Written-out legal forms and the abbreviation they equal. Names are compared
 * without them, so "Anonim Şirketi" and "A.Ş." match.
 */
export const LEGAL_FORM_PHRASES: [string, string][] = [
  ["limited liability company", "llc"],
  ["limited liability partnership", "llp"],
  ["public limited company", "plc"],
  ["open joint stock company", "ojsc"],
  ["closed joint stock company", "cjsc"],
  ["joint stock company", "jsc"],
  ["incorporated", "inc"],
  ["gesellschaft mit beschränkter haftung", "gmbh"],
  ["aktiengesellschaft", "ag"],
  ["osaühing", "oü"],
  ["anonim şirketi", "aş"],
  ["limited şirketi", "ltd şti"],
  ["sanayi ve ticaret", "san ve tic"],
  ["ticaret ve sanayi", "tic ve san"],
  ["общество с ограниченной ответственностью", "ооо"],
  ["открытое акционерное общество", "оао"],
  ["закрытое акционерное общество", "зао"],
  ["публичное акционерное общество", "пао"],
  ["акционерное общество", "ао"],
  ["индивидуальный предприниматель", "ип"],
  ["товарищество с ограниченной ответственностью", "тоо"],
  ["შეზღუდული პასუხისმგებლობის საზოგადოება", "შპს"],
  ["სააქციო საზოგადოება", "სს"],
  ["ინდივიდუალური მეწარმე", "იმ"],
];

/**
 * Case- and accent-insensitive form for comparing names: Turkish İ/I/ı/i all
 * become i, then lower case without combining marks ("TEKSTİL" = "Tekstil").
 */
export function foldName(value: string): string {
  return value
    .replace(/[İIı]/gu, "i")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "");
}

/** Words of a folded name; runs of single letters join ("A.Ş." -> "aş" -> "as", "L.L.C." -> "llc"). */
function words(value: string): string[] {
  const tokens = foldName(value)
    .replace(/["'«»„“”()]/gu, " ")
    .replace(/[^\p{L}\p{N}/]+/gu, " ")
    .split(" ")
    .filter(Boolean);
  const out: string[] = [];
  let letters: string[] = [];
  const flush = () => {
    if (letters.length > 1) out.push(letters.join(""));
    else out.push(...letters);
    letters = [];
  };
  for (const token of tokens) {
    if ([...token].length === 1 && /\p{L}/u.test(token)) {
      letters.push(token);
      continue;
    }
    flush();
    out.push(token);
  }
  flush();
  return out;
}

const LEGAL_FORM_WORDS = new Set([...LEGAL_FORMS].flatMap(words));
const LEGAL_PHRASE_WORDS = LEGAL_FORM_PHRASES.map(([phrase, short]) => [words(phrase), words(short)] as const);

export type Script = "latin" | "georgian" | "cyrillic" | "other";

export function scriptOf(value: string): Script {
  if (/[Ⴀ-ჿᲐ-Ჿ]/u.test(value)) return "georgian";
  if (/[Ѐ-ӿ]/u.test(value)) return "cyrillic";
  if (/[a-z]/iu.test(value)) return "latin";
  return "other";
}

/** Folded name words without legal forms (written out or abbreviated) and punctuation. */
export function nameTokens(value: string): string[] {
  const tokens = words(value);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; ) {
    const phrase = LEGAL_PHRASE_WORDS.find(([long]) => long.every((word, k) => tokens[i + k] === word));
    if (phrase) {
      out.push(...phrase[1]);
      i += phrase[0].length;
    } else {
      out.push(tokens[i]!);
      i++;
    }
  }
  return out.filter((token) => !LEGAL_FORM_WORDS.has(token));
}

/**
 * Same party? Compares normalized names, ignoring legal forms and
 * punctuation; one name may contain the other as whole words ("Kartli
 * Retail" and "Kartli Retail Group", but not "Tex" and "Cortex"). Returns
 * null when the names are in different scripts and cannot be compared
 * reliably.
 */
export function sameParty(a: string, b: string): boolean | null {
  if (scriptOf(a) !== scriptOf(b)) return null;
  const x = nameTokens(a);
  const y = nameTokens(b);
  if (x.length === 0 || y.length === 0) return null;
  const joinedX = ` ${x.join(" ")} `;
  const joinedY = ` ${y.join(" ")} `;
  if (joinedX.includes(joinedY) || joinedY.includes(joinedX)) return true;
  const setY = new Set(y);
  const shared = x.filter((token) => setY.has(token)).length;
  return shared / new Set([...x, ...y]).size >= 0.6;
}

export function labelOf(doc: TradeDocument): string {
  return doc.number.value ? `${doc.id} (${doc.number.value})` : doc.id;
}
