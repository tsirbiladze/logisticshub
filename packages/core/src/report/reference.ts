/**
 * The exact statement of each rule for references/rules.md: which documents
 * it reads, every finding it can report with its severity, its tolerance, and
 * when it stays silent. English only, like the rest of the skill's
 * references. Every sentence here describes the code in check/rules; change
 * the two together (test: packages/core/test/reference.test.ts).
 */
import type { MessageKey } from "../check/messages.ts";
import type { RuleId, Severity } from "../check/types.ts";

export interface RuleReference {
  /** The documents and fields the rule reads. */
  reads: string;
  findings: { key: MessageKey; severity: Severity | "error or warning"; when: string }[];
  tolerance: string;
  /** What exactly is looked at, where the finding table cannot hold it. */
  details?: string[];
  /** When nothing is reported although the documents are there. */
  silent: string[];
}

export const RULE_REFERENCE: Record<RuleId, RuleReference> = {
  "AMT-01": {
    reads: "`totalInWords` of every invoice and every contract, read in the document's language (English, Georgian, Russian or Turkish), against `total` (invoice) or `totalAmount` (contract) and `currency`.",
    findings: [
      { key: "AMT-01.mismatch", severity: "error", when: "the amount in words is another number than the amount in figures" },
      { key: "AMT-01.currency", severity: "error", when: "the currency named in words is not the document's currency" },
      {
        key: "AMT-01.unreadable",
        severity: "warning",
        when: "the words cannot be read as one amount: an unknown word, an impossible sequence (`thirty twenty`), two possible readings, cents of 100 or more, or no amount at all. Nothing is compared for that document",
      },
    ],
    tolerance: "None. `1500` and `1500.00` are equal.",
    details: [
      "A currency word that fits several currencies agrees with each of them: `manat` is AZN or TMT, `dirham` AED or MAD. `franc` alone names no currency. A bare `dollar` is read as USD.",
      "Words in a fifth language are not read: the finding is `AMT-01.unreadable`.",
    ],
    silent: [
      "The document prints no amount in words.",
      "The amount in figures is missing: only the currency is compared.",
      "The words name no currency, or the document has none: only the amount is compared.",
    ],
  },
  "SUM-01": {
    reads: "Every line of every invoice: `quantity` × `unitPrice` against `lineTotal`.",
    findings: [{ key: "SUM-01.line", severity: "error", when: "quantity × unit price is not the line total" }],
    tolerance: "Half a unit of the line total's last printed digit: ±0.005 for `4,350.00`.",
    silent: ["A line that lacks one of the three numbers."],
  },
  "SUM-02": {
    reads: "Every invoice: the line totals against `subtotal`, and `subtotal` − `discount` + `freight` + `insurance` + `otherCharges` + `tax` against `total`. Without a printed subtotal the sum of the line totals takes its place.",
    findings: [
      { key: "SUM-02.subtotal", severity: "error", when: "the line totals do not add up to the subtotal" },
      { key: "SUM-02.total", severity: "error", when: "the formula does not give the total; the message shows the formula with the amounts used" },
    ],
    tolerance: "Half a unit of the last printed digit of the subtotal, and of the total.",
    details: ["A discount is always taken off, whether printed as `500.00` or `-500.00`. A negative other charge (an advance already paid) is taken off."],
    silent: [
      "Subtotal: the invoice has no lines, a line has no line total, or no subtotal is printed.",
      "Total: no total is printed, or there is neither a subtotal nor a full set of line totals.",
      "Total: the discount is printed only as a rate (`discountPercent` other than 0 and no `discount` amount). The base of the rate is not certain, so the total is left unchecked.",
      "Total: a discount, charge or tax is printed but its value has an extraction issue.",
    ],
  },
  "SUM-03": {
    reads: "Every packing list: its lines against `totalQuantity`, `totalPackages`, `totalNetWeightKg`, `totalGrossWeightKg` and `totalVolumeM3`. Every CMR: its goods lines against `totalPackages` and `totalGrossWeightKg`.",
    findings: [{ key: "SUM-03.total", severity: "error", when: "the lines do not add up to a printed total; one finding per total" }],
    tolerance: "Quantity and packages: half a unit of the total's last printed digit (whole numbers must be equal). Weights: 0.5 kg. Volume: 0.01 m³.",
    details: ["Quantities are added up whatever their units."],
    silent: ["The total is not printed.", "A line does not print that number: a sum of some of the lines is never compared."],
  },
  "CUR-01": {
    reads: "`currency` of every invoice and every contract.",
    findings: [{ key: "CUR-01.mismatch", severity: "error", when: "they name more than one currency; one finding lists them all" }],
    tolerance: "None.",
    silent: ["A document without a currency, or with one that is not an ISO code (that is an extraction issue).", "Packing lists and CMRs have no currency field."],
  },
  "QTY-01": {
    reads: "The first invoice, the first packing list and the first CMR: quantities per item or in total, and package counts.",
    findings: [
      {
        key: "QTY-01.line",
        severity: "error",
        when: "an item's quantity differs between invoice and packing list. Items are matched by `model` (case, spaces and separators ignored) and the lines of one model are added up. Used when every line of both documents has a model and every packing-list line a quantity",
      },
      { key: "QTY-01.missing-line", severity: "error", when: "in the same case, a model is on one of the two documents and not on the other" },
      {
        key: "QTY-01.quantity",
        severity: "error",
        when: "in every other case, the sum of the invoice's line quantities differs from the packing list's `totalQuantity` (or the sum of its lines when no total is printed)",
      },
      {
        key: "QTY-01.packages",
        severity: "error",
        when: "the package counts differ between the invoice's `packages`, the packing list's `totalPackages` and the CMR's `totalPackages` (for the last two, the sum of the lines when no total is printed)",
      },
    ],
    tolerance: "None for quantities. Package counts: half a unit of the last printed digit (whole numbers must be equal).",
    silent: [
      "Quantities in different units: 400 pieces are not compared with 40 cartons. Units are compared without case, accents, dots and spaces; common spellings are one unit (`pcs`, `pieces`, `шт`, `ცალი`, `adet`; sets, pairs, kg, m, m2, l), and so is a plain English plural with its singular (`roll` and `rolls`, `box` and `boxes`: a Latin word of four letters or more ending in one `s`). Nothing is converted (kg to t, pieces per carton). A side that names no unit is compared.",
      "One model printed in two units on one document, or a line of it without a quantity.",
      "Package counts of different packing methods: when the documents name more than one method (cartons, pallets, crates, bags, rolls, bales, drums, bundles, cases, in the four languages), only counts of the same method are compared, and a count without a method is left out. The method is read from the `packingMethod` fields and from the quotes of the package counts (`82 cartons`).",
      "Fewer than two documents print a package count.",
    ],
  },
  "WGT-01": {
    reads: "Net and gross weight of every invoice, and of every line and the totals of every packing list.",
    findings: [{ key: "WGT-01.gross-below-net", severity: "error", when: "gross weight is below net weight" }],
    tolerance: "None. Equal weights pass.",
    silent: ["One of the two weights is not printed.", "A CMR has no net weight to compare."],
  },
  "WGT-02": {
    reads: "The first invoice, packing list and CMR. Gross: the packing list's `totalGrossWeightKg`, the CMR's `totalGrossWeightKg` (for both, the sum of the lines when no total is printed) and the invoice's `grossWeightKg`. Net: the packing list's `totalNetWeightKg` (or the sum of its lines) and the invoice's `netWeightKg`.",
    findings: [
      { key: "WGT-02.gross", severity: "error", when: "the gross weights differ; one finding lists every document's value" },
      { key: "WGT-02.net", severity: "error", when: "the net weights differ" },
    ],
    tolerance: "0.5 kg.",
    silent: ["Fewer than two documents print the weight.", "Weights of single lines are not compared across documents."],
  },
  "REF-01": {
    reads: "The first of each type: the packing list's `invoiceRef` against the invoice's `number` and `date`, the invoice's `contractRef` against the contract's `number` and `date`, and the CMR's `attachedDocuments` against the numbers of the invoice and the packing list.",
    findings: [
      { key: "REF-01.invoice-number", severity: "error", when: "the packing list cites another invoice number" },
      { key: "REF-01.invoice-date", severity: "error", when: "the packing list cites another invoice date" },
      { key: "REF-01.contract-number", severity: "error", when: "the invoice cites another contract number" },
      { key: "REF-01.contract-date", severity: "error", when: "the invoice cites another contract date" },
      {
        key: "REF-01.cmr-missing-document",
        severity: "warning",
        when: "the CMR lists attached documents and none of the entries contains the invoice's number, or the packing list's; one finding for each",
      },
    ],
    tolerance: "Numbers are compared without case, spaces, the separators `- _ . / \\ :` and a leading `No.`, `Nr`, `№`, `#` or `N°`. In the CMR's list a number must stand as a whole number: `AT-2026/118` is not found inside `AT-2026/118-UL`. Dates must be the same day.",
    silent: ["One side of a comparison is not printed.", "The CMR lists no attached documents.", "The contract is not looked for in the CMR's list."],
  },
  "DATE-01": {
    reads: "The first contract, invoice and CMR: their dates.",
    findings: [
      { key: "DATE-01.contract-after-invoice", severity: "error", when: "the contract is dated after the invoice" },
      {
        key: "DATE-01.invoice-after-shipment",
        severity: "warning",
        when: "the invoice is dated after the CMR's `dateOfTakingOver` (or after the CMR's own `date` when no taking-over date is printed)",
      },
    ],
    tolerance: "None. The same day passes.",
    silent: ["The invoice has no date, or the other date is not printed.", "The packing list's date is not compared."],
  },
  "PTY-01": {
    reads: "The first of each type, names only. Seller: the invoice's `seller` against the contract's `seller`, the packing list's `shipper` and the CMR's `sender`. Buyer: the invoice's `buyer` against the contract's `buyer`. Consignee: the invoice's `consignee` (its `buyer` when it names none) against the consignee of the packing list and of the CMR.",
    findings: [{ key: "PTY-01.name", severity: "warning", when: "two names of one role are not the same party; one finding per pair" }],
    tolerance: "Names are compared without case, accents, punctuation and legal forms, written out or abbreviated (`LLC`, `Ltd`, `GmbH`, `A.Ş.`, `ООО`, `შპს`). Two names are one party when one contains the other as whole words (`Kartli Retail` and `Kartli Retail Group`), or when at least 60% of their distinct words are in both.",
    silent: [
      "The set has no invoice.",
      "A name is not printed, or consists of a legal form only.",
      "Names in different scripts (Latin, Cyrillic, Georgian): they cannot be compared reliably.",
      "Addresses and countries are not compared.",
    ],
  },
  "INC-01": {
    reads: "`incoterm.code` of every invoice and every contract.",
    findings: [
      {
        key: "INC-01.unknown",
        severity: "warning",
        when: "a document's rule is not one of the eleven Incoterms 2020 rules (EXW, FCA, CPT, CIP, DAP, DPU, DDP, FAS, FOB, CFR, CIF), written as the code or as its full name in English, Russian or Turkish",
      },
      { key: "INC-01.mismatch", severity: "error", when: "the documents name different rules" },
    ],
    tolerance: "A code may be dotted or spaced (`C.I.F.`) and followed by the place (`FCA Kayseri`).",
    silent: ["A document that prints no rule.", "A rule that is not recognised gets its own warning and is left out of the comparison.", "`incoterm.place` and `incoterm.version` are not compared."],
  },
  "INC-02": {
    reads: "The first recognised Incoterms rule (invoices before contracts) and whether the set contains a CMR.",
    findings: [{ key: "INC-02.sea-term-road", severity: "warning", when: "the rule is FAS, FOB, CFR or CIF, which are for sea and inland waterway transport, and the goods travel by road under a CMR" }],
    tolerance: "None.",
    silent: ["No document names a recognised rule, or the set has no CMR."],
  },
  "INC-03": {
    reads: "The first recognised Incoterms rule (invoices before contracts), the titles of the `other` documents and `insurance` of every invoice.",
    findings: [
      {
        key: "INC-03.no-insurance",
        severity: "warning",
        when: "the rule is CIF or CIP and the set has neither an `other` document whose title names insurance (in the four languages) nor an insurance amount on an invoice",
      },
    ],
    tolerance: "None.",
    silent: ["Any other rule.", "The insurance document itself is not read: its title is enough."],
  },
  "CMR-01": {
    reads: "Every CMR. Each particular is made of these fields:",
    findings: [
      {
        key: "CMR-01.missing",
        severity: "error or warning",
        when: "a particular, or a part of it, is not filled in; the message names the part. One finding per particular. (b) to (h) are errors; (a), (i), (j) and (k) are warnings",
      },
    ],
    tolerance: "A field is filled in when it holds any text; a value with an extraction issue still counts as filled in.",
    details: [
      "(a) `date` and `placeOfIssue`. (b) `sender`: name and address. (c) `carrier`: name and address. (d) `placeOfTakingOver`, `dateOfTakingOver` and `placeOfDelivery`. (e) `consignee`: name and address.",
      "(f) at least one goods line, and a `description` and a `packingMethod` on every goods line. (g) `totalPackages`, or `packages` on every goods line; and `marksAndNumbers` on at least one line. (h) `totalGrossWeightKg`, or `grossWeightKg` on every goods line.",
      "(i) `carriageCharges`. (j) `customsInstructions`. (k) `convention`.",
    ],
    silent: ["A party's country, `dangerousGoods`, volumes and `attachedDocuments` (REF-01 reads those) are not required.", "Whether what is filled in is right is not judged."],
  },
  "DOC-01": {
    reads: "The types of the documents in the set.",
    findings: [
      { key: "DOC-01.missing", severity: "warning", when: "the set has no commercial invoice, no packing list or no CMR; one finding per missing type" },
      {
        key: "DOC-01.multiple",
        severity: "warning",
        when: "the set has more than one invoice, packing list, CMR or contract. The rules that compare documents use the first of each type in `documents`",
      },
    ],
    tolerance: "None.",
    silent: ["A missing contract: it is not required.", "`other` documents are not counted."],
  },
  "HS-01": {
    reads: "The `hsCode` of every invoice line when the invoice is dated on or after 2024-01-26 and the seller, buyer or consignee has a country of GE, GEO, Georgia, საქართველო, Грузия or Gürcistan. The country must be supported by the quote. No address or country of origin is used to infer it.",
    tolerance: "Spaces (including non-breaking spaces) and dots are removed. The first six digits must name a printed subheading or be the prefix of a longer printed code. Only eleven-digit values are checked in full, so an eight-, ten- or twelve-digit foreign code is checked at six digits.",
    details: [
      "The source is Georgia’s Ministry of Finance Order No. 21 of 26 January 2024, in force that day and published on 30 January 2024, [Matsne document 6086072, publication 0 (original annex)](https://matsne.gov.ge/ka/document/download/6086072/0/1). Later amendments were not verified.",
      "Normative texts are not protected by copyright in Georgia ([Law on Copyright and Related Rights, Art. 8(1)(a)](https://matsne.gov.ge/ka/document/view/16198)).",
      "Use `check.mjs hs` or `check.py hs` with a code prefix or Georgian description to look up the printed entries. The heading and neighbours in findings retain their official Georgian descriptions.",
    ],
    findings: [
      { key: "HS-01.unreadable", severity: "warning", when: "the code does not read as 6–12 digits after normalization, or its exact digits cannot be confirmed from the quote" },
      { key: "HS-01.unknown-subheading", severity: "warning", when: "the six-digit prefix is missing and the four-digit heading is also missing" },
      { key: "HS-01.unknown-subheading-heading", severity: "warning", when: "the six-digit prefix is missing but the four-digit heading exists and can be shown" },
      { key: "HS-01.unknown-national", severity: "error", when: "the six-digit prefix exists but the eleven-digit code is missing; up to five codes from the subheading are shown" },
    ],
    silent: [
      "The invoice prints no code, has no usable date, is dated before 2024-01-26, or has no party whose country is clearly Georgia.",
      "The printed code passes the applicable lookup. The rule never chooses a classification for the goods.",
    ],
  },
  "PTY-02": {
    reads: "Every party’s printed `taxId`, supported by its quote. Parties across documents match using the same name comparison as PTY-01.",
    tolerance: "Compare digits after removing spaces, dashes and an optional two-letter country prefix. For a confirmed Georgian party, only 9 or 11 digits are usable.",
    findings: [
      { key: "PTY-02.unreadable", severity: "warning", when: "the printed number cannot be read reliably, or a Georgian party’s number has neither 9 nor 11 digits" },
      { key: "PTY-02.number", severity: "error", when: "two readable numbers for the same party differ" },
    ],
    silent: ["No number is printed, or only one readable number is available for the party."],
  },
  "TAX-01": {
    reads: "A Georgian company’s printed name and the single FullName returned for its 9-digit code in a registry snapshot.",
    tolerance: "Ignore legal forms, punctuation, case and spacing between words. Compare names in the same script.",
    findings: [{ key: "TAX-01.name", severity: "warning", when: "the normalized names differ" }],
    silent: ["No snapshot, no single usable name in the reply, or names in different scripts."],
  },
  "TAX-02": {
    reads: "Added tax on each invoice and the snapshot’s VatPayer field for its Georgian seller’s 9-digit code.",
    tolerance: "The reply must say `არა` in every returned row. The status is from the snapshot time.",
    findings: [{ key: "TAX-02.vat", severity: "warning", when: "the invoice adds tax and the snapshot lists the seller as a non-VAT payer" }],
    silent: ["No snapshot, no usable added tax, or the reply does not establish that status."],
  },
  "TAX-03": {
    reads: "The reply for each Georgian company’s 9-digit code in the snapshot.",
    tolerance: "Quote Message verbatim without interpreting it.",
    findings: [{ key: "TAX-03.reply", severity: "warning", when: "the service returned Status -1" }],
    silent: ["No snapshot, no reply, or any other status or transport failure. The registry section still shows when a code could not be checked."],
  },
};

