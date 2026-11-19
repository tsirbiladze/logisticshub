/**
 * Parity: the Python port (scripts/check.py, for claude.ai and the Claude API
 * where Node is not available) must produce byte-identical reports to the
 * TypeScript checker, and read amounts in words identically.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildReport,
  checkDocuments,
  INCOTERM_NAMES,
  LEGAL_FORM_PHRASES,
  PACKING_KINDS,
  parseAmountInWords,
  parseJson,
  readRegistry,
  REPORT_LANGUAGES,
  renderHtml,
  renderJson,
  renderMarkdown,
  toFixed,
  type Language,
} from "@logisticshub/core";
import { toCardinal as enCardinal } from "n2words/en";
import { toCardinal as kaCardinal } from "n2words/ka";
import { toCardinal as ruCardinal } from "n2words/ru";
import { toCardinal as trCardinal } from "n2words/tr";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SCRIPT = join(ROOT, "skills/logisticshub/scripts/check.py");
const NODE_SCRIPT = join(ROOT, "skills/logisticshub/scripts/check.mjs");
/** The interpreter under test: python3, or the one LOGISTICSHUB_PYTHON names (an older one, to check the documented minimum). */
const PYTHON = process.env.LOGISTICSHUB_PYTHON || "python3";
const python = spawnSync(PYTHON, ["--version"]).status === 0;

function py(...args: string[]) {
  return spawnSync(PYTHON, [SCRIPT, ...args], { encoding: "utf8" });
}

function node(...args: string[]) {
  return spawnSync(process.execPath, [NODE_SCRIPT, ...args], { encoding: "utf8" });
}

const index = JSON.parse(readFileSync(join(ROOT, "fixtures/index.json"), "utf8")) as {
  packs: { id: string; variants: { id: string; registry?: string }[] }[];
};
const fixtureVariants = index.packs.flatMap((p) => p.variants.map((v) => [`${p.id}/${v.id}`, v] as const));
const fixtures = fixtureVariants.map(([path]) => path);
const registryFiles = new Map<string, string>(fixtureVariants.filter(([, v]) => v.registry).map(([path, v]) => [path, join(ROOT, "fixtures", path, v.registry!)]));

/** Inputs beyond the fixtures: unreadable shapes and per-field format issues. */
function brokenInputs(): [string, unknown][] {
  const clean = JSON.parse(readFileSync(join(ROOT, "fixtures/en-led-lighting/clean/extraction.json"), "utf8"));
  const formats = structuredClone(clean);
  formats.documents[0].total.value = "15,500.00";
  formats.documents[0].date.value = "2026-02-30";
  formats.documents[0].currency.value = "$";
  formats.documents[0].lines[0].unitPrice.quote = null;
  formats.documents[0].totalInWords.value = "fifteen thousand banana dollars";
  const noCmr = structuredClone(clean);
  noCmr.documents = noCmr.documents.filter((d: { type: string }) => d.type !== "cmr");
  return [
    ["formats", formats],
    ["no-cmr", noCmr],
  ];
}

/** Inputs that are not an extraction: every one must read the same in both ports, word for word. */
function shapeInputs(): [string, unknown][] {
  type Doc = Record<string, any>;
  const clean = () => JSON.parse(readFileSync(join(ROOT, "fixtures/en-led-lighting/clean/extraction.json"), "utf8")) as { schemaVersion: unknown; documents: Doc[] };
  const broken = (change: (docs: Doc[], e: Record<string, any>) => void) => {
    const e = clean();
    change(e.documents, e);
    return e;
  };
  return [
    ["shape-documents-not-a-list", broken((_, e) => void (e.documents = 1))],
    ["shape-top-level-array", [clean()]],
    ["shape-top-level-null", null],
    ["shape-top-level-string", "extraction"],
    ["shape-no-keys", {}],
    ["shape-unknown-type", broken((docs) => void (docs[0]!.type = "bill_of_lading"))],
    ["shape-missing-type", broken((docs) => void delete docs[1]!.type)],
    ["shape-type-not-a-string", broken((docs) => void (docs[2]!.type = ["cmr"]))],
    ["shape-missing-keys", broken((docs) => {
      delete docs[0]!.tax;
      delete docs[0]!.otherCharges;
      delete docs[0]!.seller;
      delete docs[0]!.lines[1].unit;
      delete docs[0]!.total.quote;
      delete docs[1]!.id;
      delete docs[1]!.sourceFile;
      delete docs[2]!.language;
    })],
    ["shape-wrong-types", broken((docs) => {
      docs[0]!.total = "15500.00";
      docs[0]!.subtotal.value = 15500;
      docs[0]!.lines[0].quantity.quote = 400;
      docs[0]!.lines = { 0: docs[0]!.lines[0] };
      docs[1]!.lines[0] = "line";
      docs[1]!.id = 7;
      docs[1]!.language = "de";
      docs[2]!.language = 3;
      docs[2]!.sourceFile = false;
      docs[3]!.seller = [];
      docs.push("contract.pdf" as unknown as Doc, null as unknown as Doc);
    })],
    ["shape-pages", broken((docs) => {
      docs[0]!.total.page = 1e300;
      docs[0]!.subtotal.page = 9007199254740993;
      docs[0]!.number.page = 1.5;
      docs[0]!.date.page = "1";
      docs[0]!.currency.page = -2.25;
      docs[0]!.seller.name.page = 1e-7;
      docs[0]!.buyer.name.page = true;
      docs[0]!.lines[0].quantity.page = 0;
      docs[0]!.lines[0].unit.page = 9007199254740991;
    })],
    ["shape-no-schema-version", broken((_, e) => void delete e.schemaVersion)],
    ["shape-schema-version-as-number", broken((_, e) => void (e.schemaVersion = Number(e.schemaVersion)))],
    ["shape-empty-document", broken((docs) => void (docs[2] = { type: "cmr" }))],
    // Written for schema version 1: without the keys version 2 added. One line, not one per key.
    ["shape-older-schema", broken((docs, e) => {
      e.schemaVersion = "1";
      for (const key of ["tax", "otherCharges", "discountPercent"]) delete docs[0]![key];
      delete docs[1]!.packingMethod;
    })],
    ["shape-newer-schema", broken((_, e) => void (e.schemaVersion = "2026-11"))],
  ];
}

