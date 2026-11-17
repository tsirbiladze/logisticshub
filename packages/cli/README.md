# logisticshub

Cross-check the trade documents of one shipment (commercial invoice, packing list, CMR, sales contract) with AI extraction and 16 deterministic rules. One invoice can be checked on its own too: its line totals, its sums and its amount in words. Every finding comes with the document, the page, the field and the exact quote, and is marked on a copy of the PDF.

```bash
# read the documents with a model, then check them (Claude by default)
ANTHROPIC_API_KEY=… npx logisticshub check ./docs --lang en

# check an extraction you already have: no model, no key
npx logisticshub check ./logisticshub-report/extraction.json --pdf-dir ./docs

# MCP server (stdio)
npx -y logisticshub mcp

# every option
npx logisticshub --help
```

## Inputs

- **Document files**: `.pdf`, `.png`, `.jpg`, `.jpeg` and `.webp` files, or a folder of them (not its subfolders, and not the `<name>.marked.pdf` copies an earlier run left there). One document per file, the documents of one shipment per run. Two files may not share a name.
- **Or one `extraction.json`**: the file an earlier run wrote into `--out`, corrected by hand if needed, or one your own agent wrote. `logisticshub schema` prints its JSON Schema.

## Options

| Option | Default | What |
|---|---|---|
| `--lang <en\|ka\|ru\|tr>` | the language of most documents, else `en` | report language |
| `--out <dir>` | `./logisticshub-report` | folder for the reports, `extraction.json` and the marked PDFs |
| `--model <provider:id>` | `anthropic:claude-opus-5-5` | the model that reads the documents; also `openai:<id>` and `openrouter:<id>`. The environment variable `LOGISTICSHUB_MODEL` sets it too |
| `--pdf-dir <dir>` | the `extraction.json`'s folder | with an `extraction.json`: the folder of the PDFs it cites |
| `--format <md,json,html>` | all three | report formats to write |
| `--no-annotate` | | do not read the PDFs after the extraction: no marked copies, no quote looked up |
| `-h`, `--help` | | the help, also after `check` |
| `-v`, `--version` | | the version |

Keys: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `OPENROUTER_API_KEY`, for the provider of `--model`. Checking an `extraction.json` needs none.

## Output

On stdout: the report (the text of `report.md`, with document text as printed, not escaped for Markdown), then `Files:` with what was written, then `Notes:` when the PDFs showed something. Progress and errors go to stderr.

In `--out`:

- `report.md`, `report.html`, `report.json`;
- `extraction.json`, when a model read the documents;
- `<name>.marked.pdf` for each PDF that has a finding, with the findings boxed and numbered. A run without findings writes none;
- `extraction.rejected.json`, when a document still broke the schema after its correction call.

`Notes:` never change the exit code. `<file>` is a document file, as the extraction names it:

| Note | What to do |
|---|---|
| `<file>: page 7 does not exist (1 page): <paths>` | correct `page` of those fields in `extraction.json`, and run `logisticshub check extraction.json --pdf-dir <folder>` |
| `<file>: page 1: N quotes not found in the page text: <path> "<quote>"; …` | the quote is not printed on that page as extracted. Compare the field with the PDF and correct it the same way |
| `<file>: N of M marks not located: quote not found on page 1` | the same, for the evidence of a finding: correcting the quote brings the box back |
| `<file>: not marked: file not found`, `<file>: quotes not checked: file not found` | the PDF is not where the check looks: give `--pdf-dir`, or make `sourceFile` the file's real name |
| `<file>: page 1 has no text, likely a scan: N quotes not checked`, with `<file>: N of M marks not located: page 1 has no text, likely a scan; no marked copy` when a finding cites the file | nothing to fix: a scan cannot be marked and its quotes cannot be looked up. Check its numbers by eye |
| `<file>: an image: N quotes not checked`, or `<file>: an image: not marked, N quotes not checked` when a finding cites the file; `not a PDF` in place of `an image` for any other format | the same as for a scan |
| `<file>: not marked: <reason>` or `<file>: quotes not checked: <reason>`, the reason being `the PDF is encrypted`, `the PDF cannot be read: it is damaged or not a PDF` or `the file cannot be read: permission denied (EACCES)` | the report is complete, but this file's quotes were not looked up and it has no marked copy. Run again when the file can be opened |
| `<file>: page 1: "<quote>" is printed N times and finding K could not be tied to one of them; all N are boxed` | every copy is boxed. The sentence of finding K says which amount is meant |
| `marked PDFs skipped: marking needs Node.js 22 or newer (this is v20.…)`, `quotes not checked in the PDFs: …` | Node.js is older than 22: the reports are complete, no quote was looked up and no PDF was marked |