/**
 * How a value is held against its own quote before any rule may use it; the
 * list under "Before the rules" in references/rules.md. Every sentence
 * describes validate.ts and quote.ts
 * (test: packages/core/test/reference.test.ts, "the extraction check").
 */
export const EXTRACTION_CHECKS: string[] = [
  "**A number**: one of the numbers printed in the quote must read as the value (`1,880` reads 1880 or 1.880; the sign is not compared here). Where other numbers of the same document show its decimal sign and all show the same one, the quote must give the value with that sign. Silent when the quote prints no digits (`two cartons`) or digits in a pattern with no known reading (`1.2.3`).",
  "**A date in figures** (`18.09.2026`, `2026-09-18`, `10/14/26`): one reading of the date must be the value. Where another date of the document shows the order (a day above 12) and all that do show the same one, a date with a four-digit year at the end must be read in that order.",
  "**A date with a month name** (`14 Oct 2026`, `5 октября 2026 г.`, `2026 წლის 5 ოქტომბერი`): the date must be the value. The month is read in the document's `language` or in English: full names, the Georgian and Russian case forms, and the usual abbreviations (none for Turkish). Silent unless the quote names exactly one month and prints exactly one day, one four-digit year and no other number apart from a time of day; silent when `language` is `other` or null; never read when the quote also holds a date in figures.",
  "**The sign of a charge**: `freight`, `insurance`, `tax` or an `otherCharges` entry that is printed in brackets, alone or with its currency (`(500.00)`, `(USD 500.00)`), or with a minus attached (`-500.00`, `−500.00`, `− 500.00` with the minus sign), must not be given as a positive amount. Silent for every other field (a discount is taken off whichever way it is printed), when the quote holds more than one number (a rate beside the amount), for a hyphen set apart by a space (`Freight - 500.00`) and for a minus after the number (`500.00-`, `15,500.-`).",
  "**A currency**: when the quote is a code or sign, alone or with its amount (`USD`, `USD 15,500.00`, `$ 15,500.00`), and names exactly one currency, the value must be that currency. A sign agrees with every currency it can stand for (`$` with USD, CAD, AUD…). Silent when the quote holds any other word (`US dollars`, `ლარი`), names several currencies, or names none in use today (`RUR`, `TRL`); the codes `ALL` and `TOP` are never read as currencies.",
  "**A percentage**: a number that carries a percent sign (`20%`, `%18`, `5 %`) may be the value of `discountPercent` only; anywhere else it is `EXT_PERCENTAGE`. A sign belongs to the number it touches, so the amount in `20% 3,124.00` is no percentage.",
];

