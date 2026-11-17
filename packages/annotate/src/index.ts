/**
 * Reads the original PDFs for two things:
 *
 * - marking findings: a box around each quoted piece of evidence, a numbered
 *   badge matching the report, and a PDF annotation whose popup carries the
 *   finding message;
 * - checking quotes: every quote of the extraction is looked up on its page,
 *   so a quote that is not printed there is known before anyone trusts it.
 *
 * Quotes are located in the page's text layer (pdf.js via unpdf). What is
 * not located comes with its reason: the page does not exist, the page has
 * no text (a scan), or the text is there and the quote is not. A file that
 * cannot be read (encrypted, corrupt) is reported and skipped, and a runtime
 * PDF.js cannot run on skips both altogether: neither ever fails a check.
 */
import { documentSchema, ioProblem, walkCited, type Citation, type Extraction, type ReportView, type Severity } from "@logisticshub/core";
import { PDFArray, PDFDocument, PDFHexString, PDFName, PDFString, rgb, StandardFonts, type PDFPage } from "pdf-lib";
import { getDocumentProxy, getResolvedPDFJS } from "unpdf";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Mark {
  /** 1-based page number. */
  page: number;
  quote: string;
  /** Badge text, e.g. "1" (the finding's number in the report). */
  label: string;
  /** Popup text of the annotation. */
  message: string;
  severity: Severity;
  /** The field the quote belongs to. With it, a quote printed several times on the page is boxed once, at the field's own copy. */
  field?: { documentIndex: number; path: string };
}

/** Why a quote was not located: its page does not exist, the page has no text layer, or the text is there and the quote is not. */
export type Unlocated = "no-page" | "no-text" | "not-found";

export interface MarkResult {
  mark: Mark;
  rects: Rect[];
  /** Set when `rects` is empty and the file itself could be read. */
  reason?: Unlocated;
  /**
   * Set when the quote is printed several times and the field's own copy
   * could not be told apart: the number of copies, all of them boxed.
   */
  copies?: number;
}

interface TextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL: boolean;
}

type CharRef = { item: number; offset: number } | null;

const squash = (text: string) => text.normalize("NFC").replace(/\s+/g, " ").trim();
const isWord = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
const isDigit = (ch: string | undefined) => ch !== undefined && /\p{Nd}/u.test(ch);
const NUMBER_JOINERS = /[.,'’\u00A0\u202F]/u;
/** How far apart, in characters of page text, a copy and its neighbour field may stand and still be "next to" each other (" · ", ", "). */
const NEIGHBOUR_GAP = 4;
/** Characters that tie two words into one code or range: "BL/LED-PNL-60/1-40", "1–100". */
const TOKEN_JOINERS = /[-‐‑–/\\_]/u;

/** Page text with a map from each character back to its text item. */
function pageText(items: TextItem[]): { text: string; refs: CharRef[] } {
  let text = "";
  const refs: CharRef[] = [];
  let lastWasSpace = true;
  items.forEach((item, index) => {
    [...item.str.normalize("NFC")].forEach((ch, offset) => {
      if (/\s/.test(ch)) {
        if (!lastWasSpace) {
          text += " ";
          refs.push(null);
          lastWasSpace = true;
        }
        return;
      }
      text += ch;
      // One ref per UTF-16 unit, so string indexes line up with refs.
      for (let unit = 0; unit < ch.length; unit++) refs.push({ item: index, offset });
      lastWasSpace = false;
    });
    if (item.hasEOL && !lastWasSpace) {
      text += " ";
      refs.push(null);
      lastWasSpace = true;
    }
  });
  return { text, refs };
}

/** Start indexes of whole-token occurrences of `needle` in `haystack`. */
function occurrences(haystack: string, needle: string): number[] {
  const found: number[] = [];
  if (!needle) return found;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    const before = haystack[at - 1];
    const after = haystack[at + needle.length];
    const startsWord = isWord(needle[0]);
    const endsWord = isWord(needle[needle.length - 1]);
    if ((startsWord && isWord(before)) || (endsWord && isWord(after))) continue;
    // Digit groups joined by separators are one number: "600" is not inside "1,600".
    const joined = (sep: string | undefined, digit: string | undefined) => sep !== undefined && NUMBER_JOINERS.test(sep) && isDigit(digit);
    if (isDigit(needle[0]) && joined(before, haystack[at - 2])) continue;
    if (isDigit(needle[needle.length - 1]) && joined(after, haystack[at + needle.length + 1])) continue;
    found.push(at);
  }
  return found;
}

