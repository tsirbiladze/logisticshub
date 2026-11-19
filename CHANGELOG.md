# Changelog

## Unreleased

- WGT-02 and the package counts of QTY-01 compare every two documents, not each document with the first one. Gross weights of 1,000.0, 1,000.5 and 999.5 kg on the packing list, the CMR and the invoice gave no finding, although the last two are 1.0 kg apart; they are now reported. The 0.5 kg tolerance is unchanged, and so is the result for whole package counts.
- The Turkish demo pack's seller is now "Erguvan Seramik Sanayi ve Ticaret A.Ş.", an invented name. The name it had is that of a real company, and the demo packs are meant to hold fictional companies only. The five `tr-ceramics` sets were regenerated: their PDFs and `extraction.json`; the expected findings are the same.

## 1.0.0 — 2026-11-17

First release.

- 16 deterministic rules across the commercial invoice, packing list, CMR and sales contract of one shipment: amounts and totals, the amount in words (English, Georgian, Russian, Turkish), quantities, packages, weights, references, dates, parties, Incoterms 2020 and CMR Art. 6(1). One invoice can be checked on its own: its line totals, its sums and its amount in words.
- The checker checks the extraction before it trusts it. A value that is not what its own quote says is listed as an extraction issue and kept out of every rule, so a misread number, date or currency does not turn into findings.
- Every finding cites the verbatim quote, the page and the field, and ends with a line that says what to verify. Reports in Markdown, HTML and JSON, in English, Georgian, Russian or Turkish.
- Each PDF with a finding comes back as a copy with the evidence boxed and numbered. Every quote is looked up on its PDF page, and what is not found is listed under `Notes:` with the reason. Where a copy cannot be tied to a field, every copy is boxed and a note says so.
- Agent skill with a single-file Node.js checker, and a Python port for claude.ai that gives byte-identical reports and does not read the PDFs.
- `logisticshub` npm package: a CLI that reads the documents with a model you choose (Anthropic, OpenAI, OpenRouter) and your own API key, and an MCP server with two tools, the extraction guide and the check.
- 29 demo sets of synthetic documents in four languages, each with the findings it must give.
