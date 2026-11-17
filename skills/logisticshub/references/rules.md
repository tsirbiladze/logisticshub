# Rules

`scripts/check.mjs` (and `check.py`) applies these 16 rules to the extraction. This page states each rule exactly: what it reads, every finding it can report with its severity, its tolerance, and when it reports nothing. The last section lists what is not checked at all.

## How every rule works

- **Severity.** Errors are discrepancies that need fixing; warnings need a look. Every finding below has its severity.
- **Printed values only.** A rule compares values the extraction holds. When a value it needs is null, that comparison is skipped: nothing is assumed, and a document that prints less gets fewer checks.
- **Usable values only.** A value with an extraction issue (wrong format, not a reading of its own quote, a percentage where an amount belongs) reaches no rule until it is corrected. The report lists these issues before the findings.
- **The first of each type.** AMT-01, SUM-01, SUM-02, SUM-03, CUR-01, WGT-01, INC-01 and CMR-01 run on every document of their types. QTY-01, WGT-02, REF-01, DATE-01 and PTY-01 compare the first invoice, packing list, CMR and contract in `documents`; DOC-01 warns when there are more.
- **Rounding.** "Half a unit of the last printed digit" means a computed value may differ from the printed one by what rounding to the printed precision explains: ±0.005 against `4,350.00`, ±0.5 against `1,880`. The tolerances are fixed; no option changes them.
- **Output.** Each finding carries its rule, its key (below), a message in the report's language (`--lang`: en, ka, ru, tr), the quoted evidence with document and page, and a `→` line that says what to verify. Errors come first, then warnings, each in rule order.

## Before the rules: the extraction check

The checker first checks the extraction itself and lists what it finds as extraction issues, before the findings: a wrong shape or schema version (`EXT_SHAPE`: no rule runs, exit code 1), a number, date or currency in the wrong format, a value that is not a reading of its own quote (`EXT_QUOTE_MISMATCH`), a percentage where an amount belongs (`EXT_PERCENTAGE`), a value without a quote, a page below 1, a duplicate id. The codes and how to fix each are in `issues.md`.

A value is held against its own quote in these ways. Each speaks only where the quote can be read beyond doubt, and is silent otherwise:

- **A number**: one of the numbers printed in the quote must read as the value (`1,880` reads 1880 or 1.880; the sign is not compared here). Where other numbers of the same document show its decimal sign and all show the same one, the quote must give the value with that sign. Silent when the quote prints no digits (`two cartons`) or digits in a pattern with no known reading (`1.2.3`).
- **A date in figures** (`18.09.2026`, `2026-09-18`, `10/14/26`): one reading of the date must be the value. Where another date of the document shows the order (a day above 12) and all that do show the same one, a date with a four-digit year at the end must be read in that order.
- **A date with a month name** (`14 Oct 2026`, `5 октября 2026 г.`, `2026 წლის 5 ოქტომბერი`): the date must be the value. The month is read in the document's `language` or in English: full names, the Georgian and Russian case forms, and the usual abbreviations (none for Turkish). Silent unless the quote names exactly one month and prints exactly one day, one four-digit year and no other number apart from a time of day; silent when `language` is `other` or null; never read when the quote also holds a date in figures.
- **The sign of a charge**: `freight`, `insurance`, `tax` or an `otherCharges` entry that is printed in brackets, alone or with its currency (`(500.00)`, `(USD 500.00)`), or with a minus attached (`-500.00`, `−500.00`, `− 500.00` with the minus sign), must not be given as a positive amount. Silent for every other field (a discount is taken off whichever way it is printed), when the quote holds more than one number (a rate beside the amount), for a hyphen set apart by a space (`Freight - 500.00`) and for a minus after the number (`500.00-`, `15,500.-`).
- **A currency**: when the quote is a code or sign, alone or with its amount (`USD`, `USD 15,500.00`, `$ 15,500.00`), and names exactly one currency, the value must be that currency. A sign agrees with every currency it can stand for (`$` with USD, CAD, AUD…). Silent when the quote holds any other word (`US dollars`, `ლარი`), names several currencies, or names none in use today (`RUR`, `TRL`); the codes `ALL` and `TOP` are never read as currencies.
- **A percentage**: a number that carries a percent sign (`20%`, `%18`, `5 %`) may be the value of `discountPercent` only; anywhere else it is `EXT_PERCENTAGE`. A sign belongs to the number it touches, so the amount in `20% 3,124.00` is no percentage.