/** Boxes covering characters [start, end) of the page text, one per text line. */
function boxes(items: TextItem[], refs: CharRef[], start: number, end: number): Rect[] {
  const lines = new Map<string, { x0: number; x1: number; y: number; size: number }>();
  for (let i = start; i < end; i++) {
    const ref = refs[i];
    if (!ref) continue;
    const item = items[ref.item]!;
    const [, , , d = 0, e = 0, f = 0] = item.transform;
    const size = Math.abs(d) || item.height || 8;
    const length = [...item.str].length || 1;
    const x0 = e + (item.width * ref.offset) / length;
    const x1 = e + (item.width * (ref.offset + 1)) / length;
    const key = f.toFixed(1);
    const line = lines.get(key);
    if (line) {
      line.x0 = Math.min(line.x0, x0);
      line.x1 = Math.max(line.x1, x1);
    } else {
      lines.set(key, { x0, x1, y: f, size });
    }
  }
  const pad = 1.5;
  return [...lines.values()].map((l) => ({
    x: l.x0 - pad,
    y: l.y - l.size * 0.28 - pad,
    width: l.x1 - l.x0 + pad * 2,
    height: l.size * 1.22 + pad * 2,
  }));
}

/**
 * Lowercases character by character, keeping every character's length, so
 * positions in the result are positions in the input. "İ" lowercases to "i̇"
 * (two units); it becomes "i".
 */
function lowerSameLength(text: string): string {
  let out = "";
  for (const ch of text) {
    const lower = ch.toLowerCase();
    const first = lower.length === ch.length ? lower : String.fromCodePoint(lower.codePointAt(0)!);
    out += first.length === ch.length ? first : ch;
  }
  return out;
}

/** Where `quote` stands in the page text as a whole token: as written, or else in any letter case. */
function find(text: string, quote: string): { starts: number[]; length: number } {
  const needle = squash(quote);
  let starts = occurrences(text, needle);
  if (starts.length === 0) starts = occurrences(lowerSameLength(text), lowerSameLength(needle));
  return { starts, length: needle.length };
}

/** Locates every whole-token occurrence of `quote` on a page. */
export function locateInItems(items: TextItem[], quote: string): Rect[][] {
  const { text, refs } = pageText(items);
  const { starts, length } = find(text, quote);
  return starts.map((start) => boxes(items, refs, start, start + length));
}

/** A field's quote on one page: what locateField() needs to know about the other fields of the file. */
export type FieldQuote = Pick<Citation, "documentIndex" | "path" | "quote">;

/**
 * Locates the one copy of `quote` that belongs to `field`, on a page that may
 * print the quote several times ("USD 15,500.00" as subtotal and as total,
 * "USD" in the currency box and inside both amounts).
 *
 * `fields` are the quotes the extraction cites from this page, in schema
 * order. Copies that stand inside a longer quote of another field belong to
 * that field ("USD" inside "USD 15,500.00"), and a copy that is part of a
 * longer code or range ("100" in the marks "1-100") gives way to copies that
 * stand alone. Of the copies left, the one that stands right next to the
 * field's neighbour in the schema is the field's own: a CMR prints its date
 * in the header, in box 4 after the place of taking over and in box 21 after
 * the place of issue, and the copy after the place of taking over is the date
 * of taking over. Copies and fields that no neighbour settles pair up in
 * order when they are as many: the first copy in the page text is the first
 * such field's. Otherwise the copy cannot be told apart: every candidate
 * comes back and `copies` counts them.
 */
export function locateField(items: TextItem[], quote: string, field: { documentIndex: number; path: string }, fields: readonly FieldQuote[]): { found: Rect[][]; copies?: number } {
  return fieldLocator(items, fields)(quote, field);
}

/**
 * locateField() for many marks on one page: the page text and the fields'
 * quotes are indexed once, and every answer about a quote is kept, so a page
 * with thousands of quoted fields costs no more per mark than a small one.
 */