## How the model is used

Each file gets two model calls: one to say what kind of document it is, one to extract it. The model is given the skill's extraction guide, without the two sections only an agent can act on, and the JSON Schema of that kind of document, and it answers with the document as JSON. Its answer is then checked: the format of every value, each value against its own quote, and every quote against the text of its PDF page. If anything is wrong, the model gets one more call with the list and what each issue code in it means, and its correction is kept unless it leaves more to correct than before. At most 4 calls run at a time.

This path is tested with a stand-in model. Version 1.0.0 was also run once against a real model, on 2026-11-17: `claude-opus-5-5` read three demo sets (`en-led-lighting/two-page-invoice`, `ka-office-furniture/scanned-cmr`, `tr-ceramics/clean`), and each gave exactly its planted findings, with no extraction issue and no correction call. That run called the code behind `check` and signed in with an Anthropic account; the `logisticshub` command with `ANTHROPIC_API_KEY`, every other model and every document that is not a demo are still untried.

A file whose model call fails, or whose extraction still breaks the schema, is left out; the other files are still checked. The report names the file, and the exit code is `1`.

## Exit codes

- `0`: checked, with or without findings. The report may still open with extraction issues: read them first.
- `1`: not checked in full, and the reports say why: the extraction is not usable (a missing key, a wrong type, another schema version), or a file was left out.
- `2`: nothing was checked. One line on stderr says why: a bad option, a missing key, an input that cannot be read or is not JSON, no document the model could read, or an output folder that cannot be written.

## MCP server

`logisticshub mcp` serves two tools over stdio, for an agent that reads the documents itself:

- `get_extraction_guide`: how to build the extraction, with the JSON Schema and a blank of every document type to copy.
- `check_documents`: checks an extraction. Arguments: `extraction`, the object itself (a string of JSON that holds it is read too); `language` (`en`, `ka`, `ru`, `tr`); `pdfDir`, an absolute path, to look every quote up in the PDFs; `outDir`, an absolute path, to write the reports. With both, each PDF that has a finding gets a marked copy in `outDir`. Without `outDir` nothing is written and the report is returned inline.

The result carries the report as text, as `check` prints it, and a structured copy: `ok`, `language`, `summary`, `extractionIssues`, `findings` (each with its message, what to check, the currency of its amounts, and its evidence with the name of each field), `files` and `notes`. When the result lists an extraction issue or a note, a second text follows the report: what each issue code and each note means, and what to do. A relative path, an `extraction` that is neither the object nor JSON, and an `outDir` that cannot be written each come back as an error that says what to give instead.

## Limits

- One document per file. A file that holds two documents, or one document spread over several image files, is not put together; an agent with the skill can do both.
- The model does not report where it had to choose between two readings. Where the extraction guide leaves a reading open, it is told to leave the fact empty.
- Page images are read, never marked, and their quotes are not looked up. The same holds for a scanned page inside a PDF.
- The documents go to the model provider you choose, with your key. Logisticshub itself has no server.
- What the rules do not check: [Limits](https://github.com/tsirbiladze/logisticshub#limits).

Requires Node.js 22+. Bundled third-party packages and their licenses: `dist/THIRD-PARTY-NOTICES.txt`.

Also available as an Agent Skill for Claude Code, Codex, Cursor and other agents: `npx skills@latest add tsirbiladze/logisticshub`. Docs: https://tsirbiladze.com/skills/logisticshub · Source: https://github.com/tsirbiladze/logisticshub · MIT
