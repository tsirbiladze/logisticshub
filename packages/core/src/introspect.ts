/**
 * Small walker over the extraction schema. Used to validate cited fields by
 * kind and to build blank documents (all facts null) for fixtures and tests.
 */
import { z } from "zod";
import {
  currencyValue,
  dateValue,
  decimalValue,
  DOCUMENT_TYPES,
  documentSchema,
  SCHEMA_VERSION,
  textValue,
  wordsValue,
  type DocumentType,
  type TradeDocument,
} from "./schema.ts";

export type CitedKind = "text" | "decimal" | "date" | "currency" | "words";

const KINDS = new Map<z.ZodType, CitedKind>([
  [textValue, "text"],
  [decimalValue, "decimal"],
  [dateValue, "date"],
  [currencyValue, "currency"],
  [wordsValue, "words"],
]);

/** Kind of a cited object schema ({ value, quote, page }), or null. */
export function citedKind(schema: z.ZodType): CitedKind | null {
  if (!(schema instanceof z.ZodObject)) return null;
  const value = (schema.shape as Record<string, z.ZodType>).value;
  return value ? (KINDS.get(value) ?? null) : null;
}

export interface CitedVisit {
  kind: CitedKind;
  path: string;
  field: { value: string | null; quote: string | null; page: number | null };
}

/** Calls `visit` for every cited field in `data`, following `schema`. */
export function walkCited(schema: z.ZodType, data: unknown, visit: (v: CitedVisit) => void, path = ""): void {
  const kind = citedKind(schema);
  if (kind) {
    visit({ kind, path, field: data as CitedVisit["field"] });
    return;
  }
  if (schema instanceof z.ZodNullable) {
    if (data !== null) walkCited(schema.unwrap() as z.ZodType, data, visit, path);
    return;
  }
  if (schema instanceof z.ZodDiscriminatedUnion) {
    const option = pickOption(schema, data);
    if (option) walkCited(option, data, visit, path);
    return;
  }
  if (schema instanceof z.ZodArray) {
    if (!Array.isArray(data)) return;
    data.forEach((item, index) => walkCited(schema.element as z.ZodType, item, visit, `${path}[${index}]`));
    return;
  }
  if (schema instanceof z.ZodObject) {
    if (typeof data !== "object" || data === null) return;
    for (const [key, child] of Object.entries(schema.shape as Record<string, z.ZodType>)) {
      walkCited(child, (data as Record<string, unknown>)[key], visit, path ? `${path}.${key}` : key);
    }
  }
}

function pickOption(schema: z.ZodDiscriminatedUnion, data: unknown): z.ZodType | null {
  if (typeof data !== "object" || data === null) return null;
  const type = (data as { type?: unknown }).type;
  for (const option of schema.options as z.ZodType[]) {
    if (option instanceof z.ZodObject) {
      const literal = (option.shape as Record<string, z.ZodType>).type;
      if (literal instanceof z.ZodLiteral && literal.values.has(type as never)) return option;
    }
  }
  return null;
}

function blank(schema: z.ZodType): unknown {
  if (citedKind(schema)) return { value: null, quote: null, page: null };
  if (schema instanceof z.ZodNullable) return null;
  if (schema instanceof z.ZodLiteral) return [...schema.values][0];
  if (schema instanceof z.ZodArray) return [];
  if (schema instanceof z.ZodString) return "";
  if (schema instanceof z.ZodObject) {
    return Object.fromEntries(
      Object.entries(schema.shape as Record<string, z.ZodType>).map(([key, child]) => [key, blank(child)]),
    );
  }
  throw new Error("blank(): unsupported schema node");
}

/**
 * The items of a document type's lists, each with every fact set to null, by
 * list key: { lines: {…} } for an invoice, { goods: {…}, attachedDocuments: {…} }
 * for a CMR. For references/extraction-blank.json.
 */
export function blankItems(type: DocumentType): Record<string, unknown> {
  const option = pickOption(documentSchema, { type });
  if (!(option instanceof z.ZodObject)) throw new Error(`Unknown document type: ${type}`);
  const items: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(option.shape as Record<string, z.ZodType>)) {
    if (child instanceof z.ZodArray) items[key] = blank(child.element as z.ZodType);
  }
  return items;
}

const BLANK_IDS: Record<DocumentType, string> = {
  commercial_invoice: "invoice",
  packing_list: "packing-list",
  cmr: "cmr",
  contract: "contract",
  customs_declaration: "declaration",
  other: "other",
};

/**
 * references/extraction-blank.json: the frame of the file, every document
 * type and every list item with all facts null. Parts to copy, not an
 * extraction: the lists of each document are empty, so that no blank line is
 * left behind in one (a line of nulls would switch the sums off).
 */
export function extractionBlank(): { how: string; file: unknown; documents: Record<string, unknown>; items: Record<string, unknown> } {
  const documents: Record<string, unknown> = {};
  const items: Record<string, unknown> = {};
  for (const type of DOCUMENT_TYPES) {
    documents[type] = blankDocument(type, BLANK_IDS[type]);
    const lists = blankItems(type);
    if (Object.keys(lists).length > 0) items[type] = lists;
  }
  return {
    how: 'Parts to copy into extraction.json; this file is not an extraction. "file" is the frame. Put one copy of a document from "documents" into the frame\'s "documents" array for each document you read, and one copy of an item from "items" into that document\'s list for each line the document prints. Fill in what is printed and leave the rest null.',
    file: { schemaVersion: SCHEMA_VERSION, documents: [] },
    documents,
    items,
  };
}

/** A document of the given type with every fact set to null. */
export function blankDocument<T extends DocumentType>(type: T, id: string): Extract<TradeDocument, { type: T }> {
  const option = pickOption(documentSchema, { type });
  if (!option) throw new Error(`Unknown document type: ${type}`);
  const doc = blank(option) as Record<string, unknown>;
  doc.id = id;
  return doc as Extract<TradeDocument, { type: T }>;
}
