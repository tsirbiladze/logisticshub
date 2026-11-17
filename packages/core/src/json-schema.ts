/**
 * JSON Schema for model-facing structured output.
 *
 * Claude structured outputs (and most providers) accept only a subset of
 * JSON Schema: no numeric/length constraints, no `oneOf`, and every object
 * needs `additionalProperties: false`. Zod's export is cleaned up here; the
 * dropped constraints are enforced after extraction by parseExtraction().
 */
import { z } from "zod";
import {
  cmrSchema,
  commercialInvoiceSchema,
  contractSchema,
  DOCUMENT_TYPES,
  extractionSchema,
  languageSchema,
  otherDocumentSchema,
  packingListSchema,
  type DocumentType,
} from "./schema.ts";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const DROPPED_KEYS = new Set([
  "$schema",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
]);

const SUPPORTED_FORMATS = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "uri",
  "ipv4",
  "ipv6",
  "uuid",
]);

function sanitize(node: Json): Json {
  if (Array.isArray(node)) return node.map(sanitize);
  if (node === null || typeof node !== "object") return node;

  const out: { [key: string]: Json } = {};
  for (const [key, value] of Object.entries(node)) {
    if (DROPPED_KEYS.has(key)) continue;
    if (key === "format" && typeof value === "string" && !SUPPORTED_FORMATS.has(value)) continue;
    out[key === "oneOf" ? "anyOf" : key] = sanitize(value);
  }

  const properties = out.properties;
  if (out.type === "object" || (properties && typeof properties === "object" && !Array.isArray(properties))) {
    out.additionalProperties = false;
    if (properties && typeof properties === "object" && !Array.isArray(properties)) {
      out.required = Object.keys(properties);
    }
  }
  return out;
}

type JsonObject = { [key: string]: Json };

/**
 * Keeps only named $defs (citedText, party, invoiceLine…) and inlines the
 * anonymous "__schemaN" ones Zod creates for reused described fields, so the
 * schema stays readable for agents and humans.
 */
function inlineAnonymous(schema: JsonObject): JsonObject {
  const defs = (schema.$defs ?? {}) as JsonObject;
  const anonymous = (ref: unknown) => typeof ref === "string" && ref.startsWith("#/$defs/__schema");
  const resolve = (node: Json): Json => {
    if (Array.isArray(node)) return node.map(resolve);
    if (node === null || typeof node !== "object") return node;
    if (anonymous(node.$ref)) {
      const { $ref, ...siblings } = node;
      const target = resolve(defs[(node.$ref as string).slice("#/$defs/".length)] ?? {}) as JsonObject;
      return { ...target, ...Object.fromEntries(Object.entries(siblings).map(([k, v]) => [k, resolve(v)])) };
    }
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, resolve(v)]));
  };
  const named = Object.fromEntries(Object.entries(defs).filter(([key]) => !key.startsWith("__schema")).map(([k, v]) => [k, resolve(v)]));
  const { $defs, ...rest } = schema;
  void $defs;
  return { ...(resolve(rest) as JsonObject), $defs: named };
}

/** JSON Schema for one extraction call (all documents in a set). */
export function extractionJsonSchema(): JsonObject {
  // Shared sub-schemas (cited fields, parties…) become named $defs instead of repeating inline.
  const raw = z.toJSONSchema(extractionSchema, { unrepresentable: "throw", reused: "ref" }) as JsonObject;
  return sanitize(inlineAnonymous(raw)) as JsonObject;
}

const DOCUMENT_SCHEMAS = {
  commercial_invoice: commercialInvoiceSchema,
  packing_list: packingListSchema,
  cmr: cmrSchema,
  contract: contractSchema,
  other: otherDocumentSchema,
} as const;

function toModelSchema(schema: z.ZodType): JsonObject {
  return sanitize(inlineAnonymous(z.toJSONSchema(schema, { unrepresentable: "throw", reused: "ref" }) as JsonObject)) as JsonObject;
}

/**
 * JSON Schema for one document of a known type. The CLI sends it in the
 * request rather than as strict structured output: that compiles the schema
 * into a grammar, and Claude refuses the invoice's as too large.
 */
export function documentJsonSchema(type: DocumentType): JsonObject {
  return toModelSchema(DOCUMENT_SCHEMAS[type]);
}

export const classificationSchema = z.object({
  files: z.array(
    z.object({
      sourceFile: z.string().describe("File name exactly as given."),
      type: z.enum(DOCUMENT_TYPES).describe("What the document in this file is."),
      language: languageSchema.nullable().describe("Main language of the document text."),
    }),
  ),
});

/** JSON Schema for classifying files before extraction. */
export function classificationJsonSchema(): JsonObject {
  return toModelSchema(classificationSchema);
}