/** Inputs for the review fixes: model split over lines, packing methods, Incoterms names, parties… */
function regressionInputs(): [string, unknown][] {
  type Doc = Record<string, any>;
  const load = (pack: string) => JSON.parse(readFileSync(join(ROOT, `fixtures/${pack}/clean/extraction.json`), "utf8"));
  const cite = (value: string | null, quote: string | null = value) => ({ value, quote, page: value === null ? null : 1 });
  const variant = (pack: string, change: (docs: Record<string, Doc>, e: { documents: Doc[] }) => void) => {
    const e = load(pack);
    const docs = Object.fromEntries(e.documents.map((d: Doc) => [d.type, d]));
    change(docs, e);
    return e;
  };
  const splitModel = (second: string) =>
    variant("en-led-lighting", ({ packing_list: pl }) => {
      const line = pl!.lines[0];
      pl!.lines.splice(1, 0, { ...structuredClone(line), quantity: cite(second), packages: cite("15"), netWeightKg: cite("120"), grossWeightKg: cite("138"), volumeM3: cite("0.9") });
      Object.assign(line, { quantity: cite("250"), packages: cite("25"), netWeightKg: cite("200"), grossWeightKg: cite("230"), volumeM3: cite("1.5") });
    });
  return [
    [
      "hs-from-consignee",
      variant("ka-office-furniture", ({ commercial_invoice: inv }) => {
        inv!.buyer.country = cite(null);
        inv!.consignee.country = cite("GÜRCİSTAN");
        inv!.lines[0].hsCode = cite("94O3 10");
        inv!.lines[1].hsCode = cite("9999 99");
      }),
    ],
    ["split-model", splitModel("150")],
    ["split-model-mismatch", splitModel("100")],
    [
      "pallets-and-cartons",
      variant("en-led-lighting", ({ cmr }) => {
        cmr!.goods = [{ ...cmr!.goods[0], packages: cite("12"), packingMethod: cite("pallets"), grossWeightKg: cite("785") }];
        cmr!.totalPackages = cite("12", "12 PLTS");
      }),
    ],
    [
      "packages-without-method",
      variant("ru-textile", ({ commercial_invoice: inv, cmr }) => {
        inv!.packages = cite("78");
        cmr!.goods[0].packingMethod = cite("паллеты");
        cmr!.goods[1].packingMethod = cite("паллеты");
        cmr!.totalPackages = cite(null);
        cmr!.goods[1].packages = cite("20");
      }),
    ],
    [
      "incoterm-names",
      variant("en-led-lighting", ({ commercial_invoice: inv, contract }) => {
        inv!.incoterm.code = cite("Delivered at Place");
        contract!.incoterm.code = cite("D.A.P.");
      }),
    ],
    [
      "incoterm-mismatch-and-unknown",
      variant("tr-ceramics", ({ commercial_invoice: inv, contract }, e) => {
        inv!.incoterm.code = cite("İşyerinde Teslim");
        contract!.incoterm.code = cite("Free Carrier");
        e.documents.push({ ...structuredClone(contract), id: "contract-2", incoterm: { ...contract!.incoterm, code: cite("Franco") } });
      }),
    ],
    [
      "parties",
      variant("tr-ceramics", ({ commercial_invoice: inv, packing_list: pl, cmr, contract }) => {
        inv!.seller.name = cite("EGE SERAMİK SANAYİ VE TİCARET ANONİM ŞİRKETİ");
        pl!.shipper.name = cite("Ege Seramik San. ve Tic. A.Ş.");
        contract!.buyer.name = cite("Batumi Yapı Market Limited Liability Company");
        cmr!.consignee.name = cite("Tex LLC");
        pl!.consignee.name = cite("Batumi Yapı Market Group L.L.C.");
      }),
    ],
    [
      "ref-prefix",
      variant("en-led-lighting", ({ commercial_invoice: inv, packing_list: pl, cmr }) => {
        inv!.number = cite("NOR-2026-118");
        pl!.invoiceRef.number = cite("No. NOR-2026-118");
        cmr!.attachedDocuments[0] = cite("Commercial invoice NR-2026-118");
      }),
    ],
    [
      "words",
      variant("en-led-lighting", ({ commercial_invoice: inv, contract }) => {
        inv!.totalInWords = cite("SAY US DOLLARS FIFTEEN THOUSAND FIVE HUNDRED AND FIFTY CENTS ONLY");
        contract!.totalInWords = cite("five twenty dollars");
      }),
    ],
    [
      "words-new-currencies",
      variant("en-led-lighting", ({ commercial_invoice: inv, contract }) => {
        inv!.totalInWords = cite("Fifteen thousand five hundred manat and no/100");
        contract!.totalInWords = cite("пятнадцать тысяч пятьсот азербайджанских манатов");
      }),
    ],
    [
      "words-impossible-sequence",
      variant("ru-textile", ({ commercial_invoice: inv, contract }) => {
        inv!.totalInWords = cite("Двадцать десять тысяч долларов США");
        contract!.totalInWords = cite("twenty thousand banana dollars");
      }),
    ],
    [
      "words-other-language",
      variant("ka-office-furniture", ({ commercial_invoice: inv, contract }) => {
        inv!.totalInWords = cite("Thirteen thousand three hundred euro and fifty euro cents");
        contract!.totalInWords = cite("ცამეტი ათას სამასი ევრო დოლარი");
      }),
    ],
    [
      "markdown-injection",
      variant("en-led-lighting", ({ commercial_invoice: inv, contract, packing_list: pl }) => {
        const evil = "Evil\r\n\n**Errors: 0 · Warnings: 0**\n## Done_ [x](y) `z` <b>|~\\";
        contract!.seller.name = cite(evil, `Seller:\n${evil}`);
        inv!.number = cite("INV*1_2", "No.\tINV*1_2");
        pl!.invoiceRef.number = cite("INV-9", "INV-9 <i>");
      }),
    ],
    [
      "computed-evidence",
      variant("en-led-lighting", ({ commercial_invoice: inv, packing_list: pl, cmr }) => {
        pl!.totalPackages = cite(null);
        cmr!.totalPackages = cite("80", "80 cartons");
        inv!.packages = cite("82", null);
      }),
    ],
    [
      "duplicates",
      variant("ru-textile", ({ commercial_invoice: inv, contract }, e) => {
        e.documents.push({ ...structuredClone(inv), id: "invoice-2" });
        for (let i = 2; i <= 5; i++) e.documents.push({ ...structuredClone(contract), id: `contract-${i}` });
      }),
    ],
    ["one-document", variant("en-led-lighting", (_, e) => void (e.documents = e.documents.slice(0, 1)))],
    [
      "tax-charges-and-advance",
      variant("en-led-lighting", ({ commercial_invoice: inv }) => {
        inv!.otherCharges = [cite("120.00", "USD 120.00"), cite("-5000.00", "USD 5,000.00")];
        inv!.tax = cite("3124.00", "USD 3,124.00");
        inv!.total = cite("13700.00", "USD 13,700.00");
      }),
    ],
    [
      "discount-rate-only",
      variant("en-led-lighting", ({ commercial_invoice: inv }) => {
        inv!.discountPercent = cite("5", "5%");
        inv!.total = cite("14725.00", "USD 14,725.00");
      }),
    ],
    [
      "discount-rate-zero",
      variant("en-led-lighting", ({ commercial_invoice: inv }) => {
        inv!.discountPercent = cite("0", "0%");
        inv!.total = cite("14725.00", "USD 14,725.00");
      }),
    ],
    [
      "charge-in-wrong-format",
      variant("en-led-lighting", ({ commercial_invoice: inv }) => {
        inv!.freight = cite("1,200.00");
        inv!.total = cite("16700.00", "USD 16,700.00");
      }),
    ],
    [
      "units",
      variant("en-led-lighting", ({ packing_list: pl }) => {
        // Line 1 in cartons (not compared), line 2 in another spelling of pieces (compared), line 3 without a unit (compared).
        Object.assign(pl!.lines[0], { quantity: cite("40"), unit: cite("CTNS") });
        Object.assign(pl!.lines[1], { quantity: cite("1400", "1,400"), unit: cite("Pieces.") });
        Object.assign(pl!.lines[2], { quantity: cite("500"), unit: cite(null) });
        pl!.totalQuantity = cite("1940", "1,940");
      }),
    ],
    [
      "units-in-total",
      variant("ru-textile", ({ commercial_invoice: inv, packing_list: pl }) => {
        for (const line of pl!.lines) line.model = cite(null);
        inv!.lines[0].unit = cite("ШТ.");
        pl!.lines[0].quantity = cite("2300", "2 300");
        pl!.totalQuantity = cite("2900", "2 900");
      }),
    ],
    [
      "units-plain-plurals",
      variant("en-led-lighting", ({ commercial_invoice: inv, packing_list: pl }) => {
        // "rolls" and "roll" are one unit (compared), "boxes" and "box" too, "gross" and "gros" are not.
        for (const [i, [a, b]] of [["rolls", "ROLL."], ["box", "Boxes"], ["gross", "gros"]].entries()) {
          inv!.lines[i].unit = cite(a!);
          pl!.lines[i].unit = cite(b!);
          pl!.lines[i].quantity = cite("7");
        }
        pl!.totalQuantity = cite("21");
      }),
    ],
    [
      "packing-method-in-header",
      variant("en-led-lighting", ({ packing_list: pl }) => {
        pl!.packingMethod = cite("pallets");
        for (const [i, n] of ["2", "1", "1"].entries()) pl!.lines[i].packages = cite(n);
        pl!.totalPackages = cite("4");
      }),
    ],
    [
      "value-not-in-quote",
      variant("tr-ceramics", ({ commercial_invoice: inv, packing_list: pl, cmr, contract }) => {
        // Thousands read as decimals, a value no reading gives, a percentage, a negative amount, words for digits.
        pl!.totalGrossWeightKg = cite("22.500", pl!.totalGrossWeightKg.quote);
        cmr!.totalGrossWeightKg = cite("22050", cmr!.totalGrossWeightKg.quote);
        inv!.discount = cite("5", "% 5");
        inv!.discountPercent = cite("5", "%5");
        inv!.tax = cite("20", "KDV %20");
        inv!.otherCharges = [cite("-150.00", "(150,00)"), cite("12", "on iki"), cite("7", "1.2.3"), cite("60100", "60 100"), cite("100", "60 100")];
        contract!.totalAmount = cite("9684", "EUR 9.684,00");
      }),
    ],
    [
      "rate-next-to-amount",
      variant("en-led-lighting", ({ commercial_invoice: inv }) => {
        // A percent sign belongs to the number it touches: the amounts are amounts, the rates are percentages.
        inv!.tax = cite("3124.00", "20% 3,124.00");
        inv!.otherCharges = [cite("1743.12", "%18 1.743,12"), cite("18", "%18 1.743,12"), cite("20", "20 % 3,124.00"), cite("5", "% 5"), cite("7", "7 %"), cite("20", "20%18")];
        inv!.freight = cite("20", "20% 3,124.00");
        inv!.insurance = cite("18", "3,124.00 18 %");
      }),
    ],
    [
      "date-not-in-quote",
      variant("ru-textile", ({ commercial_invoice: inv, packing_list: pl, cmr, contract }) => {
        inv!.date = cite("2026-10-06", inv!.date.quote);
        pl!.invoiceRef.date = cite("2026-05-10", "05.10.2026");
        cmr!.dateOfTakingOver = cite("2026-08-10", "08.10.26");
        contract!.date = cite("2026-09-22", "22/09/2026 г., 10:00");
        inv!.contractRef.date = cite("2026-09-21", "от «22» сентября 2026 г.");
      }),
    ],
    [
      "month-names-signs-currencies",
      variant("ru-textile", ({ commercial_invoice: inv, packing_list: pl, cmr, contract }) => {
        // Dates with month names in four languages (right, wrong and not beyond doubt), signs of charges, currencies.
        inv!.date = cite("2026-11-14", "14 Oct 2026");
        inv!.contractRef.date = cite("2026-09-21", "от «22» сентября 2026 г.");
        // A month is read in the document's own language or in English: the packing list is Georgian here, the contract Turkish.
        pl!.language = "ka";
        pl!.date = cite("2026-10-06", "2026 წლის 5 ოქტომბრის");
        pl!.invoiceRef.date = cite("2026-10-06", "05 EKİM 2026, 09:30");
        cmr!.date = cite("2026-05-04", "5 мая 2026 года");
        cmr!.dateOfTakingOver = cite("2026-01-01", "14 Oct 26");
        contract!.language = "tr";
        contract!.date = cite("2026-10-06", "05 EKİM 2026, 09:30");
        contract!.totalInWords = cite(null);
        inv!.freight = cite("500.00", "(500.00)");
        inv!.insurance = cite("120.5", "(USD 120.5)");
        inv!.tax = cite("500.00", "\u2212 500,00");
        inv!.discount = cite("500.00", "(500.00)");
        inv!.otherCharges = [cite("500.00", "-500.00"), cite("-500.00", "(500.00)"), cite("500.00", "Freight - 500.00"), cite("500.00", "500.00-"), cite("0.00", "(0.00)"), cite("7", "( 7 )")];
        inv!.currency = cite("EUR", "USD 15,500.00");
        contract!.currency = cite("USD", "13 300,00 ₾");
      }),
    ],
    [
      "currencies-left-alone",
      variant("en-led-lighting", ({ commercial_invoice: inv, contract }) => {
        inv!.currency = cite("CAD", "$ 15,500.00");
        contract!.currency = cite("USD", "ALL PRICES IN US DOLLARS / RUR / usd / USD1");
      }),
    ],
    [
      "currencies-with-other-words",
      variant("tr-ceramics", ({ commercial_invoice: inv, contract }) => {
        // Another code, but not alone with its amount: a word, a letter of another script, a code inside a longer token.
        inv!.currency = cite("EUR", "USD only 𝐀");
        contract!.currency = cite("EUR", "ლUSD GEL1 TRY");
      }),
    ],
    [
      "month-first-dates",
      variant("en-led-lighting", ({ commercial_invoice: inv, packing_list: pl }) => {
        inv!.date = cite("2026-10-14", "10/14/2026");
        inv!.contractRef.date = cite("2026-02-10", "10/02/2026");
        pl!.invoiceRef.date = cite("2026-10-14", "10/14/26");
      }),
    ],
    [
      "duplicate-id",
      variant("en-led-lighting", ({ commercial_invoice: inv, packing_list: pl, cmr }) => {
        pl!.id = inv!.id;
        cmr!.id = inv!.id;
        pl!.invoiceRef.number = cite("BL-INV-26-0421");
        cmr!.totalGrossWeightKg = cite("790");
      }),
    ],
    [
      "packing-method-per-line",
      variant("tr-ceramics", ({ packing_list: pl }) => {
        pl!.packingMethod = cite(null);
        for (const line of pl!.lines) line.packingMethod = cite("KOLİ");
      }),
    ],
  ];
}

