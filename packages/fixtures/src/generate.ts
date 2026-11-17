/**
 * Writes fixtures/<pack>/<variant>/ with PDFs, extraction.json and
 * expected.json, plus fixtures/index.json.
 *
 *   node packages/fixtures/src/generate.ts            # check + render PDFs
 *   node packages/fixtures/src/generate.ts --no-pdf   # check + JSON only
 *
 * Needs Chromium (CHROMIUM env or chromium-browser on PATH) with the Noto Sans
 * and Noto Sans Georgian fonts, and poppler: pdftotext verifies that every
 * quote is really printed on the page the extraction names, pdftoppm turns a
 * document into the page images of a "scan", pdfunite puts two documents
 * into one file. Fails without writing if a variant does not produce exactly
 * its expected findings.
 *
 * Chromium's PDFs differ byte for byte from run to run. After a run, restore
 * from git the PDFs whose printed text did not change.
 */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { extractionSchema, walkCited } from "@logisticshub/core";
import { buildAll, type BuiltVariant } from "./build.ts";
import { DOCUMENT_NAMES, documentNames, pageCount, variantFiles, type DocumentName } from "./model.ts";
import { renderCmr, renderContract, renderInvoice, renderPackingList } from "./render.ts";

const run = promisify(execFile);
const OUT = fileURLToPath(new URL("../../../fixtures/", import.meta.url));
const CHROMIUM = process.env.CHROMIUM ?? "chromium-browser";
const withPdf = !process.argv.includes("--no-pdf");

/** The HTML of each of a variant's documents, by name. */
function documentsHtml(built: BuiltVariant): Map<DocumentName, string> {
  const { documents: d, pack, variant } = built;
  const breakBefore = variant.layout?.invoiceBreakBefore;
  return new Map<DocumentName, string>([
    ["invoice", renderInvoice(d.invoice, pack.spec, breakBefore === undefined ? {} : { breakBefore })],
    ["packing-list", renderPackingList(d.packingList, pack.spec)],
    ["cmr", renderCmr(d.cmr, pack.spec)],
    ["contract", renderContract(d.contract, pack.spec)],
    ...(d.secondInvoice ? [["invoice-2", renderInvoice(d.secondInvoice, pack.spec)] as [DocumentName, string]] : []),
  ]);
}

const squash = (text: string) => text.normalize("NFC").replace(/\s+/g, " ").trim();

async function renderPdf(html: string, pdfPath: string, scratch: string): Promise<void> {
  const htmlPath = join(scratch, `${Math.random().toString(36).slice(2)}.html`);
  writeFileSync(htmlPath, html);
  await run(CHROMIUM, [
    "--headless",
    "--disable-gpu",
    "--no-pdf-header-footer",
    "--run-all-compositor-stages-before-draw",
    `--print-to-pdf=${pdfPath}`,
    `file://${htmlPath}`,
  ]);
}

/**
 * A scan of a text PDF: every page as a 200 dpi grey image, set a little
 * askew on an A4 page. No text layer is left.
 */
