/**
 * Reads an amount written in words ("thirteen thousand three hundred euro
 * and fifty cents", "ცამეტი ათას სამასი ევრო და ნული ცენტი", "YALNIZ
 * ONÜÇBİNÜÇYÜZ AVRO") into an exact decimal and currency.
 *
 * Strict by design: an unknown word or an impossible number sequence
 * ("five twenty", "thirty twenty") is an error, never a guess.
 */
import type { Decimal } from "../decimal.ts";
import type { Language } from "../schema.ts";
import { LEXICONS, type Lexicon, type NumberWord } from "./lexicons.ts";

export type WordsLanguage = Lexicon["language"];

export interface WordsAmount {
  language: WordsLanguage;
  /**
   * ISO 4217 code of the major currency word; the codes joined by "/" when
   * the word names several currencies ("manat": "AZN/TMT"); null if no
   * currency was written or the word alone does not say which ("franc").
   */
  currency: string | null;
  major: bigint;
  /** Minor units (cents, tetri…) or null if not written. */
  minor: bigint | null;
  /** major + minor/100, exact. Scale 2 when minor units were written, else 0. */
  amount: Decimal;
}

export type WordsErrorCode = "EMPTY" | "UNKNOWN_WORD" | "INVALID_SEQUENCE" | "AMBIGUOUS" | "MINOR_OUT_OF_RANGE";

export interface WordsError {
  code: WordsErrorCode;
  /** English explanation; reports translate the code instead. */
  message: string;
  /** The unknown word (UNKNOWN_WORD) or the invalid number phrase (INVALID_SEQUENCE). */
  word?: string;
}

export type WordsResult = { ok: true; value: WordsAmount } | { ok: false; error: WordsError };

type Item =
  | { kind: "number"; word: NumberWord; text: string }
  | { kind: "digits"; value: bigint; text: string }
  | { kind: "fraction"; value: bigint; text: string }
  | { kind: "major"; code: string | null; text: string; stem: string }
  | { kind: "minor"; code: string | null; text: string }
  /** A word that settles which currency the currency word next to it means ("Swiss" franc). */
  | { kind: "qualifier"; codes: Record<string, string> }
  /** standalone: a word of its own ("and", "და"), not glued inside a number ("ორმოცდაათი"). */
  | { kind: "connector"; standalone: boolean }
  | { kind: "ignore" };

class WordsParseError extends Error {
  readonly code: WordsErrorCode;
  readonly word: string | undefined;

  constructor(code: WordsErrorCode, message: string, word?: string) {
    super(message);
    this.code = code;
    this.word = word;
  }
}

/* ------------------------------------------------------------------ */
/* Tokenizing                                                          */
/* ------------------------------------------------------------------ */

