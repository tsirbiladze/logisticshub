# After the check: extraction issues and notes

Open this when the report lists `Extraction issues` or the script prints `Notes:`. Correct `extraction.json` against the document: change a value or a quote only to what the document prints, never just to make a line go away.

## Extraction issues

Each line gives a field path, a code and what is wrong: `documents[1].lines[1].quantity (EXT_QUOTE_MISMATCH): …`. Paths count from 0: `documents[1].lines[1]` is the second line of the second document. A value with a format, quote-mismatch or percentage issue is kept out of every rule until it is fixed, so findings can be missing.

| Code | Means | Fix |
|---|---|---|
| `EXT_SHAPE` | a key is missing or has the wrong type, or `schemaVersion` is not `"2"`; no rule ran, exit code 1 | write what the message says at that path |
| `EXT_DECIMAL_FORMAT` | a number that is not canonical (`13,300.00`, `1 880`, `15%`) | `13300.00` |
| `EXT_DATE_FORMAT` | a date that is not a real `YYYY-MM-DD` | `2026-09-18` |
| `EXT_CURRENCY_FORMAT` | a currency that is not a three-letter code (`€`, `usd`) | `EUR` |
| `EXT_QUOTE_MISMATCH` | the value is not what its own quote reads; the message gives the reading (table below) | read the quote in the document again; correct the value, or the quote if you cited the wrong text |
| `EXT_PERCENTAGE` | a rate (`5%`, `%18`) where an amount belongs | the printed amount, or null when only the rate is printed |
| `EXT_UNCITED` | a value without a quote | add the quote and page, or make the fact null |
| `EXT_PAGE` | a page below 1 | the page number counted from 1 |
| `EXT_DUPLICATE_ID` | two documents with one `id` | `invoice`, `invoice-2` |

What an `EXT_QUOTE_MISMATCH` message says:

| The message ends | What was read | Usual cause |
|---|---|---|
| `…the quote "1,880 kg", which reads 1880 or 1.880.` | no number in the quote gives the value | a mistyped digit, or the quote of another field |
| `…this document writes decimals with "." (as in "2.4"), so the quote reads 1.500.` | the value takes the other decimal sign than the document's own numbers show | thousands read as decimals, or the reverse |
| `…the quote "05/10/2026", which reads 2026-10-05 or 2026-05-10.` | no reading of the date gives the value | a mistyped day, month or year |
| `…this document writes the day before the month (as in "18.09.2026"), so the quote reads 2026-10-05.` | day and month are swapped against the document's other dates | month-first reading of a day-first document, or the reverse |
| `…the quote "14 Oct 2026", which reads 2026-10-14.` | the month name, read in the document's `language` or in English, is another month, or the day or year differs | a misread month name |
| `…an amount printed in brackets or with a minus is negative, so the quote reads -500.00.` | `freight`, `insurance`, `tax` or an `otherCharges` entry is printed `(500.00)` or `-500.00` and given as a positive amount | the sign was dropped: write `-500.00` |
| `…the quote "USD 15,500.00", which names USD.` | the quote of a `currency` is a code or sign of another currency than the value | the wrong code, or the quote of another document |

The check speaks only where the quote can be read beyond doubt (`rules.md`, "Before the rules"), so a value without an issue is not proven right.

**One issue is not yours to fix: a document that really prints numbers in both conventions** (`2.4` kg and `1.500` for 1500 pieces). The message then names the number that shows the document's convention (`as in "2.4"`). Look at both numbers in the document once more. When your value is what the document means, keep it: changing it to the reading in the message would make a false finding. The issue stays in the report and takes no correction round. Tell the user which document prints numbers in two ways, with both quotes; which value you read; and that the checker left this field out of its rules, so that number was compared with nothing and is theirs to check by hand.

## Notes

`Notes:` follow `Files:`. They come from reading the PDFs, so `check.py` prints none, and they never change the exit code. `<file>` is a `sourceFile`.

| Note | Do |
|---|---|
| `<file>: page 7 does not exist (1 page): <paths>` | correct `page` of those fields |
| `<file>: page 1: N quotes not found in the page text: <path> "<quote>"; …` | the quote is not verbatim or cites the wrong page: correct it |
| `<file>: N of M marks not located: quote not found on page 1` | the same, for the evidence of a finding: correcting the quote brings the box back |
| `<file>: not marked: file not found`, `<file>: quotes not checked: file not found` | make `sourceFile` the file's real name, or pass `--pdf-dir` |
| `<file>: page 1 has no text, likely a scan: N quotes not checked`, with `<file>: N of M marks not located: page 1 has no text, likely a scan; no marked copy` when a finding cites the file | nothing to correct. Read the numbers of that file on a 300 dpi picture once more, and tell the user that its quotes were not looked up and that it has no marked copy |
| `<file>: an image: N quotes not checked`, or `<file>: an image: not marked, N quotes not checked` when a finding cites the file; `not a PDF` in place of `an image` for any other format | the same as for a scan |
| `<file>: not marked: <reason>` or `<file>: quotes not checked: <reason>`, the reason being `the PDF is encrypted`, `the PDF cannot be read: it is damaged or not a PDF` or `the file cannot be read: permission denied (EACCES)` | the report is complete, but this file's quotes were not looked up and it has no marked copy: tell the user. Run again when the file can be opened |
| `<file>: page 1: "<quote>" is printed N times and finding K could not be tied to one of them; all N are boxed` | tell the user which of the boxes finding K means |
| `marked PDFs skipped: marking needs Node.js 22 or newer (this is v20.…)`, `quotes not checked in the PDFs: …` | Node.js is older than 22: the reports are complete, no quote was looked up and no PDF was marked. Tell the user |