async function scanPdf(textPdf: string, pdfPath: string, scratch: string): Promise<void> {
  const prefix = `scan-${Math.random().toString(36).slice(2)}`;
  await run("pdftoppm", ["-r", "200", "-gray", "-jpeg", "-jpegopt", "quality=80", textPdf, join(scratch, prefix)]);
  const images = readdirSync(scratch).filter((name) => name.startsWith(`${prefix}-`)).sort();
  const pages = images.map((name) => `<div class="page"><img src="file://${join(scratch, name)}"></div>`).join("");
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: A4; margin: 0; }
    body { margin: 0; }
    .page { width: 210mm; height: 296.5mm; overflow: hidden; }
    .page + .page { break-before: page; }
    img { display: block; width: 210mm; height: 297mm; transform: rotate(-0.4deg) scale(0.99); }
  </style></head><body>${pages}</body></html>`;
  await renderPdf(html, pdfPath, scratch);
}

/** One PDF file of a variant: one document, or several printed one after the other. */
interface PdfJob {
  pdf: string;
  built: BuiltVariant;
  /** The documents in the file, in page order: their HTML, their place in the extraction, the pages each takes. */
  parts: { html: string; index: number; pages: number }[];
  scanned: boolean;
}

async function verifyPdf(job: PdfJob): Promise<string[]> {
  const { pdf: pdfPath, built } = job;
  const problems: string[] = [];
  const expected = job.parts.reduce((sum, part) => sum + part.pages, 0);
  const { stdout: info } = await run("pdfinfo", [pdfPath]);
  const pages = /Pages:\s+(\d+)/.exec(info)?.[1];
  if (pages !== String(expected)) problems.push(`${pdfPath}: ${pages} pages, expected ${expected}`);
  if (job.scanned) {
    const { stdout } = await run("pdftotext", ["-raw", pdfPath, "-"]);
    if (squash(stdout) !== "") problems.push(`${pdfPath}: a scan must have no text layer`);
    return problems;
  }
  // Every quote on the page the extraction names.
  const text: string[] = [];
  for (let page = 1; page <= expected; page++) {
    const { stdout } = await run("pdftotext", ["-raw", "-f", String(page), "-l", String(page), pdfPath, "-"]);
    text[page] = squash(stdout);
  }
  let first = 1;
  for (const part of job.parts) {
    const doc = built.extraction.documents[part.index];
    const last = first + part.pages - 1;
    walkCited(extractionSchema.shape.documents.element, doc, ({ path, field }) => {
      if (!field.quote) return;
      const page = field.page ?? 0;
      // On the page the extraction names, and that page is one of this document's own in the file.
      if (page < first || page > last || !text[page]?.includes(squash(field.quote))) problems.push(`${pdfPath}: quote not printed on page ${field.page} at ${path}: "${field.quote}"`);
    });
    first = last + 1;
  }
  return problems;
}

async function pool<T>(items: T[], size: number, task: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(Array.from({ length: size }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await task(item);
  }));
}

async function main() {
  const all = buildAll();
  const broken = all.filter((b) => b.actualKeys.join() !== b.expectedKeys.join() || b.actualIssues.join() !== b.expectedIssues.join());
  for (const b of broken) {
    console.error(`✗ ${b.pack.spec.id}/${b.variant.id}\n  expected: ${b.expectedKeys.join(", ") || "(none)"}\n  actual:   ${b.actualKeys.join(", ") || "(none)"}`);
    if (b.actualIssues.join() !== b.expectedIssues.join()) console.error(`  expected issues: ${b.expectedIssues.join(", ") || "(none)"}\n  actual issues:   ${b.actualIssues.join(", ") || "(none)"}`);
  }
  if (broken.length > 0) process.exit(1);
  console.log(`✓ ${all.length} variants produce exactly their expected findings and extraction issues`);

  // Start clean only when PDFs are rendered too; --no-pdf keeps existing PDFs.
  if (withPdf) rmSync(OUT, { recursive: true, force: true });
  const scratch = mkdtempSync(join(tmpdir(), "lh-fixtures-"));
  const jobs: PdfJob[] = [];

  for (const built of all) {
    const dir = join(OUT, built.pack.spec.id, built.variant.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "extraction.json"), `${JSON.stringify(built.extraction, null, 2)}\n`);
    const expected = built.findings.map(({ rule, severity, key, params }) => ({ rule, severity, key, params }));
    writeFileSync(join(dir, "expected.json"), `${JSON.stringify(expected, null, 2)}\n`);
    const { layout } = built.variant;
    const html = documentsHtml(built);
    const names = documentNames(built.documents);
    for (const { file, documents } of variantFiles(layout, names)) {
      jobs.push({
        pdf: join(dir, file),
        built,
        parts: documents.map((name) => ({ html: html.get(name)!, index: names.indexOf(name), pages: pageCount(layout, name) })),
        scanned: documents.some((name) => layout?.scanned?.includes(name)),
      });
    }
  }

  const index = packIndex(all);
  writeFileSync(join(OUT, "index.json"), `${JSON.stringify(index, null, 2)}\n`);

  if (withPdf) {
    const problems: string[] = [];
    let done = 0;
    await pool(jobs, 4, async (job) => {
      const [only] = job.parts;
      if (job.parts.length > 1) {
        // Each document is printed on its own, then the files are put together: every document starts on a new page.
        const printed = job.parts.map(() => join(scratch, `${Math.random().toString(36).slice(2)}.pdf`));
        for (const [i, part] of job.parts.entries()) await renderPdf(part.html, printed[i]!, scratch);
        await run("pdfunite", [...printed, job.pdf]);
      } else if (job.scanned) {
        const printed = join(scratch, `${Math.random().toString(36).slice(2)}.pdf`);
        await renderPdf(only!.html, printed, scratch);
        await scanPdf(printed, job.pdf, scratch);
      } else {
        await renderPdf(only!.html, job.pdf, scratch);
      }
      problems.push(...(await verifyPdf(job)));
      done += 1;
      if (done % 10 === 0) console.log(`  ${done}/${jobs.length} PDFs`);
    });
    rmSync(scratch, { recursive: true, force: true });
    if (problems.length > 0) {
      console.error(problems.join("\n"));
      process.exit(1);
    }
    console.log(`✓ ${jobs.length} PDFs rendered, every quote printed on its page`);
  }
  console.log(`→ ${OUT}`);
}

function packIndex(all: BuiltVariant[]) {
  const packs = [...new Set(all.map((b) => b.pack))];
  return {
    note: "Synthetic demo data. All companies, people and numbers are fictional.",
    packs: packs.map((pack) => ({
      id: pack.spec.id,
      language: pack.spec.language,
      title: pack.spec.title,
      documents: ["invoice", "packing-list", "cmr", "contract"],
      // layout: what is not one page of text per document (a table over two pages, a scan, two documents in one file).
      // expectedIssues: the extraction issues of the one variant whose documents cannot be read for certain.
      // files: the variant's PDFs, where they are not one per document of the pack (a second invoice, a file with two documents).
      variants: pack.variants.map((v) => {
        const built = all.find((b) => b.pack === pack && b.variant === v)!;
        const files = variantFiles(v.layout, documentNames(built.documents)).map(({ file }) => file);
        return {
          id: v.id,
          title: v.title,
          expected: v.expected,
          ...(v.expectedIssues ? { expectedIssues: v.expectedIssues } : {}),
          ...(v.layout ? { layout: v.layout } : {}),
          ...(files.join() === DOCUMENT_NAMES.map((name) => `${name}.pdf`).join() ? {} : { files }),
        };
      }),
    })),
  };
}

await main();
