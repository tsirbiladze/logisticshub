import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";

type Entry = [code: string, description: string, depth: number, unit?: string];
interface Edition {
  orderNumber: number;
  orderDate: string;
  publishedDate: string;
  inForceFrom: string;
  title: string;
  documentId: number;
  publication: number;
  laterAmendmentsVerified: false;
}

interface NomenclatureData {
  edition: Edition;
  sourceUrl: string;
  entries: Entry[];
}

export const GEORGIA_COUNTRIES = ["ge", "geo", "georgia", "საქართველო", "грузия", "gürcistan"] as const;
export const HS_LOOKUP_LIMIT = 20;

export const normalizeHsCode = (value: string): string => value.replace(/[\s.]/gu, "");

function indexNomenclature() {
  const data = JSON.parse(gunzipSync(readFileSync(new URL("./hs-nomenclature.json.gz", import.meta.url))).toString("utf8")) as NomenclatureData;
  const byCode = new Map(data.entries.map((row) => [row[0], row]));
  const bySubheading = new Map<string, Entry[]>();
  for (const row of data.entries) {
    if (row[0].length < 6) continue;
    const subheading = row[0].slice(0, 6);
    const rows = bySubheading.get(subheading) ?? [];
    rows.push(row);
    bySubheading.set(subheading, rows);
  }
  return { ...data, byCode, bySubheading };
}

let index: ReturnType<typeof indexNomenclature> | undefined;

export function hsNomenclature() {
  return index ??= indexNomenclature();
}

const descriptionKey = (value: string) => value.toLowerCase().replace(/\s/gu, "");

function describeEntry([code, description, depth, unit]: Entry) {
  const level = code.length === 4 ? "heading" : code.length === 11 ? "national code" : "subheading";
  return { code, level, description, depth, supplementaryUnit: unit ?? null };
}

/** Searches printed codes and descriptions in the saved Georgian edition. */
export function lookupHsCode(query: string, limit = HS_LOOKUP_LIMIT) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("Limit must be a positive integer.");
  const { edition, sourceUrl, entries, byCode } = hsNomenclature();
  const digits = normalizeHsCode(query);
  const numeric = /^[0-9]+$/.test(digits);
  const needle = descriptionKey(query);
  const matches = [];
  if (needle) {
    for (const row of entries) {
      if (!(numeric ? row[0].startsWith(digits) : descriptionKey(row[1]).includes(needle))) continue;
      const ancestors = [4, 6, 8, 9].flatMap((length) => {
        const parent = length < row[0].length ? byCode.get(row[0].slice(0, length)) : undefined;
        return parent ? [describeEntry(parent)] : [];
      });
      matches.push({ ...describeEntry(row), ancestors });
      if (matches.length === limit) break;
    }
  }
  return { edition, sourceUrl, matches };
}

/** The hs subcommand shared by the npm CLI and the installed Node skill. */
export function hsLookupOutput(args: string[]): string {
  const { values, positionals } = parseArgs({
    args,
    options: { json: { type: "boolean" }, limit: { type: "string" } },
    allowPositionals: true,
  });
  const [query] = positionals;
  if (positionals.length !== 1 || !query?.trim()) throw new Error("Give one HS code or Georgian description.");
  const limit = values.limit === undefined ? HS_LOOKUP_LIMIT : /^[0-9]+$/.test(values.limit) ? Number(values.limit) : NaN;
  const result = lookupHsCode(query, limit);
  if (values.json) return JSON.stringify(result, null, 2);

  const { edition, sourceUrl, matches } = result;
  const lines = [
    `Georgian nomenclature · Order No. ${edition.orderNumber} of ${edition.orderDate} · publication ${edition.publication} (original text). Later amendments were not verified.`,
    sourceUrl,
    "",
  ];
  for (const match of matches) {
    const unit = match.supplementaryUnit ? ` [${match.supplementaryUnit}]` : "";
    lines.push(`${match.code} (${match.level}) · ${match.description}${unit}`);
    if (match.ancestors.length) lines.push(`  ${match.ancestors.map((parent) => `${parent.code} ${parent.description}`).join(" › ")}`);
  }
  if (matches.length === 0) lines.push("No matches.");
  return lines.join("\n");
}