function normalize(text: string, lexicon: Lexicon): string[] {
  return text
    .normalize("NFC")
    .toLocaleLowerCase(lexicon.locale)
    .replaceAll("ё", "е")
    .replace(/[^\p{L}\p{M}\p{N}/&]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function startsWithStem<T>(word: string, stems: Record<string, T>): [string, T] | null {
  let best: [string, T] | null = null;
  for (const [stem, value] of Object.entries(stems)) {
    if (word.startsWith(stem) && (!best || stem.length > best[0].length)) best = [stem, value];
  }
  return best;
}

/** Exact whole-word match: digits, "50/100", "no/100", numbers, connectors, filler. */
function classifyExact(word: string, lexicon: Lexicon): Item | null {
  if (/^\d+$/.test(word)) return { kind: "digits", value: BigInt(word), text: word };
  const fraction = /^(\d{1,2})\/100$/.exec(word);
  if (fraction) return { kind: "fraction", value: BigInt(fraction[1]!), text: word };
  if (/^(?:no|xx|zero)\/100$/.test(word)) return { kind: "fraction", value: 0n, text: word };
  // Own keys only: "constructor" must not find Object.prototype.constructor.
  const number = Object.hasOwn(lexicon.numbers, word) ? lexicon.numbers[word] : undefined;
  if (number) return { kind: "number", word: number, text: word };
  if (lexicon.connectors.includes(word)) return { kind: "connector", standalone: true };
  if (lexicon.ignorable.includes(word)) return { kind: "ignore" };
  return null;
}

/**
 * Currency word by stem: "euros", "рублей", "lirası", "ლარის". The longest
 * stem wins, so "евроцентов" is cents, not euro.
 */
function classifyCurrency(word: string, lexicon: Lexicon): Item | null {
  const major = startsWithStem(word, lexicon.major);
  const minor = startsWithStem(word, lexicon.minor);
  if (minor && (!major || minor[0].length > major[0].length)) return { kind: "minor", code: minor[1], text: word };
  if (major) return { kind: "major", code: major[1], text: word, stem: major[0] };
  const qualifier = startsWithStem(word, lexicon.qualifiers);
  return qualifier ? { kind: "qualifier", codes: qualifier[1] } : null;
}

type Morpheme = { text: string; item: Item | "suffix" };

function morphemes(lexicon: Lexicon): Morpheme[] {
  const list: Morpheme[] = [
    ...Object.entries(lexicon.numbers).map(([text, word]) => ({ text, item: { kind: "number", word, text } as Item })),
    ...lexicon.connectors.map((text) => ({ text, item: { kind: "connector", standalone: false } as Item })),
    ...lexicon.ignorable.map((text) => ({ text, item: { kind: "ignore" } as Item })),
    ...Object.entries(lexicon.major).map(([text, code]) => ({ text, item: { kind: "major", code, text, stem: text } as Item })),
    ...Object.entries(lexicon.qualifiers).map(([text, codes]) => ({ text, item: { kind: "qualifier", codes } as Item })),
    ...Object.entries(lexicon.minor).map(([text, code]) => ({ text, item: { kind: "minor", code, text } as Item })),
    ...lexicon.suffixes.map((text) => ({ text, item: "suffix" as const })),
  ];
  return list.sort((a, b) => b.text.length - a.text.length);
}

const MORPHEME_CACHE = new Map<WordsLanguage, Morpheme[]>();

/** What came before a position in a glued word. */
const After = { Start: 0, Part: 1, Currency: 2, Suffix: 3 } as const;
type After = (typeof After)[keyof typeof After];

/**
 * Splits a glued word into morphemes, longest match first, backtracking when
 * needed. A suffix follows a word part at the end of the word, or a currency
 * part inside it ("türklirasıellikuruş": lira + sı, then elli kuruş).
 */
function segment(word: string, lexicon: Lexicon): Item[] | null {
  let list = MORPHEME_CACHE.get(lexicon.language);
  if (!list) {
    list = morphemes(lexicon);
    MORPHEME_CACHE.set(lexicon.language, list);
  }
  const all = list;
  // The result depends only on the position and on what came before it, so
  // memoizing keeps long nonsense words linear.
  const memo = new Map<string, Item[] | null>();

  function walk(position: number, after: After): Item[] | null {
    const key = `${position}:${after}`;
    if (memo.has(key)) return memo.get(key)!;
    const result = step(position, after);
    memo.set(key, result);
    return result;
  }

  function step(position: number, after: After): Item[] | null {
    if (position === word.length) return [];
    for (const morpheme of all) {
      if (!word.startsWith(morpheme.text, position)) continue;
      const end = position + morpheme.text.length;
      if (morpheme.item === "suffix") {
        if (after === After.Start || after === After.Suffix) continue;
        if (end === word.length) return [];
        if (after !== After.Currency) continue;
        const rest = walk(end, After.Suffix);
        if (rest) return rest;
        continue;
      }
      const kind = morpheme.item.kind;
      const rest = walk(end, kind === "major" || kind === "minor" ? After.Currency : After.Part);
      if (rest) return [morpheme.item, ...rest];
    }
    return null;
  }
  return walk(0, After.Start);
}

function readWord(word: string, lexicon: Lexicon): Item[] | null {
  const exact = classifyExact(word, lexicon);
  if (exact) return [exact];
  // Glued languages: split first, so "avroelli" is not read as just "avro".
  const parts = lexicon.glued ? segment(word, lexicon) : null;
  if (parts) return parts;
  const currency = classifyCurrency(word, lexicon);
  return currency ? [currency] : null;
}

function tokenize(text: string, lexicon: Lexicon): Item[] {
  const items: Item[] = [];
  const words = normalize(text, lexicon);
  for (const [index, word] of words.entries()) {
    if (lexicon.articles.includes(word)) {
      // "a hundred", "a thousand": one. Anywhere else an article carries no amount.
      const next = words[index + 1];
      const number = next !== undefined && Object.hasOwn(lexicon.numbers, next) ? lexicon.numbers[next] : undefined;
      items.push(number && number.role !== "unit" ? { kind: "number", word: { value: 1n, role: "unit" }, text: word } : { kind: "ignore" });
      continue;
    }
    let read = readWord(word, lexicon);
    // ASCII capitals in Turkish text: "BIN" lowercases to "bın" in the tr locale.
    if (!read && lexicon.language === "tr" && word.includes("ı")) {
      read = readWord(word.replaceAll("ı", "i"), lexicon);
    }
    if (!read) throw new WordsParseError("UNKNOWN_WORD", `Unknown word "${word}".`, word);
    items.push(...read);
  }
  return items;
}

/* ------------------------------------------------------------------ */
/* Evaluating                                                          */
/* ------------------------------------------------------------------ */

/** An amount (number words, digits or "50/100") or a currency word, in reading order. */
type Element =
  | { kind: "amount"; value: bigint; fraction: boolean }
  | { kind: "major"; code: string | null }
  | { kind: "minor"; code: string | null };

type NumberRun = { word: NumberWord; text: string }[];

/**
 * What a unit word leaves room for in its group of three digits: after
 * "twenty" only 1–9 can follow, after "thirteen" nothing. Georgian counts in
 * twenties (ოცდაათი is 20 + 10, ოცდაცხრამეტი 20 + 19) and Turkish builds
 * its teens from ten (on bir is 10 + 1).
 */
function roomAfter(value: bigint, lexicon: Lexicon): bigint {
  if (value >= 100n) return 100n;
  if (value >= 20n && value % 10n === 0n) return lexicon.vigesimal && value % 20n === 0n ? 20n : 10n;
  if (value === 10n) return lexicon.compoundTeens ? 10n : 1n;
  return 1n;
}

/** Evaluates one run of number words, rejecting impossible orders. */
function evaluate(words: NumberRun, lexicon: Lexicon): bigint {
  let total = 0n;
  let group = 0n;
  let room: bigint | null = null; // what the group can still take; null before its first word
  let lastScale: bigint | null = null;
  let sawHundred = false;
  const phrase = words.map((w) => w.text).join(" ");
  const invalid = () => new WordsParseError("INVALID_SEQUENCE", `Not a valid number: "${phrase}".`, phrase);

  for (const { word } of words) {
    if (word.role === "unit") {
      // Within a group every word fills lower digits than the one before: "twenty five", never "thirty twenty".
      if (room !== null && word.value >= room) throw invalid();
      if (word.value === 0n && (group !== 0n || total !== 0n || words.length > 1)) throw invalid();
      group += word.value;
      room = roomAfter(word.value, lexicon);
    } else if (word.role === "hundred") {
      if (sawHundred || group >= 100n) throw invalid();
      group = (group === 0n ? 1n : group) * 100n;
      sawHundred = true;
      room = 100n;
    } else {
      if (lastScale !== null && word.value >= lastScale) throw invalid();
      total += (group === 0n ? 1n : group) * word.value;
      group = 0n;
      room = null;
      lastScale = word.value;
      sawHundred = false;
    }
  }
  return total + group;
}

/**
 * "Swiss francs", "азербайджанских манатов": a qualifier next to a currency
 * word it knows settles the currency. Everywhere else it carries nothing.
 */
function applyQualifiers(items: Item[]): Item[] {
  const out = [...items];
  items.forEach((item, index) => {
    if (item.kind !== "qualifier") return;
    for (const at of [index + 1, index - 1]) {
      const near = out[at];
      const code = near?.kind === "major" && Object.hasOwn(item.codes, near.stem) ? item.codes[near.stem] : undefined;
      if (near?.kind === "major" && code) {
        out[at] = { ...near, code };
        break;
      }
    }
  });
  return out.map((item): Item => (item.kind === "qualifier" ? { kind: "ignore" } : item));
}

/**
 * "euro cents", "евро центов", "ევრო ცენტი": "euro" right before a cent word
 * names the minor unit, it is not the currency of another amount.
 */
function mergeCentCompounds(items: Item[]): Item[] {
  const out: Item[] = [];
  for (const item of items) {
    const previous = out[out.length - 1];
    if (item.kind === "minor" && previous?.kind === "major" && previous.code === "EUR" && (item.code === null || item.code === "EUR")) {
      out[out.length - 1] = { kind: "minor", code: "EUR", text: `${previous.text} ${item.text}` };
    } else {
      out.push(item);
    }
  }
  return out;
}

const meaningful = (item: Item) => item.kind !== "connector" && item.kind !== "ignore";

/** Groups items into amounts and currency words. */
function elements(items: Item[], lexicon: Lexicon): Element[] {
  const out: Element[] = [];
  let index = 0;
  while (index < items.length) {
    const item = items[index]!;
    if (item.kind === "number") {
      // A run of number words. Connectors and filler words do not break it
      // ("one hundred and five"), but a standalone connector is remembered.
      const run: NumberRun = [];
      const splits: number[] = [];
      let connector = false;
      let end = index;
      for (; end < items.length; end++) {
        const next = items[end]!;
        if (next.kind === "number") {
          if (connector) splits.push(run.length);
          connector = false;
          run.push({ word: next.word, text: next.text });
        } else if (next.kind === "connector") {
          if (next.standalone) connector = true;
        } else if (next.kind !== "ignore") {
          break;
        }
      }
      // "US dollars fifteen thousand five hundred and fifty cents": between a
      // currency word and a minor-unit word, the last "and" separates the two.
      const after = items.slice(end).find(meaningful);
      const split = splits.length > 0 && out[out.length - 1]?.kind === "major" && after?.kind === "minor" ? splits[splits.length - 1]! : 0;
      for (const part of split > 0 ? [run.slice(0, split), run.slice(split)] : [run]) {
        out.push({ kind: "amount", value: evaluate(part, lexicon), fraction: false });
      }
      index = end;
      continue;
    }
    if (item.kind === "digits" || item.kind === "fraction") {
      out.push({ kind: "amount", value: item.value, fraction: item.kind === "fraction" });
    } else if (item.kind === "major" || item.kind === "minor") {
      // "Euro (EUR)": the same currency twice in a row is one mention.
      const previous = out[out.length - 1];
      if (!(previous && previous.kind === item.kind && previous.code === item.code)) {
        out.push(item.kind === "major" ? { kind: "major", code: item.code } : { kind: "minor", code: item.code });
      }
    }
    index++;
  }
  return out;
}

function interpret(items: Item[], lexicon: Lexicon): WordsAmount {
  const els = elements(mergeCentCompounds(applyQualifiers(items)), lexicon);
  if (!els.some((e) => e.kind === "amount")) throw new WordsParseError("EMPTY", "No amount found.");

  // "US dollars thirteen thousand… cents fifty" (currency first) vs
  // "thirteen thousand… dollars fifty cents" (currency after the number).
  // Each amount takes the currency word next to it, on the preferred side
  // first; each currency word belongs to one amount.
  const prefixStyle = els[0]!.kind !== "amount";
  const owner = new Map<number, number>(); // currency word index -> amount index
  const currencyOf = new Map<number, number>(); // amount index -> currency word index

  // The element next to `from`; a "50/100" between an amount and its currency does not separate them.
  const neighbour = (from: number, step: number, skipFractions: boolean): number => {
    let at = from + step;
    while (skipFractions) {
      const el = els[at];
      if (!el || el.kind !== "amount" || !el.fraction) break;
      at += step;
    }
    return at;
  };

  els.forEach((el, index) => {
    if (el.kind !== "amount") return;
    for (const step of prefixStyle ? [-1, 1] : [1, -1]) {
      const at = neighbour(index, step, !el.fraction);
      const word = els[at];
      if (!word || word.kind === "amount" || owner.has(at)) continue;
      if (el.fraction && word.kind !== "minor") continue;
      owner.set(at, index);
      currencyOf.set(index, at);
      // "EUR thirteen thousand three hundred euros": the same currency on the other side is the same mention.
      const across = neighbour(index, -step, true);
      const twin = els[across];
      if (word.kind === "major" && twin?.kind === "major" && twin.code === word.code && !owner.has(across)) owner.set(across, index);
      break;
    }
  });
  if (els.some((el, index) => el.kind !== "amount" && !owner.has(index))) {
    throw new WordsParseError("AMBIGUOUS", "A currency word is not attached to any number.");
  }

  let major: bigint | null = null;
  let minor: bigint | null = null;
  let currency: string | null = null;
  for (const [index, el] of els.entries()) {
    if (el.kind !== "amount") continue;
    const at = currencyOf.get(index);
    const word = at === undefined ? undefined : els[at];
    const role = el.fraction || word?.kind === "minor" ? "minor" : word?.kind === "major" || major === null ? "major" : "minor";
    if (role === "major") {
      if (major !== null) throw new WordsParseError("AMBIGUOUS", "More than one main amount.");
      major = el.value;
      if (word?.kind === "major") currency = word.code;
    } else {
      if (minor !== null) throw new WordsParseError("AMBIGUOUS", "More than one minor-unit amount.");
      minor = el.value;
      // "fifty tetri", "ორმოცდაათი ევროცენტი": the minor unit names the currency when no currency word does.
      if (word?.kind === "minor" && word.code !== null && currency === null && !els.some((e) => e.kind === "major")) currency = word.code;
    }
  }
  if (major === null) {
    major = 0n;
  }
  if (minor !== null && minor >= 100n) {
    throw new WordsParseError("MINOR_OUT_OF_RANGE", `Minor units must be below 100, got ${minor}.`);
  }
  const amount: Decimal = minor === null ? { units: major, scale: 0 } : { units: major * 100n + minor, scale: 2 };
  return { language: lexicon.language, currency, major, minor, amount };
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/** Best guess of the language of an amount-in-words phrase, from its script and words. */
export function detectWordsLanguage(text: string): WordsLanguage {
  if (/[Ⴀ-ჿᲐ-Ჿ]/u.test(text)) return "ka";
  if (/[Ѐ-ӿ]/u.test(text)) return "ru";
  if (/[çğıöşüİ]/iu.test(text) || /(?<![\p{L}\p{N}])(yalniz|bin|yuz|kurus|lira|avro|milyon)/iu.test(text)) return "tr";
  return "en";
}

export function parseAmountInWordsAs(text: string, language: WordsLanguage): WordsResult {
  const lexicon = LEXICONS[language];
  try {
    return { ok: true, value: interpret(tokenize(text, lexicon), lexicon) };
  } catch (error) {
    if (error instanceof WordsParseError) {
      return { ok: false, error: { code: error.code, message: error.message, ...(error.word ? { word: error.word } : {}) } };
    }
    throw error;
  }
}

/**
 * Parses an amount in words. With a language given, that language is tried
 * first, then the detected one (a Georgian invoice may write the amount in
 * English); when both fail, the error is the detected language's, so the
 * unknown word it names is a word of the phrase's own language. With no
 * language (or "other"), the detected language is tried first, then the
 * others.
 */
export function parseAmountInWords(text: string, language?: Language | null): WordsResult {
  if (language && language !== "other") {
    const stated = parseAmountInWordsAs(text, language);
    const detected = detectWordsLanguage(text);
    if (stated.ok || detected === language) return stated;
    const fallback = parseAmountInWordsAs(text, detected);
    if (fallback.ok) return fallback;
    // Both failed: the words are in another script or carry another language's marks, so that language's error
    // names a word of the phrase's own language. English is only the default for unmarked Latin text and does
    // not overrule a document stated to be Turkish.
    return language === "tr" && detected === "en" ? stated : fallback;
  }
  const first = detectWordsLanguage(text);
  const firstResult = parseAmountInWordsAs(text, first);
  if (firstResult.ok) return firstResult;
  for (const other of Object.keys(LEXICONS) as WordsLanguage[]) {
    if (other === first) continue;
    const result = parseAmountInWordsAs(text, other);
    if (result.ok) return result;
  }
  return firstResult;
}