`check.mjs` also looks every quote up in the text of its PDF page and lists the ones it does not find under `Notes:`; `check.py` does not read the PDFs.

## The rules

### AMT-01 · Amount in words = amount in figures

The amount written in words (EN, KA, RU, TR) on an invoice or contract is the amount in figures, in the same currency.

- **Reads:** `totalInWords` of every invoice and every contract, read in the document's language (English, Georgian, Russian or Turkish), against `total` (invoice) or `totalAmount` (contract) and `currency`.
- **Tolerance:** None. `1500` and `1500.00` are equal.
- A currency word that fits several currencies agrees with each of them: `manat` is AZN or TMT, `dirham` AED or MAD. `franc` alone names no currency. A bare `dollar` is read as USD.
- Words in a fifth language are not read: the finding is `AMT-01.unreadable`.

| Finding | Severity | Reported when |
|---|---|---|
| `AMT-01.mismatch` | error | the amount in words is another number than the amount in figures |
| `AMT-01.currency` | error | the currency named in words is not the document's currency |
| `AMT-01.unreadable` | warning | the words cannot be read as one amount: an unknown word, an impossible sequence (`thirty twenty`), two possible readings, cents of 100 or more, or no amount at all. Nothing is compared for that document |

Not reported:

- The document prints no amount in words.
- The amount in figures is missing: only the currency is compared.
- The words name no currency, or the document has none: only the amount is compared.

### SUM-01 · Quantity × price = line total

On every invoice line, quantity × unit price is the line total.

- **Reads:** Every line of every invoice: `quantity` × `unitPrice` against `lineTotal`.
- **Tolerance:** Half a unit of the line total's last printed digit: ±0.005 for `4,350.00`.

| Finding | Severity | Reported when |
|---|---|---|
| `SUM-01.line` | error | quantity × unit price is not the line total |

Not reported:

- A line that lacks one of the three numbers.

### SUM-02 · Invoice totals

The line totals add up to the subtotal, and subtotal − discount + freight + insurance + other charges + tax is the invoice total.

- **Reads:** Every invoice: the line totals against `subtotal`, and `subtotal` − `discount` + `freight` + `insurance` + `otherCharges` + `tax` against `total`. Without a printed subtotal the sum of the line totals takes its place.
- **Tolerance:** Half a unit of the last printed digit of the subtotal, and of the total.
- A discount is always taken off, whether printed as `500.00` or `-500.00`. A negative other charge (an advance already paid) is taken off.

| Finding | Severity | Reported when |
|---|---|---|
| `SUM-02.subtotal` | error | the line totals do not add up to the subtotal |
| `SUM-02.total` | error | the formula does not give the total; the message shows the formula with the amounts used |

Not reported:

- Subtotal: the invoice has no lines, a line has no line total, or no subtotal is printed.
- Total: no total is printed, or there is neither a subtotal nor a full set of line totals.
- Total: the discount is printed only as a rate (`discountPercent` other than 0 and no `discount` amount). The base of the rate is not certain, so the total is left unchecked.
- Total: a discount, charge or tax is printed but its value has an extraction issue.

### SUM-03 · Packing list and CMR totals

The lines of a packing list and of a CMR add up to the totals the document prints (quantity, packages, net and gross weight, volume).

- **Reads:** Every packing list: its lines against `totalQuantity`, `totalPackages`, `totalNetWeightKg`, `totalGrossWeightKg` and `totalVolumeM3`. Every CMR: its goods lines against `totalPackages` and `totalGrossWeightKg`.
- **Tolerance:** Quantity and packages: half a unit of the total's last printed digit (whole numbers must be equal). Weights: 0.5 kg. Volume: 0.01 m³.
- Quantities are added up whatever their units.

| Finding | Severity | Reported when |
|---|---|---|
| `SUM-03.total` | error | the lines do not add up to a printed total; one finding per total |