/** How every rule treats its input; the opening section of references/rules.md. */
export const RULE_PRINCIPLES: string[] = [
  "**Severity.** Errors are discrepancies that need fixing; warnings need a look. Every finding below has its severity.",
  "**Printed values only.** A rule compares values the extraction holds. When a value it needs is null, that comparison is skipped: nothing is assumed, and a document that prints less gets fewer checks.",
  "**Usable values only.** A value with an extraction issue (wrong format, not a reading of its own quote, a percentage where an amount belongs) reaches no rule until it is corrected. The report lists these issues before the findings.",
  "**The first of each type.** AMT-01, SUM-01, SUM-02, SUM-03, CUR-01, WGT-01, INC-01, CMR-01 HS-01, PTY-02 and the snapshot rules run on every document of their types. QTY-01, WGT-02, REF-01, DATE-01 and PTY-01 compare the first invoice, packing list, CMR and contract in `documents`; DOC-01 warns when there are more.",
  "**Rounding.** \"Half a unit of the last printed digit\" means a computed value may differ from the printed one by what rounding to the printed precision explains: ±0.005 against `4,350.00`, ±0.5 against `1,880`. The tolerances are fixed; no option changes them.",
  "**Output.** Each finding carries its rule, its key (below), a message in the report's language (`--lang`: en, ka, ru, tr), the quoted evidence with document and page, and a `→` line that says what to verify. Errors come first, then warnings, each in rule order.",
];

