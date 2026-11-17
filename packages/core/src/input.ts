/**
 * Reading the extraction file, and saying what went wrong in words that are
 * the same in check.mjs, check.py and the CLI:
 *
 * - decodeText: UTF-8, with or without a byte order mark, and UTF-16 with one
 *   (what Windows PowerShell writes with ">");
 * - parseJson: the parsed value, or where the text stops being JSON;
 * - ioProblem: why a file could not be read or written, from the error code.
 */

/** The text of a file: UTF-8 unless a byte order mark says UTF-16. The mark itself is dropped. */
export function decodeText(bytes: Uint8Array): string {
  const [a, b] = bytes;
  const encoding = a === 0xff && b === 0xfe ? "utf-16le" : a === 0xfe && b === 0xff ? "utf-16be" : "utf-8";
  return new TextDecoder(encoding).decode(bytes);
}

const isDigit = (ch: string | undefined) => ch !== undefined && ch >= "0" && ch <= "9";
const isHex = (ch: string | undefined) => ch !== undefined && /^[0-9a-fA-F]$/.test(ch);

/**
 * Index of the first character that breaks the JSON grammar (RFC 8259), -1
 * when the text is valid JSON, `text.length` when it ends too early. JSON.parse
 * and Python's json word and place their errors differently; this gives both
 * ports one answer.
 */
export function jsonErrorOffset(text: string): number {
  const n = text.length;
  let i = 0;

  const string = (): boolean => {
    i++;
    while (i < n) {
      const ch = text[i]!;
      if (ch === '"') {
        i++;
        return true;
      }
      if (ch < " ") return false;
      if (ch === "\\") {
        const next = text[i + 1];
        if (next === undefined) {
          i = n;
          return false;
        }
        if (next === "u") {
          for (let k = 2; k < 6; k++) {
            if (!isHex(text[i + k])) {
              i = Math.min(i + k, n);
              return false;
            }
          }
          i += 6;
          continue;
        }
        if (!'"\\/bfnrt'.includes(next)) {
          i += 1;
          return false;
        }
        i += 2;
        continue;
      }
      i++;
    }
    return false;
  };
  const digits = (): boolean => {
    if (!isDigit(text[i])) return false;
    while (isDigit(text[i])) i++;
    return true;
  };
  const number = (): boolean => {
    if (text[i] === "-") i++;
    if (text[i] === "0") i++;
    else if (!digits()) return false;
    if (text[i] === ".") {
      i++;
      if (!digits()) return false;
    }
    if (text[i] === "e" || text[i] === "E") {
      i++;
      if (text[i] === "+" || text[i] === "-") i++;
      if (!digits()) return false;
    }
    return true;
  };
  const word = (literal: string): boolean => {
    for (const ch of literal) {
      if (text[i] !== ch) return false;
      i++;
    }
    return true;
  };

  /** What may come next: a value, a key, a colon, a comma or the end of the open array or object, or nothing more. */
  type Expect = "value" | "value-or-end" | "key" | "key-or-end" | "colon" | "comma-or-end" | "nothing";
  const open: ("[" | "{")[] = [];
  const afterValue = (): Expect => (open.length > 0 ? "comma-or-end" : "nothing");
  let expect: Expect = "value";
  for (;;) {
    while (i < n && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i++;
    if (expect === "nothing") return i < n ? i : -1;
    if (i >= n) return n;
    const ch = text[i]!;
    const top = open[open.length - 1];
    if (expect === "value" || expect === "value-or-end") {
      if (expect === "value-or-end" && ch === "]") {
        i++;
        open.pop();
        expect = afterValue();
      } else if (ch === "{") {
        i++;
        open.push("{");
        expect = "key-or-end";
      } else if (ch === "[") {
        i++;
        open.push("[");
        expect = "value-or-end";
      } else {
        const ok = ch === '"' ? string() : ch === "-" || isDigit(ch) ? number() : ch === "t" ? word("true") : ch === "f" ? word("false") : ch === "n" ? word("null") : false;
        if (!ok) return i;
        expect = afterValue();
      }
    } else if (expect === "key" || expect === "key-or-end") {
      if (expect === "key-or-end" && ch === "}") {
        i++;
        open.pop();
        expect = afterValue();
      } else {
        if (ch !== '"' || !string()) return i;
        expect = "colon";
      }
    } else if (expect === "colon") {
      if (ch !== ":") return i;
      i++;
      expect = "value";
    } else if (ch === ",") {
      i++;
      expect = top === "[" ? "value" : "key";
    } else if ((top === "[" && ch === "]") || (top === "{" && ch === "}")) {
      i++;
      open.pop();
      expect = afterValue();
    } else {
      return i;
    }
  }
}

export type JsonRead = { ok: true; value: unknown } | { ok: false; problem: string };

/**
 * JSON.parse that says where the text breaks: 'not valid JSON at line 3,
 * column 14 (unexpected "}")', 'not valid JSON: it ends too early at line 9,
 * column 1', 'the file is empty'.
 */
export function parseJson(text: string): JsonRead {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    if (text.trim() === "") return { ok: false, problem: "the file is empty" };
    const offset = jsonErrorOffset(text);
    if (offset < 0) return { ok: false, problem: "not valid JSON" };
    const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
    const line = text.slice(0, lineStart).split("\n").length;
    // Columns count characters, not UTF-16 units, so both ports agree after an emoji.
    const column = [...text.slice(lineStart, offset)].length + 1;
    const where = `line ${line}, column ${column}`;
    if (offset >= text.length) return { ok: false, problem: `not valid JSON: it ends too early at ${where}` };
    return { ok: false, problem: `not valid JSON at ${where} (unexpected ${JSON.stringify(String.fromCodePoint(text.codePointAt(offset)!))})` };
  }
}

const IO_REASONS: Record<string, string> = {
  ENOENT: "no such file or folder",
  EISDIR: "it is a folder, not a file",
  ENOTDIR: "a file stands where a folder is needed",
  EEXIST: "a file with that name is in the way",
  EACCES: "permission denied",
  EPERM: "permission denied",
  EROFS: "the file system is read-only",
  ENOSPC: "no space left on the device",
};

/** Why a file could not be read or written: "no such file or folder (ENOENT)". */
export function ioProblem(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string") return Object.hasOwn(IO_REASONS, code) ? `${IO_REASONS[code]} (${code})` : code;
  return (error instanceof Error ? error.message : String(error)).split("\n")[0]!;
}
