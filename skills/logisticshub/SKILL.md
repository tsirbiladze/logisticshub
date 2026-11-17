---
name: logisticshub
description: Cross-check a shipment's export or customs documents (invoice, packing list, CMR, contract), or one invoice's sums and amount in words. English, Georgian, Russian, Turkish. Not for paying or booking.
license: MIT
metadata:
  version: "1.0.0"
  homepage: "https://tsirbiladze.com/skills/logisticshub"
---

# Logisticshub: trade document cross-check

You read the documents; `scripts/check.mjs` (in this skill's directory) applies 16 deterministic rules to your extraction and writes the report. The rules see only what you extract, so record what is **printed**, quoted **verbatim**, and nothing you worked out yourself.

## 1. Collect the set

One run checks one shipment. List every file the user provided and give each document a type: `commercial_invoice`, `packing_list`, `cmr`, `contract`, or `other` (insurance policy, freight statement, specification…). Read every page of every file.

- Inputs are PDFs and page images (JPG, PNG). Read a text PDF from its text; read a scan or an image from the picture.
- Files of several shipments: group them by the document numbers they cite, and do steps 2 to 4 once per shipment, each with its own extraction file and `--out` folder.
- A single document is a set too: an invoice on its own gets its line totals, its sums and its amount in words checked.

Done when every document has a type, every page has been read, and every document in the run belongs to one shipment.

## 2. Extract

Read `references/extraction.md` in full before the first field: it decides every hard case (decimal signs, dates, what a quote covers, tables over several pages, scans, each field of each document). Then write `extraction.json` in the folder of the user's documents. Copy each document's keys from `references/extraction-blank.json`; the JSON Schema is `references/extraction-schema.json`.

The rules that keep the check honest:

- Every fact is `{ "value": …, "quote": …, "page": … }`. `quote` is the text exactly as printed: same digits, separators, spelling and script. `value` is its normal form: a canonical decimal (`13,300.00` → `"13300.00"`), a date as `YYYY-MM-DD`, an ISO currency code.
- Record only what is printed. A fact the document does not print is `{ "value": null, "quote": null, "page": null }`; the script computes every sum and comparison itself.
- A character you cannot read for certain makes the fact null. Keep a list of these fields for step 4, and of every number or date whose reading you had to choose.

Done when every field of every document holds a printed value with its verbatim quote and page, or null, and no value is a sum, a conversion or a guess.

## 3. Check

```bash
node <this-skill-dir>/scripts/check.mjs extraction.json --lang <en|ka|ru|tr> --out <report-dir>
```

- `--lang`: the user's language when it is one of the four; otherwise `en`, and you translate in step 4.
- The script prints the report, then `Files:` and, when there is something to say, `Notes:`. It writes `report.md`, `report.json` and `report.html` into `--out` (default: next to `extraction.json`).
- Each PDF that has a finding gets a copy with the findings boxed and numbered, `<name>.marked.pdf`. A PDF without findings gets none, so a clean run writes no marked PDF. PDFs are looked up next to `extraction.json`, or in `--pdf-dir`. Images are never marked.
- It needs no install. Reading the PDFs needs Node.js 22 or newer; on an older one the reports are still written. Where `node` is unavailable (claude.ai, the Claude API), run `python3 <this-skill-dir>/scripts/check.py` with the same arguments: the same reports, but the PDFs are not read, so there are no marked copies and no `Notes:`.

Exit codes:

- `0`: checked. The report may still list extraction issues.
- `1`: the extraction has the wrong shape (a missing key, a wrong type, another schema version), so no rule ran. The reports list each path and what to write there.
- `2`: nothing was checked and no report was written. One line on stderr says why: a bad option, an `extraction.json` that cannot be read or is not valid JSON (with line and column), or an `--out` folder that cannot be written.

Read the output in this order:

1. **Extraction issues**: the section right under the counts, headed in the report's language, and `extractionIssues` in `report.json`. Each line names a field path, a code (`EXT_…`) and what is wrong. A value with an issue is left out of the rules, so findings can be missing until it is fixed.
2. **`Notes:`**, after `Files:`: what reading the PDFs showed. A page that does not exist, a quote not found in the page text and a file not found ask for a correction; every other note is for the user. Notes never change the exit code.

When either is there, open `references/issues.md`: it says what each code and each note means, what to do, and which one is not yours to fix. Correct `extraction.json` against the documents and run the check again, at most twice. What is still listed then goes to the user in step 4. A run with no issue and no `Notes:` goes straight to step 4.

Done when no issue and no note is left that asks for a correction, or after two correction rounds.

## 4. Report

Answer in the user's language; when it is not one of the four, translate the report yourself. Give:

- the counts of errors and warnings, and the documents checked;
- every finding: its message, each piece of evidence (document, page, field and quote), and its `→` line, which says what to verify;
- the paths of `report.html` (opens in any browser) and of each `.marked.pdf` that was written;
- what limits the result: extraction issues left after the correction rounds, notes for the user, every fact you left null because you could not read it, and every number or date whose reading you had to choose.

Present findings as discrepancies to verify against the originals, not as verdicts. With no findings and no issues, say the documents agree on the 16 rules. When the user gave fewer documents on purpose (one invoice), a `DOC-01` warning that the packing list or the CMR is missing is expected: say what was checked and that the rules which compare documents had nothing to compare.

A discrepancy you noticed while reading that no rule reports (`references/rules.md`, "Not checked") goes under its own heading after the findings, "Seen while reading, not checked by a rule", with its quotes and pages. Keep it out of the checker's findings and counts.

Done when the user has every finding with its evidence, the file paths and every limit above, and nothing in your answer differs from the report.

To explain a rule or answer what the skill checks and does not check, read `references/rules.md`.
