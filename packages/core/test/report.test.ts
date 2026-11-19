import { describe, expect, it } from "vitest";
import {
  buildReport,
  checkDocuments,
  checkLine,
  pickLanguage,
  renderHtml,
  renderMarkdown,
  renderReports,
  renderText,
  REPORT_CSS,
  KEY_CHECKS,
  REPORT_LANGUAGES,
  RULE_CHECKS,
  SCHEMA_VERSION,
  UI,
  type MessageKey,
  type ReportLanguage,
} from "../src/index.ts";
import { c, kaPack } from "./support/ka-pack.ts";

function brokenPack() {
  const pack = kaPack();
  const invoice = pack.documents[0]!;
  if (invoice.type !== "commercial_invoice") throw new Error("fixture order");
  invoice.totalInWords = c("ცამეტი ათას ხუთასი ევრო და ნული ცენტი");
  return pack;
}

describe("reports", () => {
  it("picks the documents' language by default", () => {
    expect(pickLanguage(kaPack())).toBe("ka");
    expect(pickLanguage(null)).toBe("en");
  });

  it("says when there is nothing to fix", () => {
    const md = renderMarkdown(buildReport(checkDocuments(kaPack()), "en"));
    expect(md).toContain("**Errors: 0 · Warnings: 0** · Checked: 4 documents, 18 rules");
    expect(md).toContain("✓ No problems found.");
  });

  it("does not say 'no problems' while extraction issues keep values out of the rules", () => {
    const pack = kaPack();
    const invoice = pack.documents[0]!;
    if (invoice.type !== "commercial_invoice") throw new Error("fixture order");
    invoice.total = c("13.300", "EUR 13,300.00");
    const reports = renderReports(checkDocuments(pack), "en");
    expect(reports.md).toContain("**Errors: 0 · Warnings: 0**");
    expect(reports.md).toContain("(EXT_QUOTE_MISMATCH)");
    expect(reports.md).not.toContain("No problems found");
    expect(reports.html).not.toContain("No problems found");
  });

  it.each<[ReportLanguage, string, string]>([
    ["en", "Amount in words reads 13,500.00 EUR, but the amount in figures is 13,300.00 EUR.", "invoice AOS-INV-2026-0918-01 (logisticshub-test-01-commercial-invoice.pdf), p. 1 · total: “EUR 13,300.00”"],
    ["ka", "სიტყვიერად წერია 13\u00a0500,00 EUR, ციფრებით კი 13\u00a0300,00 EUR.", "ინვოისი AOS-INV-2026-0918-01 (logisticshub-test-01-commercial-invoice.pdf), გვ. 1 · საბოლოო ჯამი: „EUR 13,300.00“"],
    ["ru", "Прописью указано 13\u00a0500,00 EUR, а цифрами — 13\u00a0300,00 EUR.", "инвойс AOS-INV-2026-0918-01 (logisticshub-test-01-commercial-invoice.pdf), стр. 1 · итог: «EUR 13,300.00»"],
    ["tr", "Yazıyla 13.500,00 EUR yazıyor, rakamla tutar ise 13.300,00 EUR.", "fatura AOS-INV-2026-0918-01 (logisticshub-test-01-commercial-invoice.pdf), s. 1 · genel toplam: “EUR 13,300.00”"],
  ])("renders findings with quoted evidence in %s", (language, message, evidenceLine) => {
    const md = renderReports(checkDocuments(brokenPack()), language).md;
    expect(md).toContain(message);
    expect(md).toContain(`- ${evidenceLine}`);
  });

  it("explains unreadable input and lists extraction issues", () => {
    const md = renderMarkdown(buildReport(checkDocuments({ schemaVersion: SCHEMA_VERSION, documents: [{ type: "cmr" }] }), "en"));
    expect(md).toContain("The extraction could not be read");
    expect(md).toContain("## Extraction issues");
  });

  it("escapes document text in HTML", () => {
    const pack = brokenPack();
    const invoice = pack.documents[0]!;
    invoice.number = c('<img src=x onerror="alert(1)">');
    const html = renderHtml(buildReport(checkDocuments(pack), "en"));
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("labels only computed sums as 'sum of lines'", () => {
    const pack = kaPack();
    const [invoice, pl, cmr] = pack.documents;
    if (invoice?.type !== "commercial_invoice" || pl?.type !== "packing_list" || cmr?.type !== "cmr") throw new Error("fixture order");
    pl.totalPackages = c(null);
    cmr.totalPackages = c("90", "90 ყუთი");
    invoice.packages = c("100", null);
    const reports = renderReports(checkDocuments(pack), "en");
    const lines = reports.md.split("\n").filter((line) => line.startsWith("- "));
    expect(lines).toContain("- invoice AOS-INV-2026-0918-01 (logisticshub-test-01-commercial-invoice.pdf), p. 1 · number of packages: 100");
    expect(lines).toContain("- packing list AOS-PL-2026-0919-01 (logisticshub-test-02-packing-list.pdf), p. 1: 100 (sum of lines)");
    expect(reports.md.match(/sum of lines/g)).toHaveLength(1);
    expect(reports.html.match(/sum of lines/g)).toHaveLength(1);
  });

  describe("which field each piece of evidence is", () => {
    /** The judge's case: an invoice whose subtotal and total print the same text, with a tax between them. */
    function taxLeftOut() {
      const pack = kaPack();
      const invoice = pack.documents[0]!;
      if (invoice.type !== "commercial_invoice") throw new Error("fixture order");
      invoice.discount = c(null);
      invoice.tax = c("2394.00", "EUR 2,394.00");
      return checkDocuments(pack);
    }
    const source = "(logisticshub-test-01-commercial-invoice.pdf)";

    it.each<[ReportLanguage, string[]]>([
      ["en", [`p. 1 · total: “EUR 13,300.00”`, `p. 1 · subtotal: “EUR 13,300.00”`, `p. 1 · tax: “EUR 2,394.00”`]],
      ["ka", [`გვ. 1 · საბოლოო ჯამი: „EUR 13,300.00“`, `გვ. 1 · საქონლის ღირებულება: „EUR 13,300.00“`, `გვ. 1 · გადასახადი: „EUR 2,394.00“`]],
      ["ru", [`стр. 1 · итог: «EUR 13,300.00»`, `стр. 1 · стоимость товара: «EUR 13,300.00»`, `стр. 1 · налог: «EUR 2,394.00»`]],
      ["tr", [`s. 1 · genel toplam: “EUR 13,300.00”`, `s. 1 · mal bedeli: “EUR 13,300.00”`, `s. 1 · vergi: “EUR 2,394.00”`]],
    ])("is said in front of its quote in %s: three lines, three names", (language, expected) => {
      const reports = renderReports(taxLeftOut(), language);
      const lines = reports.md.split("\n").filter((line) => line.startsWith("- "));
      expect(lines.map((line) => line.slice(line.indexOf(source) + source.length + 2))).toEqual(expected);
      // The same names in HTML and in JSON.
      const json = JSON.parse(reports.json) as { findings: { key: string; evidence: { path: string; label: string | null }[] }[] };
      expect(json.findings.map((f) => f.key)).toEqual(["SUM-02.total"]);
      const labels = json.findings[0]!.evidence.map((e) => e.label);
      expect(json.findings[0]!.evidence.map((e) => e.path)).toEqual(["total", "subtotal", "tax"]);
      expect(labels).toEqual(expected.map((line) => line.slice(line.indexOf("·") + 2, line.indexOf(": "))));
      for (const label of labels) expect(reports.html).toContain(`<span class="field">${label}:</span> <q>EUR `);
    });

    it("names a line's field with its line, and leaves a sum of lines without a name", () => {
      const pack = kaPack();
      const [invoice, pl, cmr] = pack.documents;
      if (invoice?.type !== "commercial_invoice" || pl?.type !== "packing_list" || cmr?.type !== "cmr") throw new Error("fixture order");
      invoice.lines[1]!.lineTotal = c("4700.00", "4,700.00");
      pl.totalPackages = c(null);
      cmr.totalPackages = c("90", "90 ყუთი");
      const reports = renderReports(checkDocuments(pack), "en");
      expect(reports.md).toContain("p. 1 · line 2, quantity: “40”");
      expect(reports.md).toContain("p. 1 · line 2, unit price: “115.00”");
      expect(reports.md).toContain("p. 1 · line 2, total: “4,700.00”");
      expect(reports.md).toContain("(logisticshub-test-02-packing-list.pdf), p. 1: 100 (sum of lines)");
      expect(reports.md).toContain("(logisticshub-test-03-cmr.pdf), p. 1 · total number of packages: “90 ყუთი”");
      const json = JSON.parse(reports.json) as { findings: { key: string; evidence: { path: string; label: string | null }[] }[] };
      const packages = json.findings.find((f) => f.key === "QTY-01.packages")!;
      expect(packages.evidence.map((e) => [e.path, e.label])).toEqual([["packages", "number of packages"], ["lines[*]", null], ["totalPackages", "total number of packages"]]);
      expect(reports.html).toContain('</span>100 <span class="src">sum of lines</span>');
    });

    it("tells the CMR's two dates apart", () => {
      const pack = kaPack();
      const [invoice, , cmr] = pack.documents;
      if (invoice?.type !== "commercial_invoice" || cmr?.type !== "cmr") throw new Error("fixture order");
      invoice.date = c("2026-09-25", "25.09.2026");
      expect(renderReports(checkDocuments(pack), "en").md).toContain("p. 1 · date of taking over: “19.09.2026, 09:00”");
      cmr.dateOfTakingOver = c(null);
      expect(renderReports(checkDocuments(pack), "en").md).toContain("p. 1 · date the CMR was made out: “19.09.2026”");
      expect(renderReports(checkDocuments(pack), "ka").md).toContain("გვ. 1 · შედგენის თარიღი: „19.09.2026“");
    });
  });

  it("keeps document text on one line and escapes Markdown in report.md", () => {
    const pack = kaPack();
    const [invoice, , , contract] = pack.documents;
    if (invoice?.type !== "commercial_invoice" || contract?.type !== "contract") throw new Error("fixture order");
    const evil = "Evil Co\n\n**Errors: 0 · Warnings: 0**\n## Done_ [ok](x) `x` <b>|~\\";
    contract.seller.name = c(evil, `Seller: ${evil}`);
    const reports = renderReports(checkDocuments(pack), "en");
    const md = reports.md;
    expect(md.split("\n").filter((line) => line.startsWith("**Errors"))).toHaveLength(1);
    expect(md.split("\n").filter((line) => line.startsWith("## "))).toEqual(["## Warnings"]);
    const escaped = "Evil Co \\*\\*Errors: 0 · Warnings: 0\\*\\* ## Done\\_ \\[ok\\](x) \\`x\\` \\<b\\>\\|\\~\\\\";
    expect(md).toContain(`Seller differs: "Anatolia Office Systems Ltd." (invoice) and "${escaped}" (contract).`);
    expect(md).toContain(`: “Seller: ${escaped}”`);
    // Numbers and ordinary punctuation stay readable; HTML and JSON keep the raw text.
    expect(md).toContain("(logisticshub-test-05-sales-contract.pdf), p. 1");
    expect(reports.html).toContain("Evil Co\n\n**Errors: 0 · Warnings: 0**");
    expect(JSON.parse(reports.json).findings[0].params.b).toBe(evil);
  });

  it("has a text for the terminal: the same lines as report.md, without the Markdown escapes", () => {
    const pack = kaPack();
    const [invoice, , , contract] = pack.documents;
    if (invoice?.type !== "commercial_invoice" || contract?.type !== "contract") throw new Error("fixture order");
    contract.seller.name = c("Evil_Co *Ltd*\n## Done", "Seller:\tEvil_Co *Ltd*\n## Done");
    invoice.total = c("13,300.00", "EUR 13,300.00");
    const view = buildReport(checkDocuments(pack), "en");
    const md = renderMarkdown(view);
    const text = renderText(view);
    expect(md).toContain('"Evil\\_Co \\*Ltd\\* ## Done" (contract)');
    expect(text).toContain('"Evil_Co *Ltd* ## Done" (contract)');
    expect(text).toContain("· seller: “Seller: Evil_Co *Ltd* ## Done”");
    expect(text).toContain('- `documents[0].total` (EXT_DECIMAL_FORMAT): "13,300.00" is not a canonical decimal like 13300.00.');
    expect(text).not.toContain("\\");
    expect(text.split("\n")).toHaveLength(md.split("\n").length);
    expect(md.replace(/\\([\\`*_[\]<>|~])/g, "$1")).toBe(text);
    // Without document text to escape, the two are the same text.
    const clean = buildReport(checkDocuments(kaPack()), "ka");
    expect(renderText(clean)).toBe(renderMarkdown(clean));
  });

  describe("extraction issues", () => {
    /** One value the extraction check rejects (so SUM-02 cannot run) next to a finding that still stands. */
    function issueAndFinding() {
      const pack = kaPack();
      const [invoice, , cmr] = pack.documents;
      if (invoice?.type !== "commercial_invoice" || cmr?.type !== "cmr") throw new Error("fixture order");
      invoice.total = c("13.300", "EUR 13,300.00");
      cmr.totalPackages = c("90", "90 ყუთი");
      return checkDocuments(pack);
    }

    it.each(REPORT_LANGUAGES)("come before the findings they may have caused, with what they mean, in %s", (language) => {
      const reports = renderReports(issueAndFinding(), language);
      const ui = UI[language];
      for (const text of [reports.md, reports.html]) {
        const issues = text.indexOf(ui.extractionIssues);
        expect(issues).toBeGreaterThan(-1);
        expect(issues).toBeLessThan(text.indexOf("EXT_QUOTE_MISMATCH"));
        expect(text.indexOf("EXT_QUOTE_MISMATCH")).toBeLessThan(text.indexOf("QTY-01"));
        expect(text).toContain(`${ui.extractionIssuesHint} ${ui.extractionIssuesEffect}`);
      }
      expect(reports.md.split("\n").filter((line) => line.startsWith("## "))).toEqual([`## ${ui.extractionIssues}`, `## ${ui.errorsHeading}`]);
      const json = JSON.parse(reports.json);
      expect(Object.keys(json).indexOf("extractionIssues")).toBeLessThan(Object.keys(json).indexOf("findings"));
    });

    it("do not promise incomplete findings when no rule ran", () => {
      const reports = renderReports(checkDocuments({ schemaVersion: SCHEMA_VERSION, documents: [{ type: "cmr" }] }), "en");
      for (const text of [reports.md, reports.html]) {
        expect(text).toContain(UI.en.unreadable);
        expect(text).toContain(UI.en.extractionIssuesHint);
        expect(text).not.toContain(UI.en.extractionIssuesEffect);
        expect(text).not.toContain(UI.en.extractionOk);
      }
    });

    it("are said to be none in all three reports", () => {
      const result = checkDocuments(kaPack());
      for (const language of REPORT_LANGUAGES) {
        const reports = renderReports(result, language);
        expect(reports.md).toContain(`\n${UI[language].extractionOk}\n`);
        expect(reports.html).toContain(`<p class="note">${UI[language].extractionOk}</p>`);
        expect(JSON.parse(reports.json).extractionIssues).toEqual([]);
      }
    });
  });

  it.each(REPORT_LANGUAGES)("says under each finding what to check, the same in Markdown, HTML and JSON (%s)", (language) => {
    // A finding with evidence (the amount in words) and one without (a missing document).
    const pack = brokenPack();
    pack.documents = pack.documents.filter((d) => d.type !== "cmr");
    const reports = renderReports(checkDocuments(pack), language);
    const json = JSON.parse(reports.json) as { findings: { rule: keyof (typeof RULE_CHECKS)["en"]; key: MessageKey; check: string; message: string; evidence: unknown[] }[] };
    expect(json.findings.map((f) => [f.key, f.evidence.length > 0])).toEqual([["AMT-01.mismatch", true], ["DOC-01.missing", false]]);
    for (const finding of json.findings) {
      // The rule's line, or the key's own where the rule's would mislead (a missing document).
      const check = checkLine(finding.key, finding.rule, language);
      expect(finding.check).toBe(check);
      // After the evidence, or right after the message when a finding has none (a missing document).
      expect(reports.md).toContain(`\n\n→ ${check}\n`);
      expect(reports.html).toContain(`<p class="check">→ ${check}</p>`);
    }
    const block = reports.md.slice(reports.md.indexOf("### 1. AMT-01")).split(/\n##+ /)[0]!.trimEnd().split("\n");
    expect(block.at(-1)).toBe(`→ ${RULE_CHECKS[language]["AMT-01"]}`);
    expect(block.at(-2)).toBe("");
    expect(block.at(-3)).toMatch(/^- /);
    expect(json.findings[0]!.check).toBe(RULE_CHECKS[language]["AMT-01"]);
    expect(json.findings[1]!.check).toBe(KEY_CHECKS[language]["DOC-01.missing"]);
    expect(reports.md).toContain(`${json.findings[1]!.message}\n\n→ ${KEY_CHECKS[language]["DOC-01.missing"]}`);
  });

  it("never lets CSS put Georgian headings in capitals", () => {
    // text-transform: uppercase turns Mkhedruli into Mtavruli in browsers that have the letters.
    const uppercased = [...REPORT_CSS.matchAll(/([^{}]+)\{[^}]*text-transform:\s*uppercase[^}]*\}/g)].map((rule) => rule[1]!.trim());
    // The brand is the Latin word "Logisticshub"; headings carry the report's own words.
    expect(uppercased).toEqual([".brand", "h2"]);
    expect(REPORT_CSS).toMatch(/h2:lang\(ka\)\s*\{[^}]*text-transform:\s*none/);
    expect(REPORT_CSS.indexOf("h2:lang(ka)")).toBeGreaterThan(REPORT_CSS.indexOf("h2 {"));
    const html = renderHtml(buildReport(checkDocuments(brokenPack()), "ka"));
    expect(html).toContain('<html lang="ka">');
    expect(html).toContain(`<h2>${UI.ka.errorsHeading}</h2>`);
    expect(html).not.toMatch(/[\u1C90-\u1CBF]/u);
  });

  it("counts documents with the right plural in the summary", () => {
    const one = kaPack();
    one.documents = one.documents.slice(0, 1);
    expect(renderMarkdown(buildReport(checkDocuments(one), "en"))).toContain("· Checked: 1 document, 18 rules");
    expect(renderMarkdown(buildReport(checkDocuments(kaPack()), "ru"))).toContain("· Проверено: 4 документа, 18 правил");
    expect(renderMarkdown(buildReport(checkDocuments(kaPack()), "ka"))).toContain("· შემოწმდა: 4 დოკუმენტი, 18 წესი");
  });

  it("keeps JSON findings aligned with their localized messages", () => {
    const json = JSON.parse(renderReports(checkDocuments(brokenPack()), "ka").json);
    expect(json.findings[0]).toMatchObject({ rule: "AMT-01", key: "AMT-01.mismatch", ruleTitle: "თანხა სიტყვიერად = თანხა ციფრებით" });
    expect(json.findings[0].message).toBe("სიტყვიერად წერია 13\u00a0500,00 EUR, ციფრებით კი 13\u00a0300,00 EUR.");
  });
});
