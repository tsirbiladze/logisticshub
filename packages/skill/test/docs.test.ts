/**
 * The docs say what the code does. README (EN, KA), the two page docs that
 * https://tsirbiladze.com/skills/logisticshub renders, the CLI's README and
 * the changelog are checked against the sources they describe, and against
 * each other, so a change in behaviour cannot leave them behind.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildReport, checkDocuments, ISSUES_GUIDE, NOT_CHECKED, renderMarkdown, RULE_IDS, type ReportLanguage } from "@logisticshub/core";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

const README = { en: read("README.md"), ka: read("README.ka.md") };
const PAGE = { en: read("docs/logisticshub.md"), ka: read("docs/logisticshub.ka.md") };
const CLI_README = read("packages/cli/README.md");
const LANGUAGES = ["en", "ka"] as const;

/** The "## " sections of a document, in order: the heading and the text under it. */
function sections(markdown: string): { heading: string; body: string }[] {
  const body = markdown.replace(/^---\n[\s\S]*?\n---\n/, "");
  return body
    .split(/^## /m)
    .slice(1)
    .map((part) => ({ heading: part.slice(0, part.indexOf("\n")), body: part.slice(part.indexOf("\n") + 1).trim() }));
}

function frontmatter(markdown: string): Record<string, string> {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(markdown)?.[1] ?? "";
  return Object.fromEntries(block.split("\n").map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1).trim()]));
}

const bullets = (text: string) => text.split("\n").filter((line) => line.startsWith("- "));
const tableRows = (text: string) => text.split("\n").filter((line) => line.startsWith("|"));
/** Link and image targets: [text](target) and ![alt](target). */
const targets = (markdown: string) => [...markdown.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]!);

/** The "Limits" section: the same text in a README and in its page doc. */
const limits = (markdown: string, index: number) => sections(markdown)[index]!.body;
const README_LIMITS = { en: limits(README.en, 4), ka: limits(README.ka, 4) };
const PAGE_LIMITS = { en: limits(PAGE.en, 4), ka: limits(PAGE.ka, 4) };