describe("Python port: the interpreter", () => {
  it("is there when the suite runs in CI, so the parity tests below are never skipped unseen", () => {
    if (process.env.CI || process.env.LOGISTICSHUB_PYTHON) expect(python, `${PYTHON} --version`).toBe(true);
  });

  it.skipIf(!python)("is the version the workflow asked for", () => {
    const wanted = process.env.LOGISTICSHUB_PYTHON_VERSION;
    const version = spawnSync(PYTHON, ["-c", "import sys; print('%d.%d' % sys.version_info[:2])"], { encoding: "utf8" }).stdout.trim();
    expect(version).toMatch(/^3\.\d+$/);
    // "3.x" means the newest: only a pinned minor version is compared.
    if (wanted && /^3\.\d+$/.test(wanted)) expect(version).toBe(wanted);
  });
});

describe.skipIf(!python)("Python port", () => {
  it("looks up the same Georgian entries in both installed scripts", () => {
    for (const args of [
      ["9403 30 110 00"],
      ["საწერი  მაგიდ".toUpperCase(), "--json", "--limit", "3"],
      ["999999", "--json"],
    ]) {
      const [a, b] = [node("hs", ...args), py("hs", ...args)];
      expect(a.status).toBe(0);
      expect(b.status).toBe(0);
      expect(b.stderr).toBe("");
      expect(b.stdout).toBe(a.stdout);
    }
  });

  it("converts, selects and appends exact Revenue Service JSON in both scripts", () => {
    const dir = mkdtempSync(join(tmpdir(), "lh-py-rs-"));
    const fixture = join(ROOT, "fixtures/ka-office-furniture/declaration-rs-clean");
    const response = readFileSync(join(fixture, "rs-response.json"), "utf8").replace("40582.96", "9007199254740993.00000000120");
    const input = join(dir, "rs-response.json");
    const base = join(dir, "base.json");
    writeFileSync(input, response);
    const extraction = JSON.parse(readFileSync(join(fixture, "extraction.json"), "utf8"));
    extraction.documents.pop();
    writeFileSync(base, JSON.stringify(extraction));
    const args = ["declaration-from-rs", input, "--registration", "C-DEMO-2041", "--append", base];
    const a = node(...args);
    const b = py(...args);
    expect([a.status, b.status, a.stderr, b.stderr]).toEqual([0, 0, "", ""]);
    expect(b.stdout).toBe(a.stdout);
    const result = JSON.parse(b.stdout);
    expect(result.documents[4].items[0].rsValueInGel).toEqual({
      value: "9007199254740993.00000000120", quote: "9007199254740993.00000000120", page: null,
    });
    expect(checkDocuments(result).findings).toEqual([]);
    writeFileSync(input, response.replace('"ID": 0', '"ID": -1306'));
    for (const run of [node(...args), py(...args)]) {
      expect([run.status, run.stdout, run.stderr]).toEqual([2, "", "Revenue Service STATUS.ID is -1306.\n"]);
    }
  });

  it("prints the same JSON Schema", () => {
    const ts = JSON.parse(readFileSync(join(ROOT, "skills/logisticshub/references/extraction-schema.json"), "utf8"));
    expect(JSON.parse(py("--schema").stdout)).toEqual(ts);
  });

  it("keeps the same Incoterms names, legal forms and packing kinds", () => {
    const run = py("--dump-tables");
    expect(run.stderr).toBe("");
    expect(JSON.parse(run.stdout)).toEqual({ incotermNames: INCOTERM_NAMES, legalFormPhrases: LEGAL_FORM_PHRASES, packingKinds: PACKING_KINDS });
  });

  const rsDiscrepancy = JSON.parse(readFileSync(join(ROOT, "fixtures/ka-office-furniture/declaration-rs-clean/extraction.json"), "utf8"));
  rsDiscrepancy.documents[4].items[0].grossWeightKg = { value: "1205.000", quote: "1205.000", page: null };
  rsDiscrepancy.documents[4].items[0].countryOfOrigin = { value: "999", quote: "999", page: null };

  const cases = [
    ["declaration-json-with-findings", rsDiscrepancy] as [string, unknown],
    ...fixtures.map((path) => [path, JSON.parse(readFileSync(join(ROOT, `fixtures/${path}/extraction.json`), "utf8"))] as [string, unknown]),
    ...brokenInputs(),
    ...shapeInputs(),
    ...regressionInputs(),
  ];

  it.each(cases)("%s: reports are byte-identical in every language", (name, input) => {
    const dir = mkdtempSync(join(tmpdir(), "lh-py-"));
    const file = join(dir, "extraction.json");
    writeFileSync(file, JSON.stringify(input));
    const registryFile = registryFiles.get(name);
    const registryArgs = registryFile ? ["--registry", registryFile] : [];
    const result = checkDocuments(input, registryFile ? { registry: readRegistry(registryFile) } : {});
    const fixtureVariant = fixtureVariants.some(([path]) => path === name);
    if (fixtureVariant) {
      const expected = JSON.parse(readFileSync(join(ROOT, "fixtures", name, "expected.json"), "utf8"));
      expect(result.findings.map(({ rule, severity, key, params }) => ({ rule, severity, key, params }))).toEqual(expected);
    }
    for (const language of REPORT_LANGUAGES) {
      const out = join(dir, language);
      const run = py(file, "--lang", language, "--out", out, ...registryArgs);
      expect(run.stderr, `${name} ${language}`).toBe("");
      expect(run.status, `${name} ${language} exit`).toBe(result.ok ? 0 : 1);
      const view = buildReport(result, language);
      expect(readFileSync(join(out, "report.md"), "utf8"), `${name} ${language} md`).toBe(renderMarkdown(view));
      expect(readFileSync(join(out, "report.json"), "utf8"), `${name} ${language} json`).toBe(renderJson(result, view));
      expect(readFileSync(join(out, "report.html"), "utf8"), `${name} ${language} html`).toBe(renderHtml(view));
      if (fixtureVariant) {
        const nodeOut = join(dir, `node-${language}`);
        const built = node(file, "--lang", language, "--out", nodeOut, "--no-annotate", ...registryArgs);
        expect(built.status).toBe(0);
        for (const format of ["md", "json", "html"]) {
          const filename = `report.${format}`;
          expect(readFileSync(join(nodeOut, filename))).toEqual(readFileSync(join(out, filename)));
        }
      }
    }
  });

  it.each(["markdown-injection", "shape-unknown-type", "units-plain-plurals", "month-names-signs-currencies"])("%s: prints to the terminal what check.mjs prints, without Markdown escapes", (name) => {
    const input = [...shapeInputs(), ...regressionInputs()].find(([id]) => id === name)![1];
    const dir = mkdtempSync(join(tmpdir(), "lh-py-"));
    const file = join(dir, "extraction.json");
    writeFileSync(file, JSON.stringify(input));
    for (const language of REPORT_LANGUAGES) {
      const [a, b] = [node(file, "--lang", language, "--out", join(dir, "node"), "--no-annotate"), py(file, "--lang", language, "--out", join(dir, "py"))];
      const report = (run: ReturnType<typeof py>) => run.stdout.slice(0, run.stdout.indexOf("\nFiles:\n"));
      expect(report(b), `${name} ${language}`).toBe(report(a));
      expect(b.status).toBe(a.status);
      expect(b.stderr).toBe("");
      // What is printed is the report's text with document text unescaped; report.md keeps its escapes.
      const md = readFileSync(join(dir, "py", "report.md"), "utf8");
      expect(md.replace(/\\([\\`*_[\]<>|~])/g, "$1").trimEnd()).toBe(report(b).trimEnd());
    }
    if (name === "shape-unknown-type") expect(py(file, "--out", join(dir, "py")).stdout).toContain('Unknown type "bill_of_lading". Use commercial_invoice, packing_list, cmr, contract, customs_declaration or other.');
  });

  it("tells an extraction of the wrong shape apart from one with findings", () => {
    const shapes = shapeInputs();
    expect(shapes.every(([, input]) => !checkDocuments(input).ok)).toBe(true);
    expect(checkDocuments(shapes.find(([name]) => name === "shape-older-schema")![1]).extractionIssues).toHaveLength(1);
    expect(checkDocuments(shapes.find(([name]) => name === "shape-pages")![1]).extractionIssues.map((i) => i.message.replace(/^.*, got /, ""))).toEqual([
      "1.5.",
      "a string.",
      "1e-7.",
      "a boolean.",
      "-2.25.",
      "a number too large to be a page.",
      "a number too large to be a page.",
    ]);
  });

  describe("what it cannot read or write ends like check.mjs: the same line, exit code 2", () => {
    const clean = join(ROOT, "fixtures/en-led-lighting/clean/extraction.json");
    const scratch = () => mkdtempSync(join(tmpdir(), "lh-py-"));
    const same = (...args: string[]) => {
      const [a, b] = [node(...args), py(...args)];
      expect(b.stderr).toBe(a.stderr);
      expect(b.stdout).toBe(a.stdout);
      expect(b.status).toBe(a.status);
      return b;
    };

    it("a malformed registry snapshot", () => {
      const dir = scratch();
      const path = join(dir, "registry.json");
      writeFileSync(path, '{"schemaVersion":"1","entries":[]}');
      const run = same(clean, "--registry", path, "--out", dir);
      expect(run).toMatchObject({ status: 2, stdout: "" });
      expect(run.stderr).toContain("Invalid registry snapshot");
    });

    it("an output folder that cannot be made or written to", () => {
      const dir = scratch();
      const blocker = join(dir, "notes.txt");
      writeFileSync(blocker, "a file");
      expect(same(clean, "--out", join(blocker, "reports")).stderr).toBe(
        `Cannot write to ${join(blocker, "reports")}: a file stands where a folder is needed (ENOTDIR). Give --out a folder that can be written to.\n`,
      );
      expect(same(clean, "--out", blocker).stderr).toContain("a file with that name is in the way (EEXIST)");
      mkdirSync(join(dir, "report.md"));
      const taken = same(clean, "--out", dir);
      expect(taken.stderr).toBe(`Cannot write ${join(dir, "report.md")}: it is a folder, not a file (EISDIR). Give --out a folder that can be written to.\n`);
      expect(taken.status).toBe(2);
    });

    it("a file that is missing or is a folder", () => {
      const dir = scratch();
      expect(same(join(dir, "missing.json")).stderr).toBe(`Cannot read ${join(dir, "missing.json")}: no such file or folder (ENOENT).\n`);
      expect(same(dir)).toMatchObject({ status: 2, stderr: `Cannot read ${dir}: it is a folder, not a file (EISDIR).\n` });
    });

    it.each([
      "",
      " \n",
      '{"schemaVersion": "1", "documents": [],}',
      '{"schemaVersion": "1"\n "documents": []}',
      "{'schemaVersion': '1'}",
      '{"schemaVersion": "1", "documents": [',
      '{"a": "unfinished',
      '{"a": tru}',
      '{"a": NaN}',
      '{"a": Infinity}',
      '{"a": -Infinity}',
      '{"a": 01}',
      '{"a": 1.}',
      '{"a": -}',
      '{"a": 1e}',
      '{"a": "bad \\x escape"}',
      '{"a": "\\u12G4"}',
      '{"a": "tab\there"}',
      '{"a": 1} {"b": 2}',
      '{"ქართული 😀": 1,\n "b" 2}',
      '{"a": "😀" 😀}',
      "[1 2]",
      "// a comment\n{}",
      "```json\n{}\n```",
      "\u00a0{}",
      "{\"a\": 1}\u0000",
    ])("text that is not JSON: %j", (text) => {
      const file = join(scratch(), "extraction.json");
      writeFileSync(file, text);
      const read = parseJson(text);
      if (read.ok) throw new Error("the test text is valid JSON");
      const run = py(file);
      expect(run.stderr).toBe(`Cannot read ${file}: ${read.problem}. Fix the file and run the check again.\n`);
      expect(run.stdout).toBe("");
      expect(run.status).toBe(2);
    });

    it("reads a file with a byte order mark, UTF-8 or UTF-16, like check.mjs", () => {
      const dir = scratch();
      const file = join(dir, "extraction.json");
      const text = readFileSync(join(ROOT, "fixtures/ka-office-furniture/words-mismatch/extraction.json"), "utf8");
      const plain = py(join(ROOT, "fixtures/ka-office-furniture/words-mismatch/extraction.json"), "--out", join(dir, "plain"), "--format", "md");
      expect(plain.status).toBe(0);
      const report = readFileSync(join(dir, "plain", "report.md"), "utf8");
      const variants: [string, Buffer][] = [
        ["utf-8", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")])],
        ["utf-16le", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")])],
        ["utf-16be", Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, "utf16le").swap16()])],
      ];
      for (const [name, bytes] of variants) {
        writeFileSync(file, bytes);
        const run = same(file, "--no-annotate", "--out", join(dir, name), "--format", "md");
        expect(run.status, name).toBe(0);
        expect(readFileSync(join(dir, name, "report.md"), "utf8"), name).toBe(report);
      }
    });

    it("words a wrong option the same way", () => {
      const firstLine = (run: ReturnType<typeof py>) => run.stderr.split("\n")[0];
      for (const args of [["--format", "md,pdf,pdf,doc", clean], ["--lang", "xx", clean], ["--out"], ["--nope"], [clean, clean], []]) {
        const [a, b] = [node(...args), py(...args)];
        expect(firstLine(b), args.join(" ")).toBe(firstLine(a));
        expect(b.status).toBe(2);
        expect(a.status).toBe(2);
      }
      expect(firstLine(py("--format", "md,pdf,pdf,doc", clean))).toBe('--format takes a comma list of md, json, html; got "pdf", "doc".');
    });
  });

  it("picks the report language like the TypeScript checker", () => {
    const dir = mkdtempSync(join(tmpdir(), "lh-py-"));
    const run = py(join(ROOT, "fixtures/tr-ceramics/clean/extraction.json"), "--format", "md", "--out", dir);
    expect(readFileSync(join(dir, "report.md"), "utf8")).toContain("# Belge kontrol raporu");
    expect(run.status).toBe(0);
  });

  it("reads amounts in words exactly like the TypeScript parser", () => {
    const cardinals: Record<string, (n: number) => string> = { en: enCardinal, ru: ruCardinal, tr: trCardinal, ka: kaCardinal };
    const phrases: [string, Language | null][] = [];
    let seed = 7;
    for (const [lang, toWords] of Object.entries(cardinals)) {
      for (let i = 0; i < 400; i++) {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        const n = i < 120 ? i : i % 2 ? seed % 1_000_000 : seed;
        phrases.push([toWords(n), lang as Language]);
      }
    }
    phrases.push(
      ["ცამეტი ათას სამასი ევრო და ნული ცენტი", null],
      ["SAY US DOLLARS THIRTEEN THOUSAND THREE HUNDRED AND CENTS FIFTY ONLY", null],
      ["Thirteen thousand three hundred euros and 00/100", null],
      ["тринадцати тысяч трёхсот евро", null],
      ["YALNIZ ONÜÇBİNÜÇYÜZ AVRO SIFIR SENT", null],
      ["ON UC BIN UC YUZ TURK LIRASI", null],
      ["yalnız ikiyüzaltmışbeş ABD doları", null],
      ["ორ ათას ლარი", "ka"],
      ["five twenty euro", "en"],
      ["ten euro twenty euro", "en"],
      ["ten euro one hundred cents", "en"],
      ["thirteen thousand banana euro", "en"],
      ["euro only", "en"],
      ["", null],
      ["SAY US DOLLARS FIFTEEN THOUSAND FIVE HUNDRED AND FIFTY CENTS ONLY", "en"],
      ["US Dollars twenty and five cents", null],
      ["fifteen thousand five hundred and fifty cents", "en"],
      ["EUR thirteen thousand three hundred euros and 00 cents", "en"],
      ["Euro: thirteen thousand three hundred euro and fifty cents", null],
      ["Thirteen thousand three hundred and 00/100 US Dollars", null],
      ["Thirteen thousand three hundred euros and 50/100 cents", "en"],
      ["thirteen thousand three hundred euros and fifty euro cents", "en"],
      ["fifty euro cents", null],
      ["one thousand eurocents", "en"],
      ["thirteen thousand euro dollars", "en"],
      ["fifty dollars cents", "en"],
      ["one thousand dollars fifty", "en"],
      ["Тринадцать тысяч триста евро 00 евроцентов", "ru"],
      ["Тринадцать тысяч триста долл. США 00 центов", null],
      ["Двадцать тысяч и пятьдесят копеек рублей", "ru"],
      ["ცამეტი ათას სამასი ევრო 50 ევროცენტი", "ka"],
      ["ორმოცდაათი ევროცენტი", null],
      ["ცამეტი ათას სამასი ევრო დოლარი", "ka"],
      ["Yalnız #BinİkiyüzTürkLirasıElliKuruş#", "tr"],
      ["YALNIZ #BİNİKİYÜZABDDOLARIELLİSENT#", null],
      ["Yalnız on üç bin üç yüz Avro sıfır Euro Cent", "tr"],
      ["Yalnız ABD doları bin ve elli sent", "tr"],
      ["Twenty thousand euro", "ka"],
      ["twenty banana euro", "ka"],
      ["ხუთი ოცი ევრო", "ka"],
      // Impossible sequences, articles, "no cents", the region's currencies, the fallback language's error.
      ["THIRTY TWENTY dollars", "en"],
      ["twenty thirteen euro", "en"],
      ["ten one euro", "en"],
      ["one hundred thirty twenty euro", "en"],
      ["двадцать десять рублей", "ru"],
      ["сто двести рублей", "ru"],
      ["yirmi on lira", "tr"],
      ["on bir lira", "tr"],
      ["yüz on dokuz lira", "tr"],
      ["on on", "tr"],
      ["ოცდაოცი ლარი", "ka"],
      ["ოცდაათი ლარი", "ka"],
      ["ათი ცხრა ლარი", "ka"],
      ["a hundred US dollars", "en"],
      ["an amount of a hundred and five euros", "en"],
      ["a dollar", "en"],
      ["a five dollars", null],
      ["Fifteen thousand five hundred US dollars and no cents", "en"],
      ["Fifteen thousand five hundred and no/100 US dollars", null],
      ["five hundred and xx/100 dollars", "en"],
      ["fifteen thousand five hundred tenge", "en"],
      ["Fifteen thousand Kazakhstani tenge 00 tiyn", null],
      ["two thousand Azerbaijani manats", "en"],
      ["two thousand manat Turkmen", "en"],
      ["two thousand manat", null],
      ["five hundred Swiss francs", "en"],
      ["Swiss five hundred francs", "en"],
      ["five hundred francs", "en"],
      ["one thousand United Arab Emirates dirhams", "en"],
      ["one thousand Moroccan dirhams and 50 fils", "en"],
      ["twelve thousand hryvnias 50 kopiyok", "en"],
      ["Пятнадцать тысяч пятьсот казахстанских тенге 00 тиын", "ru"],
      ["две тысячи азербайджанских манатов", null],
      ["пятьсот швейцарских франков", "ru"],
      ["двенадцать тысяч гривен 50 копеек", "ru"],
      ["одна тысяча дирхамов ОАЭ", "ru"],
      ["YALNIZ BEŞBİN TENGE", "tr"],
      ["yalnız iki bin Azerbaycan manatı", "tr"],
      ["BEŞ YÜZ ISVICRE FRANGI", null],
      ["yalnız #BeşYüzİsviçreFrangı#", "tr"],
      ["on iki bin grivna", "tr"],
      ["bin BAE dirhemi", "tr"],
      ["თხუთმეტი ათას ხუთასი ტენგე", "ka"],
      ["ორი ათასი აზერბაიჯანული მანათი", "ka"],
      ["ხუთასი შვეიცარიული ფრანკი", null],
      ["თორმეტი ათასი უკრაინული გრივნის ოდენობით", "ka"],
      ["пятнадцать тысяч пятьсот тенге", "en"],
      ["пятнадцать тысяч бананов тенге", "en"],
      ["yirmi banana lira", "en"],
      ["thirteen thousand banana", "tr"],
    );
    const ts = phrases.map(([text, lang]) => {
      const r = parseAmountInWords(text, lang);
      return r.ok
        ? { ok: true, amount: toFixed(r.value.amount, r.value.amount.scale), currency: r.value.currency, language: r.value.language }
        : { ok: false, code: r.error.code, word: r.error.word ?? null };
    });
    const dir = mkdtempSync(join(tmpdir(), "lh-py-"));
    const file = join(dir, "phrases.json");
    writeFileSync(file, JSON.stringify(phrases.map(([text, language]) => ({ text, language }))));
    const run = py("--parse-words-file", file);
    expect(run.stderr).toBe("");
    const results = JSON.parse(run.stdout);
    const mismatches = phrases.flatMap(([text], i) => (JSON.stringify(results[i]) === JSON.stringify(ts[i]) ? [] : [`${text} → py ${JSON.stringify(results[i])} ts ${JSON.stringify(ts[i])}`]));
    expect(mismatches.slice(0, 5)).toEqual([]);
    expect(results.length).toBe(phrases.length);
  });
});