function fieldLocator(items: TextItem[], fields: readonly FieldQuote[]): (quote: string, field: { documentIndex: number; path: string }) => { found: Rect[][]; copies?: number } {
  const { text, refs } = pageText(items);
  const fold = (quote: string) => lowerSameLength(squash(quote));
  /** The fields that cite each quote, in schema order, and each field's place in that order. */
  const sharing = new Map<string, Map<string, number>>();
  for (const other of fields) {
    const key = fold(other.quote);
    const order = sharing.get(key) ?? new Map<string, number>();
    sharing.set(key, order);
    const id = `${other.documentIndex}:${other.path}`;
    if (!order.has(id)) order.set(id, order.size);
  }
  const spans = new Map<string, { starts: number[]; length: number }>();
  const spanOf = (quote: string) => {
    let span = spans.get(quote);
    if (!span) spans.set(quote, (span = find(text, quote)));
    return span;
  };
  /** Per quote: every copy, and the copies left once longer quotes and codes have taken theirs. */
  const candidates = new Map<string, { starts: number[]; free: number[]; length: number }>();
  const candidatesOf = (quote: string) => {
    const known = candidates.get(quote);
    if (known) return known;
    const { starts, length } = spanOf(quote);
    let free = starts;
    if (starts.length > 1) {
      const needle = fold(quote);
      // Copies inside a longer quote of another field are that field's.
      const taken: [number, number][] = [];
      for (const other of sharing.keys()) {
        if (other.length <= needle.length || !other.includes(needle)) continue;
        const span = spanOf(other);
        for (const from of span.starts) taken.push([from, from + span.length]);
      }
      const outside = starts.filter((start) => !taken.some(([from, to]) => from <= start && start + length <= to));
      const tied = (joiner: string | undefined, beyond: string | undefined) => joiner !== undefined && TOKEN_JOINERS.test(joiner) && isWord(beyond);
      const alone = outside.filter((start) => !tied(text[start - 1], text[start - 2]) && !tied(text[start + length], text[start + length + 1]));
      free = alone.length > 0 ? alone : outside;
    }
    const result = { starts, free, length };
    candidates.set(quote, result);
    return result;
  };

  /** Where each field stands among the fields of the page (schema order within a document). */
  const position = new Map<string, number>();
  fields.forEach((other, index) => {
    const id = `${other.documentIndex}:${other.path}`;
    if (!position.has(id)) position.set(id, index);
  });
  /** The quotes of the field before and the field after in the same document, where they cite another text. */
  const neighbours = (id: string, own: string): string[] => {
    const at = position.get(id);
    if (at === undefined) return [];
    return [fields[at - 1], fields[at + 1]].flatMap((other) => (other && other.documentIndex === fields[at]!.documentIndex && fold(other.quote) !== own ? [other.quote] : []));
  };
  /** Does the copy at `start` stand right next to a copy of `quote`, with nothing but spaces and punctuation between them? */
  const touches = (start: number, length: number, quote: string): boolean => {
    const span = spanOf(quote);
    return span.starts.some((from) => {
      const [gapFrom, gapTo] = from + span.length <= start ? [from + span.length, start] : start + length <= from ? [start + length, from] : [0, -1];
      if (gapTo < gapFrom || gapTo - gapFrom > NEIGHBOUR_GAP) return false;
      for (let i = gapFrom; i < gapTo; i++) if (isWord(text[i])) return false;
      return true;
    });
  };
  /** Per quote: the fields a neighbour ties to one copy. A copy two fields would claim is nobody's. */
  const ties = new Map<string, Map<string, number>>();
  const tiesOf = (quote: string, order: Map<string, number>) => {
    const known = ties.get(quote);
    if (known) return known;
    const { free, length } = candidatesOf(quote);
    const claims = new Map<string, number>();
    for (const id of order.keys()) {
      const near = neighbours(id, fold(quote));
      const touching = free.filter((start) => near.some((other) => touches(start, length, other)));
      if (touching.length === 1) claims.set(id, touching[0]!);
    }
    const claimed = [...claims.values()];
    const tied = new Map([...claims].filter(([, start]) => claimed.filter((other) => other === start).length === 1));
    ties.set(quote, tied);
    return tied;
  };

  return (quote, field) => {
    const { starts, free, length } = candidatesOf(quote);
    const box = (picked: number[]) => picked.map((start) => boxes(items, refs, start, start + length));
    if (starts.length <= 1) return { found: box(starts) };
    const order = sharing.get(fold(quote));
    const id = `${field.documentIndex}:${field.path}`;
    const own = order?.get(id);
    if (order && own !== undefined) {
      const tied = tiesOf(quote, order);
      const mine = tied.get(id);
      if (mine !== undefined) return { found: box([mine]) };
      // What no neighbour settled pairs up in order: the first copy left is the first field's left.
      const taken = new Set(tied.values());
      const left = free.filter((start) => !taken.has(start));
      const open = [...order.keys()].filter((other) => !tied.has(other));
      if (left.length === open.length) return { found: box([left[open.indexOf(id)]!]) };
      // Every copy stands inside a longer quote: the fields cite those places themselves.
      if (free.length === 0 && starts.length === order.size) return { found: box([starts[own]!]) };
    }
    const left = free.length > 0 ? free : starts;
    return left.length === 1 ? { found: box(left) } : { found: box(left), copies: left.length };
  };
}

