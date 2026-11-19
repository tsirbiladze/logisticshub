# Changelog

## Unreleased

- WGT-02 and the package counts of QTY-01 compare every two documents, not each document with the first one. Gross weights of 1,000.0, 1,000.5 and 999.5 kg on the packing list, the CMR and the invoice gave no finding, although the last two are 1.0 kg apart; they are now reported. The 0.5 kg tolerance is unchanged, and so is the result for whole package counts.
- Added HS-01 for invoice codes involving Georgia dated from 2024-01-26, and offline lookup by code, prefix or Georgian description in the CLI, MCP server and both skill scripts. The data is the original annex to Georgian Order No. 21 (Matsne 6086072, publication 0). Later amendments were not verified.
- Extraction schema 3 adds party identification numbers and the optional Georgian goods declaration. PTY-02 compares printed tax or registration numbers. TAX-01, TAX-02 and TAX-03 use a saved Revenue Service taxpayer snapshot for names, VAT status and the status −1 reply. The opt-in registry client was tested with a local stub and synthetic snapshots.
- Six declaration rules compare parties, HS prefixes, shipment weights, package counts, invoice value and origin. They also check declared national codes and add up item invoice values. DATE-01 and REF-01 check the declaration registration date and the invoice reference in box 44. Declaration PDFs support quoted evidence and marked copies.
- The CLI and both skill scripts can convert saved assessed declarations with `declaration-from-rs`, preserving the JSON numeric digits and citing the response file. The converter was tested with synthetic responses based on the published protocol. It has never been run against the live declaration service. Logging in and fetching declarations are outside the tool.
- 45 synthetic variants across four languages with byte-identical Node and Python reports, including nine declaration variants and a clean set built from the saved-response converter.

## 1.0.0 — 2026-11-17

First release.

- 16 deterministic rules across the commercial invoice, packing list, CMR and sales contract of one shipment: amounts and totals, the amount in words (English, Georgian, Russian, Turkish), quantities, packages, weights, references, dates, parties, Incoterms 2020 and CMR Art. 6(1). One invoice can be checked on its own: its line totals, its sums and its amount in words.
- The checker checks the extraction before it trusts it. A value that is not what its own quote says is listed as an extraction issue and kept out of every rule, so a misread number, date or currency does not turn into findings.
- Every finding cites the verbatim quote, the page and the field, and ends with a line that says what to verify. Reports in Markdown, HTML and JSON, in English, Georgian, Russian or Turkish.
- Each PDF with a finding comes back as a copy with the evidence boxed and numbered. Every quote is looked up on its PDF page, and what is not found is listed under `Notes:` with the reason. Where a copy cannot be tied to a field, every copy is boxed and a note says so.
- Agent skill with a single-file Node.js checker, and a Python port for claude.ai that gives byte-identical reports and does not read the PDFs.
- `logisticshub` npm package: a CLI that reads the documents with a model you choose (Anthropic, OpenAI, OpenRouter) and your own API key, and an MCP server with two tools, the extraction guide and the check.
- 29 demo sets of synthetic documents in four languages, each with the findings it must give.