describe("the page docs the website renders", () => {
  it("keep their frontmatter keys, in both languages", () => {
    for (const language of LANGUAGES) {
      const fields = frontmatter(PAGE[language]);
      expect(Object.keys(fields), language).toEqual(["title", "summary", "category", "status", "source"]);
      for (const [key, value] of Object.entries(fields)) expect(value, `${language} ${key}`).not.toBe("");
    }
    expect(frontmatter(PAGE.ka).source).toBe(frontmatter(PAGE.en).source);
    expect(frontmatter(PAGE.ka).status).toBe(frontmatter(PAGE.en).status);
  });

  it("have no H1, only absolute links, no install commands and no copy of the SKILL.md steps", () => {
    const skill = read("packages/skill/SKILL.md");
    const steps = [...skill.matchAll(/^## \d\. .+$/gm)].map((m) => m[0]);
    expect(steps).toHaveLength(4);
    for (const language of LANGUAGES) {
      const page = PAGE[language];
      expect(page, language).not.toMatch(/^# /m);
      for (const target of targets(page)) expect(target, language).toMatch(/^https:\/\//);
      expect(page, language).not.toMatch(/npx skills|\/plugin (marketplace|install)|npm (i|install|add) |pnpm (add|install)|```/);
      for (const step of steps) expect(page, language).not.toContain(step);
      expect(page, language).not.toContain("<this-skill-dir>");
    }
  });

  it("are twins: the same sections in the same order, with the same lists, tables and image", () => {
    const en = sections(PAGE.en);
    const ka = sections(PAGE.ka);
    expect(en.map((s) => s.heading)).toEqual(["What it does", "When to reach for it", "What it checks", "It's working if", "Limits", "Where it fits"]);
    expect(ka).toHaveLength(en.length);
    en.forEach((section, i) => {
      const twin = ka[i]!;
      const shape = (body: string) => ({
        paragraphs: body.split(/\n\n+/).length,
        bullets: bullets(body).length,
        tableRows: tableRows(body).length,
        links: targets(body),
      });
      expect(shape(twin.body), `${section.heading} / ${twin.heading}`).toEqual(shape(section.body));
    });
  });

  it("show the marked invoice at the size the website cuts its crops from", () => {
    const png = readFileSync(join(ROOT, "docs/marked-invoice.png"));
    expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");
    // IHDR: width and height, big-endian, right after the signature and the chunk header.
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1242, 862]);
    for (const doc of [README.en, README.ka, PAGE.en, PAGE.ka]) expect(doc).toContain("docs/marked-invoice.png)");
  });
});

describe("limits", () => {
  it("are worded once: the README and the page doc carry the same text, in each language", () => {
    for (const language of LANGUAGES) {
      expect(sections(README[language])[4]!.heading, language).toBe(sections(PAGE[language])[4]!.heading);
      expect(README_LIMITS[language], language).toBe(PAGE_LIMITS[language]);
    }
  });

  it("list everything references/rules.md lists as not checked, in its order", () => {
    const lead = (line: string) => /\*\*(.+?)\*\*/.exec(line)?.[1];
    const stated = NOT_CHECKED.map(lead);
    expect(stated.every(Boolean)).toBe(true);
    const inDocs = bullets(README_LIMITS.en).map(lead).filter(Boolean);
    expect(inDocs).toEqual(stated);
    // The Georgian text is a translation: the same number of points, each with its own lead.
    const inGeorgian = bullets(README_LIMITS.ka).map(lead).filter(Boolean);
    expect(inGeorgian).toHaveLength(stated.length);
    expect(new Set(inGeorgian).size).toBe(stated.length);
    expect(bullets(README_LIMITS.ka)).toHaveLength(bullets(README_LIMITS.en).length);
  });
});

describe("README", () => {
  it("has the same sections in English and in Georgian", () => {
    const en = sections(README.en);
    const ka = sections(README.ka);
    expect(en.map((s) => s.heading)).toEqual(["Install", "What it checks", "How it works", "Privacy", "Limits", "Quality", "Design decisions", "Development", "How this was built", "License"]);
    expect(ka).toHaveLength(en.length);
    // What can be compared without reading Georgian: the rule table, the skill folder, the files the design decisions name, the commands, the paths.
    const code = (body: string) => [...body.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!);
    for (const i of [1, 2, 6, 7]) {
      expect(tableRows(ka[i]!.body).length, en[i]!.heading).toBe(tableRows(en[i]!.body).length);
      expect(new Set(code(ka[i]!.body).filter((c) => !c.includes("<"))), en[i]!.heading).toEqual(new Set(code(en[i]!.body).filter((c) => !c.includes("<"))));
    }
    for (const id of RULE_IDS) for (const language of LANGUAGES) expect(sections(README[language])[1]!.body, `${language} ${id}`).toContain(`**${id}**`);
  });

  it("shows a finding exactly as the report prints it, in both languages", () => {
    const result = checkDocuments(JSON.parse(read("fixtures/en-led-lighting/line-arithmetic/extraction.json")));
    for (const language of LANGUAGES) {
      const example = /```markdown\n([\s\S]*?)\n```/.exec(README[language])?.[1];
      expect(example, language).toBeTruthy();
      expect(renderMarkdown(buildReport(result, language as ReportLanguage)), language).toContain(`${example}\n`);
      expect(example, language).toContain("\n→ ");
    }
  });

  it("counts the rules, the packs and the variants as they are", () => {
    const index = JSON.parse(read("fixtures/index.json")) as { packs: { variants: unknown[] }[] };
    const variants = index.packs.reduce((n, pack) => n + pack.variants.length, 0);
    expect(README.en).toContain(`${index.packs.length} synthetic packs (KA, EN, RU, TR) with ${variants} variants`);
    expect(README.ka).toContain(`${index.packs.length} სინთეზური ნაკრები (KA, EN, RU, TR), სულ ${variants} ვარიანტი`);
    expect(read("AGENTS.md")).toContain(`All ${variants} variants`);
    expect(README.en).toContain(`${RULE_IDS.length} deterministic rules`);
    expect(README.ka).toContain(`${RULE_IDS.length} დეტერმინისტული წესი`);
    for (const language of LANGUAGES) expect(PAGE[language], language).toMatch(new RegExp(`\\b${RULE_IDS.length} `));
    expect(CLI_README).toContain(`${RULE_IDS.length} deterministic rules`);
  });

  it("says what the variants cover: how many are clean, the special layouts, the rules with a planted problem", () => {
    type Variant = { id: string; expected: string[]; layout?: Record<string, unknown>; files?: unknown; expectedIssues?: string[] };
    const variants = (JSON.parse(read("fixtures/index.json")) as { packs: { variants: Variant[] }[] }).packs.flatMap((pack) => pack.variants);
    const clean = variants.filter((v) => v.expected.length === 0).length;
    expect(README.en).toContain(`${clean} sets without a problem and ${variants.length - clean} with a planted one`);
    expect(README.ka).toContain(`${clean} უშეცდომო ნაკრები და ${variants.length - clean} ნაკრები განზრახ ჩადებული შეცდომით`);
    // Each layout the README names is a variant of the index.
    const has = (test: (v: Variant) => boolean) => variants.some(test);
    for (const [named, there] of [
      ["an invoice over two pages", has((v) => v.layout?.invoiceBreakBefore !== undefined)],
      ["a scanned CMR", has((v) => Array.isArray(v.layout?.scanned))],
      ["two documents in one PDF", has((v) => Array.isArray(v.layout?.combined))],
      ["a second invoice", has((v) => v.id === "second-invoice" && v.expected.includes("DOC-01.multiple"))],
      ["dates written month first", has((v) => v.id === "month-first-dates" && v.expected.length === 0)],
      ["a packing list that prints numbers in two conventions", has((v) => v.id === "mixed-number-conventions" && v.expectedIssues?.length === 1)],
    ] as const) {
      expect(README.en, named).toContain(named);
      expect(there, named).toBe(true);
    }
    const planted = new Set(variants.flatMap((v) => v.expected.map((key) => key.slice(0, key.indexOf(".")))));
    const without = RULE_IDS.filter((id) => !planted.has(id));
    expect(README.en).toContain(`The planted problems cover ${planted.size} of the ${RULE_IDS.length} rules. ${without.slice(0, -1).join(", ")} and ${without.at(-1)} have no variant`);
    expect(README.ka).toContain(`ჩადებული შეცდომები ${RULE_IDS.length} წესიდან ${planted.size}-ს მოიცავს. ${without.slice(0, -1).join(", ")} და ${without.at(-1)} წესებისთვის ვარიანტი არ არის`);
  });

  it("names every file of the skill folder", () => {
    const built = ["SKILL.md", "references/extraction.md", "references/extraction-schema.json", "references/extraction-blank.json", "references/issues.md", "references/rules.md", "scripts/check.mjs", "scripts/check.py", "scripts/check-data.json", "scripts/THIRD-PARTY-NOTICES.txt"];
    for (const file of built) {
      expect(() => read(`skills/logisticshub/${file}`), file).not.toThrow();
      for (const language of LANGUAGES) expect(sections(README[language])[2]!.body, `${language} ${file}`).toContain(`\`${file}\``);
    }
  });

  it("gives the checker's exit codes as its usage text does", () => {
    const usage = read("packages/skill/src/cli.ts");
    expect(usage).toContain("0  checked, with or without findings");
    expect(usage).toContain("1  the extraction is not usable: the reports list what to fix");
    expect(usage).toContain("2  nothing was checked: a bad option, a file that cannot be read or is not\n     JSON, or reports that cannot be written");
    const how = sections(README.en)[2]!.body;
    expect(how).toContain("`0` when the documents were checked, with or without findings");
    expect(how).toContain("`1` when the extraction is not usable");
    expect(how).toContain("`2` when nothing was checked: a bad option, an `extraction.json` that cannot be read or is not JSON, or reports that cannot be written");
    for (const code of ["`0`", "`1`", "`2`"]) expect(sections(README.ka)[2]!.body).toContain(code);
  });
});

describe("the CLI's README", () => {
  it("lists every note references/issues.md lists, in the same words and order", () => {
    /** The first cell of each row of the table under a line that starts with `after`. */
    const notes = (markdown: string, after: string) => {
      const from = markdown.indexOf(after);
      expect(from, after).toBeGreaterThanOrEqual(0);
      // The first table after that line: its rows without the header and the rule under it.
      const lines = markdown.slice(from).split("\n");
      const start = lines.findIndex((line) => line.startsWith("|"));
      const end = lines.findIndex((line, i) => i > start && !line.startsWith("|"));
      return lines.slice(start + 2, end).map((row) => row.split(" | ")[0]!.replace(/^\| /, ""));
    };
    const inSkill = notes(ISSUES_GUIDE, "## Notes");
    expect(inSkill.length).toBeGreaterThanOrEqual(9);
    expect(notes(CLI_README, "`Notes:` never change the exit code.")).toEqual(inSkill);
  });

  it("says what was run against a real model and no more: one model, three demo sets, and of which version", () => {
    expect(CLI_README).toContain("This path is tested with a stand-in model. ");
    const said = /Version (\S+) was also run once against a real model, on \d{4}-\d{2}-\d{2}: `claude-[a-z0-9-]+` read three demo sets \(([^)]+)\)/.exec(CLI_README);
    expect(said, "the sentence about the real run").not.toBeNull();
    const [, version, sets] = said!;
    const variants = (JSON.parse(read("fixtures/index.json")) as { packs: { id: string; variants: { id: string }[] }[] }).packs.flatMap((pack) => pack.variants.map((variant) => `\`${pack.id}/${variant.id}\``));
    const named = sets!.split(", ");
    expect(named).toHaveLength(3);
    for (const set of named) expect(variants, set).toContain(set);
    expect(CLI_README).toContain("every other model and every document that is not a demo are still untried");
    // A later version either repeats the run and says so, or says that it was not run.
    const current = (JSON.parse(read("packages/cli/package.json")) as { version: string }).version;
    if (version !== current) expect(CLI_README).toContain("This version has not been run against a real model.");
  });
});

describe("Georgian docs", () => {
  const georgian = [README.ka, PAGE.ka];

  it("are never capitalised: no Mtavruli and no Asomtavruli letters", () => {
    for (const text of georgian) expect(text).not.toMatch(/[Ა-ᲿႠ-჏]/);
  });

  it("use the report's words: სტრიქონი, დოკუმენტი, ამოკითხვა", () => {
    for (const text of georgian) {
      // What the report stopped saying: ხაზი (a drawn line), საბუთი, ამოღება (seizure, in customs language), and the coined compounds.
      expect(text).not.toMatch(/ხაზ|საბუთ|ამოღებ|ურთიერთმითით|ურთიერთშემოწმ|ჯამურ|ქვეჯამ/);
      for (const word of ["სტრიქონ", "დოკუმენტ", "ამოკითხ", "შეუსაბამობ"]) expect(text).toContain(word);
    }
  });

  it("use the owner's two terms: შეფუთვის ფურცელი and ადგილების რაოდენობა", () => {
    for (const text of georgian) {
      expect(text).toContain("შეფუთვის ფურცელი");
      expect(text).toContain("ადგილების რაოდენობა");
      // The words they replace, in any case form; and ფურცელი loses its vowel in the genitive (ფურცლის).
      expect(text).not.toMatch(/შეფუთვის სი[აი]|შეფუთვის რაოდენობ|ფურცელის/);
    }
  });

  it("read as natural Georgian: მონაცემი for a fact, one word for synthetic, no calques", () => {
    for (const text of georgian) {
      // ფაქტი for an item of data, "to the byte" and "its title" carried over word for word, and the second spelling of "synthetic".
      expect(text).not.toMatch(/ფაქტ(?!ობრივ)|ბაიტამდე|მისი სათაური|სინთეტიკ|აირჩიე ერთი\.|იმასაც, როცა/);
      // What the skill is for is said of the skill, not of its description.
      expect(text).not.toContain("სკილის აღწერაში");
    }
    // The word the fixture PDFs print for "synthetic" is the one the README uses.
    expect(read("packages/fixtures/src/labels.ts")).toContain("სინთეზური დოკუმენტი");
    expect(README.ka).toContain("სინთეზური ნაკრები");
  });

  it("speak to the reader as შენ", () => {
    // The formal forms the house style does not use, and the informal ones the docs do use.
    for (const text of georgian) {
      expect(text).not.toMatch(/თქვენ|გთხოვთ|იხილეთ|გაუშვით|შეამოწმეთ|მიიღებთ|გამოიყენეთ/);
      expect(text).toMatch(/მიიღებ[ ,.]/);
    }
  });
});

describe("changelog", () => {
  it("opens with the version the packages carry", () => {
    const version = JSON.parse(read("packages/cli/package.json")).version as string;
    const first = /^## (\S+) — (\d{4}-\d{2}-\d{2})$/m.exec(read("CHANGELOG.md"));
    expect(first?.[1]).toBe(version);
  });

  it("has one entry, the first release, and does not promise one box where the marker boxes every copy", () => {
    expect(read("CHANGELOG.md").split(/^## /m)).toHaveLength(2);
    const entry = read("CHANGELOG.md").split(/^## /m)[1]!;
    expect(entry.split("\n\n")[1]).toBe("First release.");
    // What the entry counts is what the repo holds.
    const packs = (JSON.parse(read("fixtures/index.json")) as { packs: { language: string; variants: unknown[] }[] }).packs;
    expect(entry).toContain(`${RULE_IDS.length} deterministic rules`);
    expect(entry).toContain(`${packs.reduce((n, pack) => n + pack.variants.length, 0)} demo sets of synthetic documents in four languages`);
    expect(new Set(packs.map((pack) => pack.language)).size).toBe(4);
    expect(entry).not.toContain("box each finding once.");
    expect(entry).toContain("Where a copy cannot be tied to a field, every copy is boxed and a note says so.");
    // The four places that carry the version agree with the entry.
    const version = /^(\S+) — /.exec(entry)![1]!;
    expect(JSON.parse(read("packages/skill/package.json")).version).toBe(version);
    expect(JSON.parse(read(".claude-plugin/plugin.json")).version).toBe(version);
    expect(read("packages/skill/SKILL.md")).toContain(`version: "${version}"`);
  });
});