const hasText = (items: TextItem[]) => items.some((item) => item.str.trim() !== "");

/** Case-, width- and ligature-insensitive form for looking a quote up: "ﬁ" is "fi", "İ" is "i". */
const loose = (text: string) => squash(lowerSameLength(text.normalize("NFKC")));

/**
 * Is the quote printed on this page? Yes when it stands there in one piece,
 * and also when each of its words does: a cell that wraps, or two columns the
 * PDF stores apart, break a quote up without making it wrong. A quote with a
 * word or number the page does not print at all is not found.
 */
export function quoteOnPage(items: TextItem[], quote: string): boolean {
  if (locateInItems(items, quote).length > 0) return true;
  const text = loose(pageText(items).text);
  const words = loose(quote).split(" ").filter(Boolean);
  return words.length > 0 && words.every((word) => occurrences(text, word).length > 0);
}

const COLORS: Record<Severity, ReturnType<typeof rgb>> = {
  error: rgb(0.882, 0.145, 0.106),
  warning: rgb(0.718, 0.475, 0.122),
};

/**
 * Where a finding's number goes: left of its box, vertically centred, so it
 * never covers the line above. `drawn` are the badges already on the page: a
 * second finding on the same text gets its number beside the first, not on
 * it. When the numbers would run off the page, the badge goes next to the box
 * after all.
 */
export function placeBadge(box: Rect, width: number, height: number, drawn: readonly Rect[]): Rect {
  const y = box.y + (box.height - height) / 2;
  const first = box.x - width - 1;
  let x = first;
  // One sweep from the box leftwards: a badge can only be pushed further left.
  const row = drawn.filter((badge) => Math.abs(badge.y - y) < height).sort((a, b) => b.x - a.x);
  for (const badge of row) if (x < badge.x + badge.width && badge.x < x + width) x = badge.x - width - 1;
  return { x: x < 0 ? first : x, y, width, height };
}

type Badges = Rect[];

function drawMark(page: PDFPage, rects: Rect[], mark: Mark, font: Awaited<ReturnType<PDFDocument["embedFont"]>>, badges: Badges): void {
  const color = COLORS[mark.severity];
  for (const r of rects) {
    page.drawRectangle({ ...r, color, opacity: 0.1, borderColor: color, borderWidth: 1.1, borderOpacity: 0.95 });
  }
  const first = rects[0]!;
  const size = 6.5;
  const badge = placeBadge(first, font.widthOfTextAtSize(mark.label, size) + 5, size + 4, badges);
  badges.push(badge);
  const { x: bx, y: by, width: badgeWidth, height: badgeHeight } = badge;
  page.drawRectangle({ x: bx, y: by, width: badgeWidth, height: badgeHeight, color });
  page.drawText(mark.label, { x: bx + 2.5, y: by + 2.4, size, font, color: rgb(1, 1, 1) });

  // A Square annotation so PDF viewers show the message on hover/click.
  const doc = page.doc;
  const annotation = doc.context.obj({
    Type: "Annot",
    Subtype: "Square",
    Rect: [first.x, first.y, first.x + first.width, first.y + first.height],
    C: [color.red, color.green, color.blue],
    Border: [0, 0, 0],
    T: PDFString.of("Logisticshub"),
    Contents: PDFHexString.fromText(`${mark.label}. ${mark.message}`),
    F: 4,
  });
  const ref = doc.context.register(annotation);
  const annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
  if (annots) annots.push(ref);
  else page.node.set(PDFName.of("Annots"), doc.context.obj([ref]));
}

/** The text items of a page, read once. */
function pageReader(reader: Awaited<ReturnType<typeof getDocumentProxy>>) {
  const pages = new Map<number, TextItem[]>();
  return async (page: number): Promise<TextItem[]> => {
    let items = pages.get(page);
    if (!items) {
      const content = await (await reader.getPage(page)).getTextContent();
      items = (content.items as unknown[]).filter((i): i is TextItem => typeof i === "object" && i !== null && "str" in i);
      pages.set(page, items);
    }
    return items;
  };
}

/**
 * pdf-lib reports every object it cannot parse with console.warn. What matters
 * about a damaged file is said in the notes, so it stays quiet while it works.
 */
async function quietly<T>(work: () => Promise<T>): Promise<T> {
  const { warn } = console;
  console.warn = () => {};
  try {
    return await work();
  } finally {
    console.warn = warn;
  }
}

