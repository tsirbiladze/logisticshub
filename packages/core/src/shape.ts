/**
 * The shape check: is the input an extraction at all? Wrong types, missing
 * keys, an unknown document type, a schema version this checker does not
 * read. Each problem is one line that says what to write instead, and the
 * Python port (check.py, shape_issues) words every one of them the same way.
 *
 * Paths read like the field issues' paths: documents[0].lines[1].quantity.
 */
import { z } from "zod";
import { citedKind } from "./introspect.ts";
import { extractionSchema, SCHEMA_VERSION } from "./schema.ts";

export interface ShapeIssue {
  path: string;
  message: string;
}

/** Path shown for a problem with the file as a whole. */
export const TOP_LEVEL = "(top level)";

const CITED = '{ "value": …, "quote": …, "page": … }';
const BLANK = '{ "value": null, "quote": null, "page": null }';
const MAX_PAGE = Number.MAX_SAFE_INTEGER;

const isRecord = (data: unknown): data is Record<string, unknown> => typeof data === "object" && data !== null && !Array.isArray(data);

/** "a string", "an array", "null": what was found where something else belongs. */
function got(data: unknown): string {
  if (data === null) return "null";
  if (Array.isArray(data)) return "an array";
  if (typeof data === "string") return "a string";
  if (typeof data === "number") return "a number";
  if (typeof data === "boolean") return "a boolean";
  if (typeof data === "object") return "an object";
  return "nothing";
}

/** "en, ru, tr, ka or other" */
function orList(values: readonly string[]): string {
  return values.length < 2 ? values.join("") : `${values.slice(0, -1).join(", ")} or ${values[values.length - 1]}`;
}

const lastKey = (path: string) => path.slice(path.lastIndexOf(".") + 1);

function check(schema: z.ZodType, data: unknown, path: string, issues: ShapeIssue[], nullable = false): void {
  const add = (message: string) => void issues.push({ path, message });
  const orNull = nullable ? " or null" : "";

  if (schema instanceof z.ZodNullable) {
    if (data === undefined) add("Missing. Write null when there is none.");
    else if (data !== null) check(schema.unwrap() as z.ZodType, data, path, issues, true);
    return;
  }
  if (citedKind(schema)) {
    if (data === undefined) add(`Missing. Write ${BLANK} when the document does not print it.`);
    else if (!isRecord(data)) add(`Must be ${CITED}, got ${got(data)}.`);
    else for (const [key, child] of Object.entries((schema as z.ZodObject).shape as Record<string, z.ZodType>)) check(child, data[key], `${path}.${key}`, issues);
    return;
  }
  if (schema instanceof z.ZodString) {
    if (data === undefined) add("Missing. A string is required.");
    else if (typeof data !== "string") add(`Must be a string${orNull}, got ${got(data)}${typeof data === "number" ? ": write it in quotes" : ""}.`);
    return;
  }
  if (schema instanceof z.ZodNumber) {
    const expected = `Must be a whole number (1 for the first page)${orNull}`;
    if (typeof data !== "number") add(`${expected}, got ${got(data)}.`);
    else if (!Number.isFinite(data) || Math.abs(data) > MAX_PAGE) add(`${expected}, got a number too large to be a page.`);
    else if (!Number.isInteger(data)) add(`${expected}, got ${data}.`);
    return;
  }
  if (schema instanceof z.ZodEnum) {
    const options = schema.options as string[];
    const choice = `${orList(options)}${nullable ? ", or null" : ""}`;
    if (typeof data !== "string") add(`Must be one of ${choice}, got ${got(data)}.`);
    else if (!options.includes(data)) add(`Unknown ${lastKey(path)} ${JSON.stringify(data)}. Use ${choice}.`);
    return;
  }
  if (schema instanceof z.ZodLiteral) {
    const [value] = [...schema.values];
    if (data !== value) add(`Must be ${JSON.stringify(value)}.`);
    return;
  }
  if (schema instanceof z.ZodArray) {
    if (data === undefined) add("Missing. Write an empty array when there are none.");
    else if (!Array.isArray(data)) add(`Must be an array, got ${got(data)}.`);
    else data.forEach((item, index) => check(schema.element as z.ZodType, item, `${path}[${index}]`, issues));
    return;
  }
  if (schema instanceof z.ZodDiscriminatedUnion) {
    if (!isRecord(data)) return add(`Must be an object, got ${got(data)}.`);
    const options = new Map<string, z.ZodObject>();
    for (const option of schema.options as z.ZodObject[]) {
      const literal = (option.shape as Record<string, z.ZodType>).type as z.ZodLiteral;
      options.set(String([...literal.values][0]), option);
    }
    const types = orList([...options.keys()]);
    const { type } = data;
    const option = typeof type === "string" ? options.get(type) : undefined;
    if (option) {
      for (const [key, child] of Object.entries(option.shape as Record<string, z.ZodType>)) {
        if (key !== "type") check(child, data[key], `${path}.${key}`, issues);
      }
    } else if (type === undefined) issues.push({ path: `${path}.type`, message: `Missing. Use ${types}.` });
    else if (typeof type === "string") issues.push({ path: `${path}.type`, message: `Unknown type ${JSON.stringify(type)}. Use ${types}.` });
    else issues.push({ path: `${path}.type`, message: `Must be one of ${types}, got ${got(type)}.` });
    return;
  }
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodType>;
    const keys = Object.keys(shape).join(", ");
    if (data === undefined) add(`Missing. Write an object with the keys ${keys}.`);
    else if (!isRecord(data)) add(`Must be an object with the keys ${keys}, got ${got(data)}.`);
    else for (const [key, child] of Object.entries(shape)) check(child, data[key], `${path}.${key}`, issues);
    return;
  }
  throw new Error(`shape check: unsupported schema node at ${path}`);
}

/**
 * Every shape problem of `input`, in schema order; empty when the input is a
 * well-shaped extraction. An extraction written for another schema version
 * gets that one line and nothing else: its other problems all follow from it.
 */
export function shapeIssues(input: unknown): ShapeIssue[] {
  const current = JSON.stringify(SCHEMA_VERSION);
  if (!isRecord(input)) {
    return [{ path: TOP_LEVEL, message: `Must be one JSON object with the keys schemaVersion and documents, got ${got(input)}.` }];
  }
  const issues: ShapeIssue[] = [];
  const { schemaVersion, documents } = input;
  if (schemaVersion === undefined) {
    issues.push({ path: "schemaVersion", message: `Missing. Write "schemaVersion": ${current} when the extraction follows the guide that comes with this checker.` });
  } else if (typeof schemaVersion !== "string") {
    issues.push({ path: "schemaVersion", message: `Must be the string ${current}, got ${got(schemaVersion)}.` });
  } else if (schemaVersion !== SCHEMA_VERSION) {
    return [
      {
        path: "schemaVersion",
        message: `This extraction is written for schema version ${JSON.stringify(schemaVersion)}; this checker reads version ${current}. Extract the documents again with the guide that comes with this checker.`,
      },
    ];
  }
  if (documents === undefined) issues.push({ path: "documents", message: "Missing. Write an array with one object per document." });
  else if (!Array.isArray(documents)) issues.push({ path: "documents", message: `Must be an array with one object per document, got ${got(documents)}.` });
  else check(extractionSchema.shape.documents, documents, "documents", issues);
  return issues;
}