Not reported:

- The total is not printed.
- A line does not print that number: a sum of some of the lines is never compared.

### CUR-01 · One currency

Invoices and contracts are in one currency.

- **Reads:** `currency` of every invoice and every contract.
- **Tolerance:** None.

| Finding | Severity | Reported when |
|---|---|---|
| `CUR-01.mismatch` | error | they name more than one currency; one finding lists them all |

Not reported:

- A document without a currency, or with one that is not an ISO code (that is an extraction issue).
- Packing lists and CMRs have no currency field.

### QTY-01 · Quantities and packages

Invoice and packing list give the same quantity for each item (or in total), and invoice, packing list and CMR the same number of packages.

- **Reads:** The first invoice, the first packing list and the first CMR: quantities per item or in total, and package counts.
- **Tolerance:** None for quantities. Package counts: half a unit of the last printed digit (whole numbers must be equal).

| Finding | Severity | Reported when |
|---|---|---|
| `QTY-01.line` | error | an item's quantity differs between invoice and packing list. Items are matched by `model` (case, spaces and separators ignored) and the lines of one model are added up. Used when every line of both documents has a model and every packing-list line a quantity |
| `QTY-01.missing-line` | error | in the same case, a model is on one of the two documents and not on the other |
| `QTY-01.quantity` | error | in every other case, the sum of the invoice's line quantities differs from the packing list's `totalQuantity` (or the sum of its lines when no total is printed) |
| `QTY-01.packages` | error | the package counts differ between the invoice's `packages`, the packing list's `totalPackages` and the CMR's `totalPackages` (for the last two, the sum of the lines when no total is printed) |

Not reported:

- Quantities in different units: 400 pieces are not compared with 40 cartons. Units are compared without case, accents, dots and spaces; common spellings are one unit (`pcs`, `pieces`, `шт`, `ცალი`, `adet`; sets, pairs, kg, m, m2, l), and so is a plain English plural with its singular (`roll` and `rolls`, `box` and `boxes`: a Latin word of four letters or more ending in one `s`). Nothing is converted (kg to t, pieces per carton). A side that names no unit is compared.
- One model printed in two units on one document, or a line of it without a quantity.
- Package counts of different packing methods: when the documents name more than one method (cartons, pallets, crates, bags, rolls, bales, drums, bundles, cases, in the four languages), only counts of the same method are compared, and a count without a method is left out. The method is read from the `packingMethod` fields and from the quotes of the package counts (`82 cartons`).
- Fewer than two documents print a package count.

### WGT-01 · Gross ≥ net

Gross weight is never below net weight, on the invoice and on every line and total of the packing list.

- **Reads:** Net and gross weight of every invoice, and of every line and the totals of every packing list.
- **Tolerance:** None. Equal weights pass.

| Finding | Severity | Reported when |
|---|---|---|
| `WGT-01.gross-below-net` | error | gross weight is below net weight |

Not reported:

- One of the two weights is not printed.
- A CMR has no net weight to compare.

### WGT-02 · Same weights on every document

Invoice, packing list and CMR give the same gross weight, and invoice and packing list the same net weight.

- **Reads:** The first invoice, packing list and CMR. Gross: the packing list's `totalGrossWeightKg`, the CMR's `totalGrossWeightKg` (for both, the sum of the lines when no total is printed) and the invoice's `grossWeightKg`. Net: the packing list's `totalNetWeightKg` (or the sum of its lines) and the invoice's `netWeightKg`.
- **Tolerance:** 0.5 kg.

| Finding | Severity | Reported when |
|---|---|---|
| `WGT-02.gross` | error | the gross weights differ; one finding lists every document's value |
| `WGT-02.net` | error | the net weights differ |

Not reported:

- Fewer than two documents print the weight.
- Weights of single lines are not compared across documents.

### REF-01 · Cross-references

The packing list cites the invoice's number and date, the invoice cites the contract's, and the CMR lists the invoice and the packing list among its attached documents.