/**
 * Draws the marks on a copy of the PDF. Marks whose quote is not found are
 * returned with no rects and the reason; `bytes` is null when no mark was
 * found. `citations` are the quotes the extraction cites from this file: with
 * them a quote printed several times is boxed at its field's own copy (see
 * locateField). Throws on an encrypted or unreadable PDF.
 */
export async function annotatePdf(
  pdf: Uint8Array,
  marks: Mark[],
  citations: readonly Citation[] = [],
): Promise<{ bytes: Uint8Array | null; results: MarkResult[]; pages: number }> {
  // pdf-lib first: it is cheap and tells encrypted PDFs apart. It cannot write
  // into them (the copy comes out corrupt), so those are not marked.
  const doc = await quietly(() => PDFDocument.load(pdf, { ignoreEncryption: true }));
  if (doc.isEncrypted) throw new Error("the PDF is encrypted");
  // verbosity 0: PDF.js prints warnings with console.log, into the report on stdout.
  const reader = await getDocumentProxy(new Uint8Array(pdf), { verbosity: 0 });
  try {
    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    const itemsOf = pageReader(reader);
    const pages = Math.min(reader.numPages, doc.getPageCount());
    const results: MarkResult[] = [];
    const badges = new Map<number, Badges>();
    const locators = new Map<number, ReturnType<typeof fieldLocator>>();
    for (const mark of marks) {
      if (mark.page < 1 || mark.page > pages) {
        results.push({ mark, rects: [], reason: "no-page" });
        continue;
      }
      const items = await itemsOf(mark.page);
      let locate = locators.get(mark.page);
      if (!locate) {
        // A citation without a page number may stand on this page too.
        locate = fieldLocator(items, citations.filter((cited) => cited.page === mark.page || cited.page === null));
        locators.set(mark.page, locate);
      }
      const { found, copies } = mark.field ? locate(mark.quote, mark.field) : { found: locateInItems(items, mark.quote) };
      const page = doc.getPage(mark.page - 1);
      const drawn = badges.get(mark.page) ?? [];
      badges.set(mark.page, drawn);
      for (const rects of found) if (rects.length > 0) drawMark(page, rects, mark, font, drawn);
      const rects = found.flat();
      results.push(
        rects.length > 0
          ? { mark, rects, ...(copies === undefined ? {} : { copies }) }
          : { mark, rects, reason: hasText(items) ? "not-found" : "no-text" },
      );
    }
    const located = results.some((r) => r.rects.length > 0);
    return { bytes: located ? await quietly(() => doc.save()) : null, results, pages };
  } finally {
    await (reader as unknown as { destroy?: () => Promise<void> }).destroy?.();
  }
}

/** Groups a report's evidence into marks per source file. */
export function marksBySourceFile(view: ReportView): Map<string, Mark[]> {
  const bySource = new Map<string, Mark[]>();
  for (const finding of [...view.errors, ...view.warnings]) {
    for (const e of finding.evidence) {
      if (!e.sourceFile || e.quote === null || e.page === null) continue;
      const marks = bySource.get(e.sourceFile) ?? [];
      // One mark per finding and field on a file: two fields that share a quote are two places on the page.
      const field = { documentIndex: e.documentIndex, path: e.path };
      const same = (m: Mark) => m.label === String(finding.index) && m.quote === e.quote && m.page === e.page && m.field?.documentIndex === field.documentIndex && m.field.path === field.path;
      if (!marks.some(same)) {
        marks.push({ page: e.page, quote: e.quote, label: String(finding.index), message: finding.message, severity: finding.severity, field });
      }
      bySource.set(e.sourceFile, marks);
    }
  }
  return bySource;
}

export interface AnnotatedFile {
  sourceFile: string;
  /** The marked copy; null when no mark was located or the file could not be marked. */
  bytes: Uint8Array | null;
  results: MarkResult[];
  /** Number of pages, when the file could be read. */
  pages?: number;
  /** Why the file could not be marked, in plain words (not found, encrypted, damaged), or null. */
  error: string | null;
}

export interface Marking {
  files: AnnotatedFile[];
  /** Why no PDF was marked at all (the runtime cannot run PDF.js), or null. */
  skipped: string | null;
  /** Source files with findings that are not PDFs (an image, another format): they cannot be marked. */
  others?: string[];
}

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 200);

/**
 * Why a PDF could not be read, in plain words. The parsers' own ("Failed to
 * parse PDF document (line:89 col:1692 offset=399)…") tell a reader nothing
 * to act on. Three cases: the file system refused the file, the PDF asks for
 * a password, or it could not be parsed.
 */