/** What the checker does not look at; the closing section of references/rules.md. */
export const NOT_CHECKED: string[] = [
  "**Incoterms place and edition**: `incoterm.place` and `incoterm.version` are recorded and not compared; whether the named place suits the rule is not judged.",
  "**Contract value and goods**: the invoice total against the contract's `totalAmount`, unit prices against the contract, and the contract's goods against the invoice lines.",
  "**Volumes across documents**: a packing list's lines are added up to its own total (SUM-03); volumes on the CMR and the packing list are not compared.",
  "**Weights per line across documents**, and net weight on a CMR.",
  "**Origin and tariff classification**: origin is recorded only. No classification, duty or tax calculation, other countries’ nomenclatures or customs declarations. HS codes are not checked when an invoice has no confirmed Georgian party, has no usable date or is dated before 2024-01-26.",
  "**Addresses, countries, bank details, signatures and stamps** of the parties. Printed registration and tax numbers are compared. Country is used to decide which checks apply. Registry Status, RegisteredSubject, Mortgage, Sequestration, AdditionalStatus and NonResident are shown as supplied.",
  "**Tax**: the rate, whether tax is due, and tax included in the prices. A printed tax amount is added into the invoice total. With a snapshot, TAX-02 checks the seller’s VAT status at lookup time.",
  "**A discount printed only as a rate**: the invoice total is then left unchecked.",
  "**Units**: nothing is converted, quantities in different units are not compared, and neither are package counts of different packing methods.",
  "**Other dates**: delivery and payment terms, validity, the packing list's date.",
  "**Further documents of a type**: a second invoice, packing list, CMR or contract is checked on its own, and by the applicable rules that read every document, but left out of QTY-01, WGT-02, REF-01, DATE-01 and PTY-01.",
  "**Other document types**: a bill of lading, certificate of origin, insurance policy or specification is recorded as `other` and not read; only its title counts, for INC-03.",
  "**The documents against reality**: the goods actually loaded, whether a document is genuine, and whether the extraction left out something the document prints.",
];