- **Reads:** The first of each type: the packing list's `invoiceRef` against the invoice's `number` and `date`, the invoice's `contractRef` against the contract's `number` and `date`, and the CMR's `attachedDocuments` against the numbers of the invoice and the packing list.
- **Tolerance:** Numbers are compared without case, spaces, the separators `- _ . / \ :` and a leading `No.`, `Nr`, `№`, `#` or `N°`. In the CMR's list a number must stand as a whole number: `AT-2026/118` is not found inside `AT-2026/118-UL`. Dates must be the same day.

| Finding | Severity | Reported when |
|---|---|---|
| `REF-01.invoice-number` | error | the packing list cites another invoice number |
| `REF-01.invoice-date` | error | the packing list cites another invoice date |
| `REF-01.contract-number` | error | the invoice cites another contract number |
| `REF-01.contract-date` | error | the invoice cites another contract date |
| `REF-01.cmr-missing-document` | warning | the CMR lists attached documents and none of the entries contains the invoice's number, or the packing list's; one finding for each |

Not reported:

- One side of a comparison is not printed.
- The CMR lists no attached documents.
- The contract is not looked for in the CMR's list.

### DATE-01 · Date order

The contract is not dated after the invoice, and the invoice not after the day the goods were taken over.

- **Reads:** The first contract, invoice and CMR: their dates.
- **Tolerance:** None. The same day passes.

| Finding | Severity | Reported when |
|---|---|---|
| `DATE-01.contract-after-invoice` | error | the contract is dated after the invoice |
| `DATE-01.invoice-after-shipment` | warning | the invoice is dated after the CMR's `dateOfTakingOver` (or after the CMR's own `date` when no taking-over date is printed) |

Not reported:

- The invoice has no date, or the other date is not printed.
- The packing list's date is not compared.

### PTY-01 · Same parties

Seller, buyer and consignee carry the same names on every document.

- **Reads:** The first of each type, names only. Seller: the invoice's `seller` against the contract's `seller`, the packing list's `shipper` and the CMR's `sender`. Buyer: the invoice's `buyer` against the contract's `buyer`. Consignee: the invoice's `consignee` (its `buyer` when it names none) against the consignee of the packing list and of the CMR.
- **Tolerance:** Names are compared without case, accents, punctuation and legal forms, written out or abbreviated (`LLC`, `Ltd`, `GmbH`, `A.Ş.`, `ООО`, `შპს`). Two names are one party when one contains the other as whole words (`Kartli Retail` and `Kartli Retail Group`), or when at least 60% of their distinct words are in both.

| Finding | Severity | Reported when |
|---|---|---|
| `PTY-01.name` | warning | two names of one role are not the same party; one finding per pair |

Not reported:

- The set has no invoice.
- A name is not printed, or consists of a legal form only.
- Names in different scripts (Latin, Cyrillic, Georgian): they cannot be compared reliably.
- Addresses and countries are not compared.

### INC-01 · Incoterms rule

Invoice and contract name the same Incoterms rule, and it is an Incoterms 2020 rule.

- **Reads:** `incoterm.code` of every invoice and every contract.
- **Tolerance:** A code may be dotted or spaced (`C.I.F.`) and followed by the place (`FCA Kayseri`).

| Finding | Severity | Reported when |
|---|---|---|
| `INC-01.unknown` | warning | a document's rule is not one of the eleven Incoterms 2020 rules (EXW, FCA, CPT, CIP, DAP, DPU, DDP, FAS, FOB, CFR, CIF), written as the code or as its full name in English, Russian or Turkish |
| `INC-01.mismatch` | error | the documents name different rules |

Not reported:

- A document that prints no rule.
- A rule that is not recognised gets its own warning and is left out of the comparison.
- `incoterm.place` and `incoterm.version` are not compared.

### INC-02 · Incoterms and transport mode

A rule for sea transport only (FAS, FOB, CFR, CIF) is not used for a road shipment under a CMR.

- **Reads:** The first recognised Incoterms rule (invoices before contracts) and whether the set contains a CMR.
- **Tolerance:** None.

| Finding | Severity | Reported when |
|---|---|---|
| `INC-02.sea-term-road` | warning | the rule is FAS, FOB, CFR or CIF, which are for sea and inland waterway transport, and the goods travel by road under a CMR |