export function pdfProblem(error: unknown): string {
  if (typeof (error as { code?: unknown } | null)?.code === "string") return `the file cannot be read: ${ioProblem(error)}`;
  const said = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  if (/password|encrypt/i.test(said)) return "the PDF is encrypted";
  return "the PDF cannot be read: it is damaged or not a PDF";
}

/** Why PDF.js cannot run here, or null. It needs the global Iterator (V8 12.2, Node.js 22). */
function pdfUnavailable(what: string): string | null {
  if (typeof (globalThis as { Iterator?: unknown }).Iterator === "undefined") {
    const version = (globalThis as { process?: { version?: string } }).process?.version;
    return `${what} needs Node.js 22 or newer${version ? ` (this is ${version})` : ""}`;
  }
  return null;
}

export function markingUnavailable(): string | null {
  return pdfUnavailable("marking");
}

/** Why no PDF can be read here (too old a runtime, PDF.js failing to load), or null. */
async function pdfReaderProblem(what: string): Promise<string | null> {
  const unavailable = pdfUnavailable(what);
  if (unavailable) return unavailable;
  try {
    await getResolvedPDFJS();
    return null;
  } catch (error) {
    return reason(error);
  }
}

const isPdf = (sourceFile: string) => sourceFile.toLowerCase().endsWith(".pdf");

/**
 * Marks every PDF source file that has findings; `read` returns its bytes or
 * null if it is not available. Never throws: problems come back per file, or
 * as `skipped` when marking cannot run here.
 */
export async function annotateDocuments(view: ReportView, read: (sourceFile: string) => Uint8Array | null): Promise<Marking> {
  const all = [...marksBySourceFile(view)];
  const marking: Marking = { files: [], skipped: null, others: all.map(([sourceFile]) => sourceFile).filter((sourceFile) => !isPdf(sourceFile)) };
  const bySource = all.filter(([sourceFile]) => isPdf(sourceFile));
  if (bySource.length === 0) return marking;
  marking.skipped = await pdfReaderProblem("marking");
  if (marking.skipped) return marking;

  for (const [sourceFile, marks] of bySource) {
    const unmarked = (error: string): AnnotatedFile => ({ sourceFile, bytes: null, results: marks.map((mark) => ({ mark, rects: [] })), error });
    try {
      const pdf = read(sourceFile);
      if (!pdf) {
        marking.files.push(unmarked("file not found"));
        continue;
      }
      const { bytes, results, pages } = await annotatePdf(pdf, marks, view.citations.filter((cited) => cited.sourceFile === sourceFile));
      marking.files.push({ sourceFile, bytes, results, pages, error: null });
    } catch (error) {
      marking.files.push(unmarked(pdfProblem(error)));
    }
  }
  return marking;
}

const pagesText = (pages: number) => `${pages} ${pages === 1 ? "page" : "pages"}`;

/** "page 7 does not exist (1 page)", "page 1 has no text, likely a scan", "quote not found on page 1". */
function unlocatedText(why: Unlocated, page: number | null, pages: number | undefined): string {
  if (why === "no-page") return `page ${page} does not exist${pages === undefined ? "" : ` (${pagesText(pages)})`}`;
  if (why === "no-text") return page === null ? "the file has no text, likely a scan" : `page ${page} has no text, likely a scan`;
  return page === null ? "quote not found on any page" : `quote not found on page ${page}`;
}

/**
 * One line per marking problem, worded the same in the CLI, the MCP server
 * and check.mjs. A mark that was not located comes with the true reason.
 */
export function markingNotes(marking: Marking): string[] {
  if (marking.skipped) return [`marked PDFs skipped: ${marking.skipped}`];
  const notes: string[] = [];
  for (const file of marking.files) {
    if (file.error) {
      notes.push(`${file.sourceFile}: not marked: ${file.error}`);
      continue;
    }
    const missing = file.results.filter((r) => r.rects.length === 0);
    if (missing.length > 0) {
      const reasons = [...new Set(missing.map((r) => unlocatedText(r.reason ?? "not-found", r.mark.page, file.pages)))];
      const copy = file.bytes === null ? "; no marked copy" : "";
      notes.push(`${file.sourceFile}: ${missing.length} of ${file.results.length} marks not located: ${reasons.join(", ")}${copy}`);
    }
    // A quote printed several times whose own copy could not be told apart: said once per page and quote.
    const unsure = new Map<string, { page: number; quote: string; copies: number; findings: string[] }>();
    for (const { mark, copies } of file.results) {
      if (copies === undefined) continue;
      const key = `${mark.page}:${mark.quote}`;
      const entry = unsure.get(key) ?? { page: mark.page, quote: mark.quote, copies, findings: [] };
      if (!entry.findings.includes(mark.label)) entry.findings.push(mark.label);
      unsure.set(key, entry);
    }
    for (const { page, quote, copies, findings } of unsure.values()) {
      const which = `${findings.length === 1 ? "finding" : "findings"} ${findings.join(", ")}`;
      notes.push(`${file.sourceFile}: page ${page}: ${JSON.stringify(quote)} is printed ${copies} times and ${which} could not be tied to one of them; all ${copies} are boxed`);
    }
  }
  return notes;
}

