/**
 * The extraction guide: how to fill extraction.json. Single source for the
 * skill (references/extraction.md is generated from it), the CLI's model
 * prompt and the MCP server.
 */
import { SCHEMA_VERSION } from "./schema.ts";

export const EXTRACTION_GUIDE = `# Extraction guide

How to write \`extraction.json\` for \`scripts/check.mjs\`. Record what each document **prints**; the checker does every sum and comparison itself. \`extraction-schema.json\` is the contract, and \`extraction-blank.json\` holds every document type and table line with all facts null, ready to copy.

## File

\`\`\`json
{ "schemaVersion": "${SCHEMA_VERSION}", "documents": [ {
  "type": "commercial_invoice", "id": "invoice", "sourceFile": "invoice.pdf", "language": "ka",
  "number": { "value": "AOS-INV-2026-0918-01", "quote": "AOS-INV-2026-0918-01", "page": 1 },
  "date": { "value": "2026-09-18", "quote": "18.09.2026", "page": 1 },
  "consignee": { "name": { "value": null, "quote": null, "page": null }, … },
  "lines": [ … ], …
} ] }
\`\`\`

- \`documents\`: one entry per document (not per file), the documents of one shipment.
- \`type\`: \`commercial_invoice\`, \`packing_list\`, \`cmr\`, \`contract\`, or \`other\` for anything else.
- \`id\`: \`invoice\`, \`packing-list\`, \`cmr\`, \`contract\`; for \`other\` a short name of your own (\`insurance-policy\`). A second document of a type gets \`-2\` (\`invoice-2\`). Ids are unique.
- \`sourceFile\`: the file's name as it is on disk, without folders.
- \`language\`: the main language of the document's text: \`en\`, \`ru\`, \`tr\`, \`ka\` or \`other\`. An amount in words is read in it, and a month name in a date is checked in it or in English (with \`other\`, not at all).
- Every key of the schema is present. A fact the document does not print is \`{ "value": null, "quote": null, "page": null }\`, and a list with nothing printed is \`[]\`.

## A fact: value, quote, page

- \`quote\`: the printed text, copied character for character: same digits, separators, spelling and script.
- \`value\`: the quote in normal form (table below). Never a sum, a conversion or a guess of yours.
- \`page\`: the page of \`sourceFile\` the quote is printed on, counted from 1.

| Kind | \`value\` | \`quote\` → \`value\` |
|---|---|---|
| decimal | digits, optional \`-\` in front, optional \`.\` and digits | \`EUR 13,300.00\` → \`13300.00\`; \`9.684,00\` → \`9684.00\`; \`1,880 kg\` → \`1880\` |
| date | \`YYYY-MM-DD\` | \`18.09.2026\` → \`2026-09-18\`; \`14 Oct 2026\` → \`2026-10-14\` |
| currency | ISO 4217 code | \`€\` → \`EUR\`; \`$\`, \`US dollars\` → \`USD\`; \`ლარი\` → \`GEL\`; \`TL\` → \`TRY\`; \`руб.\` → \`RUB\` |
| text | the quote itself, on one line | names, addresses, document numbers, descriptions, each entry of \`attachedDocuments\` |
| amount in words | the whole phrase, as printed | \`ცამეტი ათას სამასი ევრო და ნული ცენტი\` |

## Numbers

- **The decimal sign is the document's own.** One number settles it for the whole document: one that shows both signs (\`9.684,00\`, \`13,300.00\`), or one whose only sign is followed by anything but three digits (\`13,2\`, \`4,80\`, \`9.0619\`). Next to \`9.684,00\` or \`13,2\` the comma is the decimal sign, so \`16.560 kg\` is \`16560\` and \`1.080\` is \`1080\`; next to \`13,300.00\` or \`9.0619\` it is the point, so \`1,880 kg\` is \`1880\`.
- **No number in the document settles it** (only whole numbers and \`1.880\`): take the sign from the same issuer's other documents in the set. Failing that, three digits after a single separator are thousands (\`1.880\` → \`1880\`); tell the user which numbers you read this way.
- Spaces and apostrophes only group thousands: \`13 300,00\` and \`13'300.00\` are \`13300.00\`.
- Keep the printed decimals: \`145.00\` stays \`145.00\`, \`1,880\` becomes \`1880\`, never \`1880.00\`.
- An amount printed in brackets or with a minus is negative: \`(500.00)\` → \`-500.00\`.
- A percentage (\`5%\`, \`%18\`) goes into \`discountPercent\` and nowhere else. Every other decimal field takes the printed amount, or null when only a rate is printed.
- **A document that prints both conventions**: when its own lines and totals show that one number breaks its convention (\`1.500\` pcs beside volumes like \`2.4\`, in a column that adds up to \`2,500\`), give that number the value the document means, \`1500\`. The checker lists it as \`EXT_QUOTE_MISMATCH\` and leaves it out of the rules; keep your value and tell the user (\`issues.md\` says what).

## Dates

- Day first is the rule in ka, ru and tr documents and in most others: \`05.10.2026\` → \`2026-10-05\`. Read the month first only when a date in the same document shows it (\`10/25/2026\`) or, when the document has no such date, a date in the same issuer's other documents in the set does; if none shows the order and the issuer is American, read the month first and tell the user.
- Two-digit years are 20xx: \`18.09.26\` → \`2026-09-18\`. A date printed year first stays as it is: \`2026-09-18\`.
- Month names. Georgian and Russian use the international names (იანვარი … დეკემბერი, январь … декабрь) in case forms (\`5 ოქტომბერს\`, \`5 ოქტომბრის\`, \`5 октября\`): the stem names the month. Turkish, 1 to 12: Ocak, Şubat, Mart, Nisan, Mayıs, Haziran, Temmuz, Ağustos, Eylül, Ekim, Kasım, Aralık.
- Quote the date alone, with the words that belong to it: \`5 октября 2026 г.\`, \`14 Ekim 2026\`.

## Quotes

- **What a quote covers**: the text of its own field and nothing of another field. A unit or packing word printed next to a number stays in the quote only when it has no field of its own there; an amount of money keeps the currency printed with it:

  | Printed | Fields |
  |---|---|
  | \`400 pcs\` on an invoice or packing-list line | \`quantity\` → quote \`400\`; \`unit\` → quote \`pcs\` |
  | \`48 cartons\` on a packing-list line or a CMR goods line | \`packages\` → quote \`48\`; \`packingMethod\` → quote \`cartons\` |
  | \`Packages: 82 cartons\` on an invoice or in a totals row | \`packages\` or \`totalPackages\` → quote \`82 cartons\` (the checker reads the packing method from this quote) |
  | \`Gross weight: 1,880 kg\` | quote \`1,880 kg\` |
  | \`Total due: USD 15,500.00\`, \`VAT: EUR 2,394.00\`, \`Packing and handling USD 120.00\` | \`total\`, \`tax\`, an \`otherCharges\` entry → quote \`USD 15,500.00\`, \`EUR 2,394.00\`, \`USD 120.00\` |

- **Labels stay out**: \`AOS-INV-2026-0918-01\`, not \`No. AOS-INV-2026-0918-01\`; \`AT-2026/118\`, not \`№ AT-2026/118\`; \`cartons\`, not \`Packing: cartons\`.
- **A rate stays out** of the quote of its amount, whether it is printed before or after it: \`VAT 18%: 2,790.00\` and \`20% 3,124.00\` → \`2,790.00\`, \`3,124.00\`.
- **A wrapped quote**: join the lines of a wrapped cell or box with one space, in reading order: \`Organize Sanayi Bölgesi 12. Cadde No: 8, 38070 Kayseri\`. No line breaks in a quote or a value.
- **The same text printed twice** (subtotal and total both \`USD 15,500.00\`): each field quotes its own copy. Two fields with the same quote are correct.
- **An amount in words** keeps its framing words: \`SAY … ONLY\`, \`YALNIZ …\`, \`Только …\`. Its \`value\` is the same phrase.
- **Two languages side by side**: quote the language named in \`language\`, the same one for the whole document.

## Tables over several pages

- Each line cites the page it is printed on: line 3 on the second page has \`"page": 2\` in all its facts. A fact repeated in every page's header (the document number) cites the first page.
- These rows are not lines and not totals; skip them: a header repeated on each page, and running totals such as \`Carried forward\`, \`Brought forward\`, \`Page total\`, \`Перенос\`, \`Итого по странице\`, \`Nakli yekün\`, \`Devreden\`, \`გადასატანი ჯამი\`, \`წინა გვერდიდან გადმოტანილი ჯამი\`.
- \`subtotal\`, \`total\`, the total weights and the amount in words come from where the document closes the table, normally the last page, and cite that page.

## Several documents, files and pages

- **Two documents of one type** (two invoices): one entry each, \`invoice\` and \`invoice-2\`. The cross-document rules compare only the **first** entry of each type and the report says so; put first the one the packing list and the CMR cite. Where documents of different types stand does not matter.
- **The same document twice** (a scan and its PDF, an original and a copy): extract it once, from the more readable file.
- **Two documents in one file** (invoice on page 1, packing list on page 2 of \`docs.pdf\`): two entries with the same \`sourceFile\`; \`page\` is counted in the file, so the packing list's facts are on page 2.
- **One document over several image files** (\`cmr-1.jpg\`, \`cmr-2.jpg\`): one entry; \`sourceFile\` is the first file and \`page\` is the image's place in the document (2 for \`cmr-2.jpg\`). Tell the user that "\`cmr-1.jpg\`, p. 2" in the report means the second image.

## Scans and what cannot be read

- **Text or scan**: when \`pdftotext -layout file.pdf -\` (or your PDF reader) returns the document's text, copy quotes from it. When it returns nothing, or the file is an image, read the page picture (\`pdftoppm -r 150 -png file.pdf page\` makes one per page) and type each quote as you see it, in its own script.
- **A character you cannot read for certain** (a stamp over a digit, a smudge, handwriting): the whole fact is null. Never fill in the likely value. Keep a list of these fields for the user.
- Legible handwriting and stamps count as printed.
- A scan has no text, so the checker cannot look its quotes up on the page: read each number on a scan twice, the second time from a 300 dpi picture (\`-r 300\`).
- **Letters that look the same in Latin and Cyrillic** (\`A\`, \`C\`, \`E\`, \`K\`, \`M\`, \`O\`, \`P\`, \`T\`, \`X\`) cannot be told apart on a picture. Type a document number as a text PDF of the set prints it; when none does, in Latin letters in every document, and tell the user.

## Every document

- \`number\`: the document's own number (invoice number, contract number, CMR consignment note number). \`date\`: its issue date.
- A party (\`seller\`, \`buyer\`, \`consignee\`, \`shipper\`, \`sender\`, \`carrier\`) has four facts. \`name\`: the company name with its legal form. \`address\`: street, building, postal code and city, without the country. \`country\`: the country as printed, also when it is the last word of the address. A box with a name and a country only has \`address\` null. \`taxId\`: copy the tax or company identification number as printed, without its label. Keep zeros, prefixes and separators. Null if absent or uncertain.
- A box labelled for two roles (\`Buyer / Consignee\`, \`ПОКУПАТЕЛЬ / ГРУЗОПОЛУЧАТЕЛЬ\`) is the buyer; the invoice's \`consignee\` is filled only when a separate delivery party is printed.
- \`incoterm\`: from \`FCA Kayseri, Türkiye (Incoterms 2020)\` take \`code\` \`FCA\`, \`place\` \`Kayseri, Türkiye\`, \`version\` \`Incoterms 2020\`.
- No field, so left out: bank details, payment terms, signatures, a contract's goods table, marks on a packing list.

## commercial_invoice

- \`number\`, \`date\`, \`seller\`, \`buyer\`, \`consignee\`, \`incoterm\`.
- \`contractRef\`: \`number\` and \`date\` of the contract or order the invoice cites.
- \`currency\`: quote the code or sign where the invoice names its currency (\`Currency: USD\` → quote \`USD\`), or else as printed next to the total.
- \`lines[]\`, one per goods line: \`description\`, \`model\` (article or SKU code; null when the document prints none), \`hsCode\`, \`quantity\`, \`unit\`, \`unitPrice\`, \`lineTotal\`.
- The amounts, top to bottom. Each takes only an amount charged **on this invoice**:

  | Field | Takes | Example |
  |---|---|---|
  | \`subtotal\` | goods value before discount and charges (\`Subtotal\`, \`Goods value\`, \`Стоимость товара\`, \`Mal bedeli\`, \`საქონლის ღირებულება\`); null when the invoice prints one total only | \`Subtotal: 15,500.00\` |
  | \`discount\` | the discount as an amount | \`Discount 5%: 775.00\` → \`discount\` \`775.00\` (quote \`775.00\`) and \`discountPercent\` \`5\` (quote \`5%\`) |
  | \`discountPercent\` | the discount rate | \`Less 5% discount\` with no amount → \`discountPercent\` \`5\`, \`discount\` null |
  | \`freight\`, \`insurance\` | freight and insurance added to the total | freight "paid separately" or "included" → null |
  | \`otherCharges[]\` | every other amount between subtotal and total, one entry each: packing, handling, bank charges, a second tax | \`Advance paid: 2,000.00\` is taken off → \`-2000.00\` |
  | \`tax\` | VAT, GST or sales tax added, as an amount | \`VAT 18%: 2,790.00\` → \`2790.00\`; null when prices include the tax (\`incl. VAT\`, \`в т.ч. НДС\`, \`KDV dahil\`, \`დღგ-ს ჩათვლით\`) or only the rate is printed |
  | \`total\` | the final amount payable (\`Total due\`, \`Итого к оплате\`, \`Ödenecek tutar\`, \`გადასახდელი\`) | \`Total due: USD 18,290.00\` |

  Sums printed between these (a total before tax) have no field; skip them.
- \`totalInWords\`: the amount in words.
- \`packages\`, \`netWeightKg\`, \`grossWeightKg\`, \`countryOfOrigin\`: when the invoice prints them.

## packing_list

- \`number\`, \`date\`, \`shipper\`, \`consignee\`.
- \`invoiceRef\`: \`number\` and \`date\` of the invoice it cites.
- \`packingMethod\`: the method printed once for the whole list (\`Packing: cartons\` → \`cartons\`).
- \`lines[]\`: \`description\`, \`model\`, \`quantity\` and \`unit\` (the goods: 400 pcs), \`packages\` (what they are packed in: 40 cartons), \`packingMethod\` (when the line prints its own), \`netWeightKg\`, \`grossWeightKg\`, \`volumeM3\`. A list that prints only a package count per line has \`quantity\` and \`unit\` null.
- \`totalQuantity\`, \`totalPackages\`, \`totalNetWeightKg\`, \`totalGrossWeightKg\`, \`totalVolumeM3\`: only totals the document prints. Never copy or add up line values into a total.

## cmr

| Box | Field |
|---|---|
| header | \`number\`: the consignment note number. The date printed beside it has no field |
| 1 | \`sender\` |
| 2 | \`consignee\` |
| 3 | \`placeOfDelivery\`: the whole place as written, country included |
| 4 | \`placeOfTakingOver\` (the whole place as written) and \`dateOfTakingOver\` |
| 5 | \`attachedDocuments[]\`: one entry per listed document, as printed with its number: \`Invoice BL-INV-26-0412\` |
| 6–12 | \`goods[]\`, one per goods line: \`marksAndNumbers\` (6), \`packages\` (7), \`packingMethod\` (8), \`description\` (9), \`grossWeightKg\` (11), \`volumeM3\` (12) |
| 13 | \`customsInstructions\`: the sender's instructions for customs and other formalities |
| 16 | \`carrier\` |
| 20 | \`carriageCharges\`: the charges or who pays them, as written |
| 21 | \`placeOfIssue\` and \`date\` ("established in … on …") |

- \`date\` is box 21. Take the header's date only when box 21 is empty; when both are printed and differ, take box 21 and tell the user.
- \`totalPackages\`, \`totalGrossWeightKg\`: only totals printed apart from the goods lines; with one goods line and no total row they are null.
- \`convention\`: the sentence that the carriage is subject to the CMR Convention, often pre-printed at the top. Quote the whole sentence, its lines joined with one space; on a form in several languages, the sentence in the document's language.
- \`dangerousGoods\`: the declaration, when the CMR declares dangerous goods; \`none\` or a dash is null.

## contract

\`number\`, \`date\`, \`seller\`, \`buyer\`, \`incoterm\`, \`currency\` (quoted as on an invoice), \`totalAmount\` (the contract value), \`totalInWords\`, \`goodsDescription\` (the goods as the contract names them, to the end of that sentence, without its heading: \`1. Subject of the contract. LED lighting products: ceiling panels, tubes and drivers\` → \`LED lighting products: ceiling panels, tubes and drivers\`).

## other

Any other document: \`number\`, \`date\`, and \`title\` as printed (\`Freight statement\`, \`Insurance policy\`, \`Product specification\`). A document whose title names insurance (\`Insurance certificate\`, \`Страховой полис\`, \`Sigorta poliçesi\`, \`დაზღვევის პოლისი\`) satisfies the CIF/CIP insurance check.

## Before the check, and after it

Before: every key is present; every value has its quote and page; no value was added up, converted or guessed.

After: the checker verifies the extraction itself: its shape, every format, each value against its own quote, and each quote against the text of its PDF page. Leave the searching to it: looking quotes up in \`pdftotext\` output by hand gives false alarms on wrapped cells and columns. The report opens with \`Extraction issues\` when it finds any, and a value with a format, quote or percentage issue is kept out of every rule until you fix it; quotes not found on their page are listed under \`Notes:\`.

When the report lists an issue or the script prints \`Notes:\`, open \`issues.md\`: it says what each code and each note means and what to do. A run with neither needs no more reading.
`;