Not reported:

- No document names a recognised rule, or the set has no CMR.

### INC-03 · Insurance under CIF/CIP

Under CIF or CIP the set shows the seller's insurance: an insurance document or an insurance amount on the invoice.

- **Reads:** The first recognised Incoterms rule (invoices before contracts), the titles of the `other` documents and `insurance` of every invoice.
- **Tolerance:** None.

| Finding | Severity | Reported when |
|---|---|---|
| `INC-03.no-insurance` | warning | the rule is CIF or CIP and the set has neither an `other` document whose title names insurance (in the four languages) nor an insurance amount on an invoice |

Not reported:

- Any other rule.
- The insurance document itself is not read: its title is enough.

### CMR-01 · CMR required particulars

The CMR carries the particulars of CMR Convention Art. 6(1)(a) to (k).

- **Reads:** Every CMR. Each particular is made of these fields:
- **Tolerance:** A field is filled in when it holds any text; a value with an extraction issue still counts as filled in.
- (a) `date` and `placeOfIssue`. (b) `sender`: name and address. (c) `carrier`: name and address. (d) `placeOfTakingOver`, `dateOfTakingOver` and `placeOfDelivery`. (e) `consignee`: name and address.
- (f) at least one goods line, and a `description` and a `packingMethod` on every goods line. (g) `totalPackages`, or `packages` on every goods line; and `marksAndNumbers` on at least one line. (h) `totalGrossWeightKg`, or `grossWeightKg` on every goods line.
- (i) `carriageCharges`. (j) `customsInstructions`. (k) `convention`.

| Finding | Severity | Reported when |
|---|---|---|
| `CMR-01.missing` | error or warning | a particular, or a part of it, is not filled in; the message names the part. One finding per particular. (b) to (h) are errors; (a), (i), (j) and (k) are warnings |

Not reported:

- A party's country, `dangerousGoods`, volumes and `attachedDocuments` (REF-01 reads those) are not required.
- Whether what is filled in is right is not judged.

### DOC-01 · Complete document set

The set has a commercial invoice, a packing list and a CMR, and one of each.

- **Reads:** The types of the documents in the set.
- **Tolerance:** None.

| Finding | Severity | Reported when |
|---|---|---|
| `DOC-01.missing` | warning | the set has no commercial invoice, no packing list or no CMR; one finding per missing type |
| `DOC-01.multiple` | warning | the set has more than one invoice, packing list, CMR or contract. The rules that compare documents use the first of each type in `documents` |

Not reported:

- A missing contract: it is not required.
- `other` documents are not counted.

## Not checked

- **Incoterms place and edition**: `incoterm.place` and `incoterm.version` are recorded and not compared; whether the named place suits the rule is not judged.
- **Contract value and goods**: the invoice total against the contract's `totalAmount`, unit prices against the contract, and the contract's goods against the invoice lines.
- **Volumes across documents**: a packing list's lines are added up to its own total (SUM-03); volumes on the CMR and the packing list are not compared.
- **Weights per line across documents**, and net weight on a CMR.
- **Origin and HS codes**: `countryOfOrigin` and `hsCode` are recorded only. No tariff classification, no duty or tax calculation, no customs declaration.
- **Addresses, countries, registration and tax numbers, bank details, signatures and stamps** of the parties. Only names are compared, and not across scripts.
- **Tax**: the rate, whether tax is due, and tax included in the prices. A printed tax amount is only added into the invoice total.
- **A discount printed only as a rate**: the invoice total is then left unchecked.
- **Units**: nothing is converted, quantities in different units are not compared, and neither are package counts of different packing methods.
- **Other dates**: delivery and payment terms, validity, the packing list's date.
- **Further documents of a type**: a second invoice, packing list, CMR or contract is checked on its own, and by CUR-01 and INC-01, but left out of QTY-01, WGT-02, REF-01, DATE-01 and PTY-01.
- **Other document types**: a bill of lading, certificate of origin, insurance policy or specification is recorded as `other` and not read; only its title counts, for INC-03.
- **The documents against reality**: the goods actually loaded, whether a document is genuine, and whether the extraction left out something the document prints.