/** A quote of the extraction that its PDF does not print where the extraction says. */
export interface QuoteProblem {
  /** Field path in the extraction, e.g. "documents[0].lines[1].lineTotal". */
  path: string;
  quote: string;
  page: number | null;
  reason: Unlocated;
}

export interface QuoteCheckFile {
  sourceFile: string;
  /** Number of pages, when the file could be read. */
  pages?: number;
  /** Quotes looked up in this file. */
  quotes: number;
  problems: QuoteProblem[];
  /** Why the file could not be read (not found, corrupt, password-protected), or null. */
  error: string | null;
}

export interface QuoteCheck {
  files: QuoteCheckFile[];
  /** Why no PDF was read at all (the runtime cannot run PDF.js), or null. */
  skipped: string | null;
  /** Source files that are not PDFs (an image, another format), with the number of quotes nobody looked up. */
  others?: { sourceFile: string; quotes: number }[];
}

interface CitedQuote {
  path: string;
  quote: string;
  page: number | null;
}

async function checkPdfQuotes(pdf: Uint8Array, quotes: CitedQuote[]): Promise<{ pages: number; problems: QuoteProblem[] }> {
  // verbosity 0: PDF.js prints warnings with console.log, into the report on stdout.
  const reader = await getDocumentProxy(new Uint8Array(pdf), { verbosity: 0 });
  try {
    const itemsOf = pageReader(reader);
    const pages = reader.numPages;
    const problems: QuoteProblem[] = [];
    for (const cited of quotes) {
      // A quote without a page number is looked for on every page.
      const candidates = cited.page === null ? Array.from({ length: pages }, (_, i) => i + 1) : [cited.page];
      let why: Unlocated | null = "no-text";
      for (const page of candidates) {
        if (page < 1 || page > pages) {
          why = "no-page";
          break;
        }
        const items = await itemsOf(page);
        if (quoteOnPage(items, cited.quote)) {
          why = null;
          break;
        }
        if (hasText(items)) why = "not-found";
      }
      if (why) problems.push({ ...cited, reason: why });
    }
    return { pages, problems };
  } finally {
    await (reader as unknown as { destroy?: () => Promise<void> }).destroy?.();
  }
}

/**
 * Looks every quote of the extraction up in its PDF, on the page the
 * extraction names; `read` returns a file's bytes or null if it is not
 * available. Only PDF source files are read. Never throws: problems come back
 * per file, or as `skipped` when no PDF can be read here.
 */
export async function checkQuotes(extraction: Extraction, read: (sourceFile: string) => Uint8Array | null): Promise<QuoteCheck> {
  const others: { sourceFile: string; quotes: number }[] = [];
  const check: QuoteCheck = { files: [], skipped: null, others };
  const bySource = new Map<string, CitedQuote[]>();
  /** Quotes of the files that are not PDFs: counted, never read. */
  const uncounted = new Map<string, CitedQuote[]>();
  extraction.documents.forEach((doc, index) => {
    if (!doc.sourceFile) return;
    const group = isPdf(doc.sourceFile) ? bySource : uncounted;
    const quotes = group.get(doc.sourceFile) ?? [];
    group.set(doc.sourceFile, quotes);
    walkCited(
      documentSchema,
      doc,
      ({ path, field }) => {
        if (field.value !== null && field.quote !== null && field.quote.trim() !== "") quotes.push({ path, quote: field.quote, page: field.page });
      },
      `documents[${index}]`,
    );
  });
  for (const [sourceFile, quotes] of uncounted) others.push({ sourceFile, quotes: quotes.length });
  if (bySource.size === 0) return check;
  check.skipped = await pdfReaderProblem("reading PDFs");
  if (check.skipped) return check;

  for (const [sourceFile, quotes] of bySource) {
    const unread = (error: string): QuoteCheckFile => ({ sourceFile, quotes: quotes.length, problems: [], error });
    try {
      const pdf = read(sourceFile);
      if (!pdf) {
        check.files.push(unread("file not found"));
        continue;
      }
      const { pages, problems } = await checkPdfQuotes(pdf, quotes);
      check.files.push({ sourceFile, pages, quotes: quotes.length, problems, error: null });
    } catch (error) {
      check.files.push(unread(pdfProblem(error)));
    }
  }
  return check;
}

