import { describe, expect, it } from "vitest";
import { decodeText, ioProblem, jsonErrorOffset, parseJson } from "../src/index.ts";

describe("decodeText", () => {
  const text = '{"schemaVersion":"2","documents":[],"note":"ქართული, Türkçe, ё"}';
  const utf8 = new TextEncoder().encode(text);
  const utf16 = (bigEndian: boolean) => {
    const bytes = new Uint8Array(2 + text.length * 2);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, 0xfeff, !bigEndian);
    for (let i = 0; i < text.length; i++) view.setUint16(2 + i * 2, text.charCodeAt(i), !bigEndian);
    return bytes;
  };

  it("reads UTF-8 with and without a byte order mark", () => {
    expect(decodeText(utf8)).toBe(text);
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8]))).toBe(text);
  });

  it("reads UTF-16 when a byte order mark says so", () => {
    expect(decodeText(utf16(false))).toBe(text);
    expect(decodeText(utf16(true))).toBe(text);
  });

  it("reads an empty file as empty text", () => {
    expect(decodeText(new Uint8Array())).toBe("");
  });
});

describe("parseJson", () => {
  it("returns the value of valid JSON", () => {
    expect(parseJson(' {"a": [1, 2.5e3, "x\\n\\u00e9", true, false, null, {}], "b": -0.1}\n')).toEqual({
      ok: true,
      value: { a: [1, 2500, "x\né", true, false, null, {}], b: -0.1 },
    });
    expect(jsonErrorOffset('{"a": [1, 2.5e3, "x\\n\\u00e9", true, false, null, {}, []], "b": -0.1}')).toBe(-1);
  });

  it.each<[string, string]>([
    ["", "the file is empty"],
    [" \n\t", "the file is empty"],
    ['{"a": 1,}', 'not valid JSON at line 1, column 9 (unexpected "}")'],
    ['{"a": 1\n "b": 2}', 'not valid JSON at line 2, column 2 (unexpected "\\"")'],
    ['{\n  "a": [1, 2,\n  "b": 3\n}', 'not valid JSON at line 3, column 6 (unexpected ":")'],
    ["{'a': 1}", "not valid JSON at line 1, column 2 (unexpected \"'\")"],
    ['{"a": 1', "not valid JSON: it ends too early at line 1, column 8"],
    ['{"a": "unfinished', "not valid JSON: it ends too early at line 1, column 18"],
    ['{"a": tru}', 'not valid JSON at line 1, column 10 (unexpected "}")'],
    ['{"a": NaN}', 'not valid JSON at line 1, column 7 (unexpected "N")'],
    ['{"a": 01}', 'not valid JSON at line 1, column 8 (unexpected "1")'],
    ['{"a": 1.}', 'not valid JSON at line 1, column 9 (unexpected "}")'],
    ['{"a": -}', 'not valid JSON at line 1, column 8 (unexpected "}")'],
    ['{"a": "bad \\x escape"}', 'not valid JSON at line 1, column 13 (unexpected "x")'],
    ['{"a": "\\u12G4"}', 'not valid JSON at line 1, column 12 (unexpected "G")'],
    ['{"a": "tab\there"}', 'not valid JSON at line 1, column 11 (unexpected "\\t")'],
    ['{"a": 1} {"b": 2}', 'not valid JSON at line 1, column 10 (unexpected "{")'],
    ['{"ქართული 😀": 1,\n "b" 2}', 'not valid JSON at line 2, column 6 (unexpected "2")'],
    ['{"a": "😀" 😀}', 'not valid JSON at line 1, column 11 (unexpected "😀")'],
    ["[1, 2", "not valid JSON: it ends too early at line 1, column 6"],
    ["[1 2]", 'not valid JSON at line 1, column 4 (unexpected "2")'],
    ["// a comment\n{}", 'not valid JSON at line 1, column 1 (unexpected "/")'],
    ["```json\n{}\n```", 'not valid JSON at line 1, column 1 (unexpected "`")'],
    ["undefined", 'not valid JSON at line 1, column 1 (unexpected "u")'],
  ])("%j: %s", (text, problem) => {
    expect(parseJson(text)).toEqual({ ok: false, problem });
  });
});

describe("ioProblem", () => {
  it("words the common causes and keeps the code", () => {
    const error = (code: string) => Object.assign(new Error(`${code}: something, open '/x'`), { code });
    expect(ioProblem(error("ENOENT"))).toBe("no such file or folder (ENOENT)");
    expect(ioProblem(error("ENOTDIR"))).toBe("a file stands where a folder is needed (ENOTDIR)");
    expect(ioProblem(error("EEXIST"))).toBe("a file with that name is in the way (EEXIST)");
    expect(ioProblem(error("EACCES"))).toBe("permission denied (EACCES)");
    expect(ioProblem(error("EISDIR"))).toBe("it is a folder, not a file (EISDIR)");
    expect(ioProblem(error("EMFILE"))).toBe("EMFILE");
    expect(ioProblem(error("constructor"))).toBe("constructor");
    expect(ioProblem(new Error("first line\n    at stack"))).toBe("first line");
    expect(ioProblem("text")).toBe("text");
  });
});