const SHOWN = 5;

/** "a, b, c" for up to five items, then "… and 3 more". */
function shortList(items: string[], separator: string): string {
  const more = items.length - SHOWN;
  return more > 0 ? `${items.slice(0, SHOWN).join(separator)}${separator}and ${more} more` : items.join(separator);
}

/**
 * One line per file and reason for the quotes that are not printed where the
 * extraction says:
 *
 *   invoice.pdf: page 7 does not exist (1 page): documents[0].total, documents[0].subtotal
 *   invoice.pdf: page 1 has no text, likely a scan: 46 quotes not checked
 *   invoice.pdf: page 1: 2 quotes not found in the page text: documents[0].total "USD 15,550.00"; …
 *   invoice.pdf: quotes not checked: file not found
 *
 * `reported` names the files a marking note already covers ("not marked: …").
 */
export function quoteNotes(check: QuoteCheck, reported: ReadonlySet<string> = new Set()): string[] {
  if (check.skipped) return [`quotes not checked in the PDFs: ${check.skipped}`];
  const notes: string[] = [];
  for (const file of check.files) {
    if (file.error) {
      if (!reported.has(file.sourceFile)) notes.push(`${file.sourceFile}: quotes not checked: ${file.error}`);
      continue;
    }
    // Grouped by reason and page, in the order the problems were met.
    const groups = new Map<string, QuoteProblem[]>();
    for (const problem of file.problems) {
      const key = `${problem.reason}:${problem.page}`;
      groups.set(key, [...(groups.get(key) ?? []), problem]);
    }
    for (const problems of groups.values()) {
      const { reason: why, page } = problems[0]!;
      const count = `${problems.length} ${problems.length === 1 ? "quote" : "quotes"}`;
      if (why === "no-page") {
        notes.push(`${file.sourceFile}: ${unlocatedText(why, page, file.pages)}: ${shortList(problems.map((p) => p.path), ", ")}`);
      } else if (why === "no-text") {
        notes.push(`${file.sourceFile}: ${unlocatedText(why, page, file.pages)}: ${count} not checked`);
      } else {
        const where = page === null ? "any page" : `page ${page}`;
        notes.push(`${file.sourceFile}: ${where}: ${count} not found in the page text: ${shortList(problems.map((p) => `${p.path} ${JSON.stringify(p.quote)}`), "; ")}`);
      }
    }
  }
  return notes;
}

const IMAGE = /\.(?:jpe?g|png|tiff?|webp|gif|bmp|heic|heif)$/i;

/**
 * One line per source file that is not a PDF: nothing in it can be marked,
 * and its quotes are not looked up, so both are said rather than passed over:
 *
 *   cmr.jpg: an image: not marked, 46 quotes not checked
 *   cmr.jpg: an image: 46 quotes not checked          (no finding cites the file)
 *   invoice.docx: not a PDF: not marked, 12 quotes not checked
 */
export function otherFileNotes(marking: Marking, quotes: QuoteCheck): string[] {
  const unmarked = new Set(marking.others ?? []);
  const counted = new Map((quotes.others ?? []).map((file) => [file.sourceFile, file.quotes]));
  const notes: string[] = [];
  for (const sourceFile of new Set([...counted.keys(), ...unmarked])) {
    const count = counted.get(sourceFile) ?? 0;
    const parts = [...(unmarked.has(sourceFile) ? ["not marked"] : []), ...(count > 0 ? [`${count} ${count === 1 ? "quote" : "quotes"} not checked`] : [])];
    if (parts.length > 0) notes.push(`${sourceFile}: ${IMAGE.test(sourceFile) ? "an image" : "not a PDF"}: ${parts.join(", ")}`);
  }
  return notes;
}

/**
 * The notes of a run: marking first, then the quotes, then the files that are
 * not PDFs. A file that could not be read is named once.
 */
export function checkNotes(marking: Marking, quotes: QuoteCheck): string[] {
  const unread = new Set(marking.files.filter((file) => file.error).map((file) => file.sourceFile));
  return [...markingNotes(marking), ...quoteNotes(quotes, unread), ...otherFileNotes(marking, quotes)];
}
