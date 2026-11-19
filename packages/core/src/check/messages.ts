/**
 * Finding texts in the four report languages.
 *
 * Rules put machine values into params; this module localizes them:
 * - document, present, missing, aDocument, bDocument: document type codes
 *   (each also gives {<name>In}: "in the invoice", „ინვოისში“, «в инвойсе», "faturada")
 * - metric, role: codes (see VOCAB)
 * - item, fields: CMR Art. 6(1) letter and the missing field paths (add
 *   {particular}: the part that is missing, or the whole particular)
 * - dates (see DATE_PARAMS): YYYY-MM-DD -> the way the language writes a date
 * - where: "commercial_invoice" | "packing_list:total" | "packing_list:line:<n>"
 * - values: JSON [[type, value], …] -> "invoice 100, CMR 90"
 * - currencies, codes: JSON [[type, value], …] -> "EUR (invoice), USD (contract)"
 * - reason: amount-in-words error code (adds {reason}, with {word} filled in)
 * - count: a number of documents (adds {docs}, the noun in the right plural form)
 * - numbers (see NUMBER_PARAMS): "15694.00" -> "15,694.00", „15 694,00“, the
 *   way the language groups thousands, with the currency or "kg" where the
 *   rule knows it. The params themselves stay canonical.
 */
import { isIsoDate } from "../dates.ts";
import type { DocumentType } from "../schema.ts";
import type { WordsErrorCode } from "../words/index.ts";

export const REPORT_LANGUAGES = ["en", "ka", "ru", "tr"] as const;
export type ReportLanguage = (typeof REPORT_LANGUAGES)[number];

export type Metric = "quantity" | "packages" | "netWeightKg" | "grossWeightKg" | "volumeM3";
export type Role = "seller" | "buyer" | "consignee";

/** Noun forms after a number: 1 / 2–4 / 5+ (Russian); English uses one/many, Georgian and Turkish one form. */
export type PluralForms = { one: string; few: string; many: string };

/**
 * The parts of each CMR Art. 6(1) particular, as field paths without line
 * numbers. When only some are missing, CMR-01 names those parts.
 */
export const CMR_PARTS: Record<string, readonly CmrPart[]> = {
  a: ["date", "placeOfIssue"],
  b: ["sender.name", "sender.address"],
  c: ["carrier.name", "carrier.address"],
  d: ["placeOfTakingOver", "dateOfTakingOver", "placeOfDelivery"],
  e: ["consignee.name", "consignee.address"],
  f: ["goods.description", "goods.packingMethod"],
  g: ["totalPackages", "goods.marksAndNumbers"],
};

export type CmrPart =
  | "date"
  | "placeOfIssue"
  | "sender.name"
  | "sender.address"
  | "carrier.name"
  | "carrier.address"
  | "placeOfTakingOver"
  | "dateOfTakingOver"
  | "placeOfDelivery"
  | "consignee.name"
  | "consignee.address"
  | "goods.description"
  | "goods.packingMethod"
  | "totalPackages"
  | "goods.marksAndNumbers";

/** Params that carry a date (YYYY-MM-DD), per message. They are shown the way the report's language writes dates. */
export const DATE_PARAMS: Partial<Record<string, readonly string[]>> = {
  "REF-01.invoice-date": ["found", "expected"],
  "REF-01.contract-date": ["found", "expected"],
  "DATE-01.contract-after-invoice": ["contract", "invoice"],
  "DATE-01.invoice-after-shipment": ["invoice", "shipment"],
  "DATE-01.invoice-after-declaration": ["invoice", "registration"],
};

/** How a number is shown in a message: plain, with the finding's currency, with "kg", or as a formula of several numbers. */
export type NumberKind = "number" | "money" | "kg" | "formula";

/**
 * Params that carry a number (a canonical decimal, or a list of them in
 * `values`), per message. They are shown the way the report's language writes
 * a number. "money" adds the currency the rule gave for that param
 * (Finding.units), "kg" adds the unit.
 */
export const NUMBER_PARAMS: Partial<Record<string, Readonly<Record<string, NumberKind>>>> = {
  "AMT-01.mismatch": { wordsAmount: "money", amount: "money" },
  "SUM-01.line": { quantity: "number", unitPrice: "number", expected: "money", found: "money" },
  "SUM-02.subtotal": { expected: "money", found: "money" },
  "SUM-02.total": { expected: "money", formula: "formula", found: "money" },
  "SUM-03.total": { expected: "number", found: "number" },
  "QTY-01.quantity": { invoice: "number", packingList: "number" },
  "QTY-01.line": { invoice: "number", packingList: "number" },
  "QTY-01.packages": { values: "number" },
  "WGT-01.gross-below-net": { gross: "number", net: "number" },
  "WGT-02.gross": { values: "kg" },
  "WGT-02.net": { values: "kg" },
  "DEC-03.gross": { found: "kg", expected: "kg" },
  "DEC-03.net": { found: "kg", expected: "kg" },
  "DEC-04.packages": { found: "number", expected: "number" },
  "DEC-05.invoice-total": { found: "money", expected: "money" },
  "DEC-05.item-total": { found: "money", expected: "money" },
};

interface Vocab {
  /** Thousands separator and decimal sign: "15,694.00" in English, "15 694,00" in Georgian and Russian, "15.694,00" in Turkish. */
  number: { group: string; decimal: string };
  /** The unit after a weight. */
  kg: string;
  doc: Record<DocumentType, string>;
  /** "in the <document>", for sentences that say where something is or is not. */
  docIn: Record<DocumentType, string>;
  metric: Record<Metric, string>;
  role: Record<Role, string>;
  particular: Record<string, string>;
  /** One part of a CMR particular, for when only that part is missing. */
  cmrField: Record<CmrPart, string>;
  /** Month names for dates written "5 October 2026"; null where dates are written 05.10.2026. */
  months: readonly string[] | null;
  /** Value lists name the document with docIn („ინვოისში 100, CMR-ში 90“) rather than doc ("invoice 100, CMR 90"). */
  listIn: boolean;
  /** Why an amount in words could not be read; "{word}" is the word or phrase concerned. */
  reason: Record<WordsErrorCode, string>;
  documentCount: PluralForms;
  total: string;
  line: string;
  item: string;
}

export const VOCAB: Record<ReportLanguage, Vocab> = {
  en: {
    number: { group: ",", decimal: "." },
    kg: "kg",
    doc: { commercial_invoice: "invoice", packing_list: "packing list", cmr: "CMR", contract: "contract", customs_declaration: "customs declaration", other: "document" },
    docIn: { commercial_invoice: "in the invoice", packing_list: "in the packing list", cmr: "in the CMR", contract: "in the contract", customs_declaration: "in the customs declaration", other: "in the document" },
    metric: { quantity: "quantity", packages: "packages", netWeightKg: "net weight, kg", grossWeightKg: "gross weight, kg", volumeM3: "volume, m³" },
    role: { seller: "Seller", buyer: "Buyer", consignee: "Consignee" },
    particular: {
      a: "date and place the CMR was made out",
      b: "name and address of the sender",
      c: "name and address of the carrier",
      d: "place and date of taking over, place of delivery",
      e: "name and address of the consignee",
      f: "description of the goods and method of packing",
      g: "number of packages, marks and numbers",
      h: "gross weight",
      i: "carriage charges",
      j: "instructions for customs",
      k: "statement that the CMR Convention applies",
    },
    cmrField: {
      date: "date the CMR was made out",
      placeOfIssue: "place the CMR was made out",
      "sender.name": "name of the sender",
      "sender.address": "address of the sender",
      "carrier.name": "name of the carrier",
      "carrier.address": "address of the carrier",
      placeOfTakingOver: "place of taking over",
      dateOfTakingOver: "date of taking over",
      placeOfDelivery: "place of delivery",
      "consignee.name": "name of the consignee",
      "consignee.address": "address of the consignee",
      "goods.description": "description of the goods",
      "goods.packingMethod": "method of packing",
      totalPackages: "number of packages",
      "goods.marksAndNumbers": "marks and numbers",
    },
    months: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
    listIn: false,
    reason: {
      EMPTY: "no amount found",
      UNKNOWN_WORD: "unknown word \"{word}\"",
      INVALID_SEQUENCE: "\"{word}\" is not a valid number",
      AMBIGUOUS: "the words can be read in more than one way",
      MINOR_OUT_OF_RANGE: "the cents are 100 or more",
    },
    documentCount: { one: "document", few: "documents", many: "documents" },
    total: "total",
    line: "line",
    item: "item",
  },
  ka: {
    number: { group: "\u00a0", decimal: "," },
    kg: "კგ",
    doc: { commercial_invoice: "ინვოისი", packing_list: "შეფუთვის ფურცელი", cmr: "CMR", contract: "ხელშეკრულება", customs_declaration: "საბაჟო დეკლარაცია", other: "დოკუმენტი" },
    docIn: { commercial_invoice: "ინვოისში", packing_list: "შეფუთვის ფურცელში", cmr: "CMR-ში", contract: "ხელშეკრულებაში", customs_declaration: "საბაჟო დეკლარაციაში", other: "დოკუმენტში" },
    metric: { quantity: "რაოდენობა", packages: "ადგილების რაოდენობა", netWeightKg: "ნეტო, კგ", grossWeightKg: "ბრუტო, კგ", volumeM3: "მოცულობა, მ³" },
    role: { seller: "გამყიდველი", buyer: "მყიდველი", consignee: "მიმღები" },
    particular: {
      a: "შედგენის თარიღი და ადგილი",
      b: "გამგზავნის სახელი და მისამართი",
      c: "გადამზიდველის სახელი და მისამართი",
      d: "ტვირთის მიღების ადგილი და თარიღი, მიწოდების ადგილი",
      e: "მიმღების სახელი და მისამართი",
      f: "საქონლის აღწერა და შეფუთვის სახე",
      g: "ადგილების რაოდენობა, მარკირება და ნომრები",
      h: "ბრუტო წონა",
      i: "გადაზიდვის ხარჯები",
      j: "მითითებები საბაჟოსთვის",
      k: "ჩანაწერი, რომ გადაზიდვას CMR კონვენცია არეგულირებს",
    },
    cmrField: {
      date: "შედგენის თარიღი",
      placeOfIssue: "შედგენის ადგილი",
      "sender.name": "გამგზავნის სახელი",
      "sender.address": "გამგზავნის მისამართი",
      "carrier.name": "გადამზიდველის სახელი",
      "carrier.address": "გადამზიდველის მისამართი",
      placeOfTakingOver: "ტვირთის მიღების ადგილი",
      dateOfTakingOver: "ტვირთის მიღების თარიღი",
      placeOfDelivery: "მიწოდების ადგილი",
      "consignee.name": "მიმღების სახელი",
      "consignee.address": "მიმღების მისამართი",
      "goods.description": "საქონლის აღწერა",
      "goods.packingMethod": "შეფუთვის სახე",
      totalPackages: "ადგილების რაოდენობა",
      "goods.marksAndNumbers": "მარკირება და ნომრები",
    },
    months: null,
    listIn: true,
    reason: {
      EMPTY: "თანხა არ ჩანს",
      UNKNOWN_WORD: "უცნობი სიტყვა „{word}“",
      INVALID_SEQUENCE: "„{word}“ სწორი რიცხვი არ არის",
      AMBIGUOUS: "ტექსტი ცალსახად არ იკითხება",
      MINOR_OUT_OF_RANGE: "ცენტები (თეთრები) 100 ან მეტია",
    },
    documentCount: { one: "დოკუმენტი", few: "დოკუმენტი", many: "დოკუმენტი" },
    total: "ჯამი",
    line: "სტრიქონი",
    item: "საქონელი",
  },
  ru: {
    number: { group: "\u00a0", decimal: "," },
    kg: "кг",
    doc: { commercial_invoice: "инвойс", packing_list: "упаковочный лист", cmr: "CMR", contract: "договор", customs_declaration: "таможенная декларация", other: "документ" },
    docIn: { commercial_invoice: "в инвойсе", packing_list: "в упаковочном листе", cmr: "в CMR", contract: "в договоре", customs_declaration: "в таможенной декларации", other: "в документе" },
    metric: { quantity: "количество", packages: "места", netWeightKg: "нетто, кг", grossWeightKg: "брутто, кг", volumeM3: "объём, м³" },
    role: { seller: "Продавец", buyer: "Покупатель", consignee: "Грузополучатель" },
    particular: {
      a: "дата и место составления",
      b: "наименование и адрес отправителя",
      c: "наименование и адрес перевозчика",
      d: "место и дата принятия груза, место доставки",
      e: "наименование и адрес получателя",
      f: "описание груза и вид упаковки",
      g: "число мест, их маркировка и номера",
      h: "вес брутто",
      i: "расходы, связанные с перевозкой",
      j: "указания для таможенных формальностей",
      k: "указание, что перевозка регулируется Конвенцией CMR",
    },
    cmrField: {
      date: "дата составления",
      placeOfIssue: "место составления",
      "sender.name": "наименование отправителя",
      "sender.address": "адрес отправителя",
      "carrier.name": "наименование перевозчика",
      "carrier.address": "адрес перевозчика",
      placeOfTakingOver: "место принятия груза",
      dateOfTakingOver: "дата принятия груза",
      placeOfDelivery: "место доставки",
      "consignee.name": "наименование получателя",
      "consignee.address": "адрес получателя",
      "goods.description": "описание груза",
      "goods.packingMethod": "вид упаковки",
      totalPackages: "число мест",
      "goods.marksAndNumbers": "маркировка и номера мест",
    },
    months: null,
    listIn: true,
    reason: {
      EMPTY: "сумма не найдена",
      UNKNOWN_WORD: "неизвестное слово «{word}»",
      INVALID_SEQUENCE: "«{word}» — недопустимое число",
      AMBIGUOUS: "текст можно прочитать по-разному",
      MINOR_OUT_OF_RANGE: "центов (копеек) 100 или больше",
    },
    documentCount: { one: "документ", few: "документа", many: "документов" },
    total: "итого",
    line: "строка",
    item: "товар",
  },
  tr: {
    number: { group: ".", decimal: "," },
    kg: "kg",
    doc: { commercial_invoice: "fatura", packing_list: "çeki listesi", cmr: "CMR", contract: "sözleşme", customs_declaration: "gümrük beyannamesi", other: "belge" },
    docIn: { commercial_invoice: "faturada", packing_list: "çeki listesinde", cmr: "CMR'de", contract: "sözleşmede", customs_declaration: "gümrük beyannamesinde", other: "belgede" },
    metric: { quantity: "miktar", packages: "kap", netWeightKg: "net, kg", grossWeightKg: "brüt, kg", volumeM3: "hacim, m³" },
    role: { seller: "Satıcı", buyer: "Alıcı", consignee: "Alıcı (teslim alan)" },
    particular: {
      a: "düzenlenme tarihi ve yeri",
      b: "göndericinin adı ve adresi",
      c: "taşıyıcının adı ve adresi",
      d: "yükleme yeri ve tarihi, teslim yeri",
      e: "alıcının adı ve adresi",
      f: "eşyanın tanımı ve ambalaj şekli",
      g: "kap sayısı, marka ve numaraları",
      h: "brüt ağırlık",
      i: "taşıma masrafları",
      j: "gümrük işlemleri için talimatlar",
      k: "taşımanın CMR Sözleşmesine tabi olduğu kaydı",
    },
    cmrField: {
      date: "düzenlenme tarihi",
      placeOfIssue: "düzenlenme yeri",
      "sender.name": "göndericinin adı",
      "sender.address": "göndericinin adresi",
      "carrier.name": "taşıyıcının adı",
      "carrier.address": "taşıyıcının adresi",
      placeOfTakingOver: "yükleme yeri",
      dateOfTakingOver: "yükleme tarihi",
      placeOfDelivery: "teslim yeri",
      "consignee.name": "alıcının adı",
      "consignee.address": "alıcının adresi",
      "goods.description": "eşyanın tanımı",
      "goods.packingMethod": "ambalaj şekli",
      totalPackages: "kap sayısı",
      "goods.marksAndNumbers": "marka ve numaralar",
    },
    months: null,
    listIn: true,
    reason: {
      EMPTY: "tutar bulunamadı",
      UNKNOWN_WORD: "bilinmeyen kelime \"{word}\"",
      INVALID_SEQUENCE: "\"{word}\" geçerli bir sayı değil",
      AMBIGUOUS: "ifade birden fazla şekilde okunabiliyor",
      MINOR_OUT_OF_RANGE: "kuruş (sent) kısmı 100 veya daha fazla",
    },
    documentCount: { one: "belge", few: "belge", many: "belge" },
    total: "toplam",
    line: "satır",
    item: "kalem",
  },
};

export const MESSAGES = {
  en: {
    "AMT-01.mismatch": "Amount in words reads {wordsAmount}, but the amount in figures is {amount}.",
    "AMT-01.currency": "Amount in words is in {wordsCurrency}, but the document currency is {currency}.",
    "AMT-01.unreadable": "Amount in words could not be read: {reason}.",
    "SUM-01.line": "Line {line}: {quantity} × {unitPrice} = {expected}, but the line total is {found}.",
    "SUM-02.subtotal": "Line totals add up to {expected}, but the subtotal is {found}.",
    "SUM-02.total": "Expected total {expected} ({formula}), but the invoice total is {found}.",
    "SUM-03.total": "{document}: lines add up to {expected} ({metric}), but the stated total is {found}.",
    "CUR-01.mismatch": "Documents use different currencies: {currencies}.",
    "QTY-01.quantity": "Quantity differs: invoice {invoice}, packing list {packingList}.",
    "QTY-01.line": "Item {model}: invoice quantity {invoice}, packing list quantity {packingList}.",
    "QTY-01.missing-line": "Item {model} is {presentIn} but not {missingIn}.",
    "QTY-01.packages": "Number of packages differs: {values}.",
    "WGT-01.gross-below-net": "{where}: gross weight {gross} kg is less than net weight {net} kg.",
    "WGT-02.gross": "Gross weight differs: {values}.",
    "WGT-02.net": "Net weight differs: {values}.",
    "REF-01.invoice-number": "Packing list refers to invoice {found}, but the invoice number is {expected}.",
    "REF-01.invoice-date": "Packing list gives invoice date {found}, but the invoice is dated {expected}.",
    "REF-01.contract-number": "Invoice refers to contract {found}, but the contract number is {expected}.",
    "REF-01.contract-date": "Invoice gives contract date {found}, but the contract is dated {expected}.",
    "REF-01.cmr-missing-document": "The CMR's attached documents do not list the {document} {number}.",
    "DATE-01.contract-after-invoice": "Contract date {contract} is after the invoice date {invoice}.",
    "DATE-01.invoice-after-shipment": "Invoice date {invoice} is after the goods were taken over on {shipment}.",
    "PTY-01.name": "{role} differs: \"{a}\" ({aDocument}) and \"{b}\" ({bDocument}).",
    "INC-01.mismatch": "Incoterms differ: {codes}.",
    "INC-01.unknown": "\"{code}\" is not an Incoterms 2020 rule.",
    "INC-02.sea-term-road": "{code} is a sea and inland waterway rule, but the goods travel by road under a CMR.",
    "INC-03.no-insurance": "Under {code} the seller insures the goods, but the documents show neither an insurance policy nor an insurance charge.",
    "CMR-01.missing": "CMR is missing Art. 6(1)({item}): {particular}.",
    "DOC-01.missing": "Missing document: {document}.",
    "DOC-01.multiple": "{count} {docs} of type {document}; cross-checks use the first one.",
    "DOC-01.multiple-invoices-declaration": "{count} {docs} of type {document}. The declaration checks use all invoices for HS prefixes, currency and totals.",
    "HS-01.unreadable": "Line {line}: the HS code could not be read.",
    "HS-01.unknown-subheading": "Line {line}: subheading {subheading} is absent from the Georgian nomenclature (Order No. 21, original text). Later amendments were not verified.",
    "HS-01.unknown-subheading-heading": "Line {line}: subheading {subheading} is absent from the Georgian nomenclature (Order No. 21, original text). Later amendments were not verified. Nearest heading: {heading} · {description}",
    "HS-01.unknown-national": "Line {line}: national code {code} is absent from the Georgian nomenclature (Order No. 21, original text). Later amendments were not verified. Codes under {subheading}: {neighbours}",
    "PTY-02.unreadable": "The tax identification number for “{name}” could not be read.",
    "PTY-02.number": "The tax identification number for “{name}” differs: “{a}” and “{b}”.",
    "TAX-01.name": "The printed name “{printed}” differs from “{registered}” in the Revenue Service snapshot dated {snapshotDate}.",
    "TAX-02.vat": "The invoice adds tax, and the Revenue Service lists {code} as not a VAT payer at {checkedAt}. This status is from the snapshot time, not the invoice date.",
    "TAX-03.reply": "Revenue Service reply for {code}: “{reply}”",
    "REF-01.declaration-missing-invoice": "The customs declaration's attached documents (box 44) do not list invoice {number}.",
    "DATE-01.invoice-after-declaration": "Invoice date {invoice} is after the declaration's registration date {registration}.",
    "DEC-01.tax-id": "For the {role}, the invoice gives tax ID {invoice}, and the declaration gives {declaration}.",
    "DEC-01.name": "For the {role}, the invoice names {invoice}, and the declaration names {declaration}.",
    "DEC-02.unreadable": "Item {line}: the HS code could not be read as an 11-digit national code.",
    "DEC-02.invoice-prefix": "Invoice line {line}: code {code} has no matching six-digit prefix on the declaration.",
    "DEC-02.declaration-prefix": "Declared item {line}: code {code} has no matching six-digit prefix on the invoices.",
    "DEC-03.gross": "The declared items total {found} gross, and {documentIn} the gross total is {expected}.",
    "DEC-03.net": "The declared items total {found} net, and {documentIn} the net total is {expected}.",
    "DEC-04.packages": "The declaration gives {found} packages, and {documentIn} the count is {expected}.",
    "DEC-05.currency": "Box 22 gives currency {found}, and the invoices use {expected}.",
    "DEC-05.invoice-total": "Box 22 gives {found}, and the invoice total is {expected}.",
    "DEC-05.item-total": "Box 42 values add up to {found}, and box 22 gives {expected}.",
    "DEC-06.origin": "Item {line} gives origin {declaration}, and the invoice gives {invoice}.",
    "DEC-06.unestablished": "Item {line}: box 34a gives code 999 (origin not established).",
    "DEC-02.unknown-national": "Item {line}: national code {code} is absent from the Georgian nomenclature (Order No. 21, original text). Later amendments were not verified. Codes under {subheading}: {neighbours}",
    "DEC-02.unknown-national-heading": "Item {line}: national code {code} is absent from the Georgian nomenclature (Order No. 21, original text). Later amendments were not verified. Nearest heading: {heading} · {description}",
    "DEC-02.unknown-national-alone": "Item {line}: national code {code} is absent from the Georgian nomenclature (Order No. 21, original text). Later amendments were not verified.",
  },
  ka: {
    "AMT-01.mismatch": "სიტყვიერად წერია {wordsAmount}, ციფრებით კი {amount}.",
    "AMT-01.currency": "სიტყვიერად თანხა {wordsCurrency}-ში წერია, დოკუმენტის ვალუტა კი {currency}-ია.",
    "AMT-01.unreadable": "სიტყვიერი თანხა ვერ იკითხება: {reason}.",
    "SUM-01.line": "სტრიქონი {line}: {quantity} × {unitPrice} = {expected}, სტრიქონის ჯამად კი წერია {found}.",
    "SUM-02.subtotal": "სტრიქონების ჯამი {expected}-ია, საქონლის ღირებულებად კი წერია {found}.",
    "SUM-02.total": "ჯამი {expected} უნდა იყოს ({formula}), ინვოისში კი წერია {found}.",
    "SUM-03.total": "{document}: სტრიქონების ჯამი {expected}-ია ({metric}), ჯამში კი წერია {found}.",
    "CUR-01.mismatch": "დოკუმენტებში სხვადასხვა ვალუტაა: {currencies}.",
    "QTY-01.quantity": "რაოდენობა განსხვავდება: ინვოისში {invoice}, შეფუთვის ფურცელში {packingList}.",
    "QTY-01.line": "პოზიცია {model}: ინვოისში {invoice}, შეფუთვის ფურცელში {packingList}.",
    "QTY-01.missing-line": "პოზიცია {model} {presentIn} არის, {missingIn} კი არა.",
    "QTY-01.packages": "ადგილების რაოდენობა განსხვავდება: {values}.",
    "WGT-01.gross-below-net": "{where}: ბრუტო წონა {gross} კგ ნეტო წონაზე ({net} კგ) ნაკლებია.",
    "WGT-02.gross": "ბრუტო წონა განსხვავდება: {values}.",
    "WGT-02.net": "ნეტო წონა განსხვავდება: {values}.",
    "REF-01.invoice-number": "შეფუთვის ფურცელში მითითებულია ინვოისი {found}, ინვოისის ნომერი კი {expected}-ია.",
    "REF-01.invoice-date": "შეფუთვის ფურცელში ინვოისის თარიღად {found} წერია, ინვოისის თარიღი კი {expected}-ია.",
    "REF-01.contract-number": "ინვოისში მითითებულია ხელშეკრულება {found}, ხელშეკრულების ნომერი კი {expected}-ია.",
    "REF-01.contract-date": "ინვოისში ხელშეკრულების თარიღად {found} წერია, ხელშეკრულების თარიღი კი {expected}-ია.",
    "REF-01.cmr-missing-document": "CMR-ის თანდართულ დოკუმენტებში {document} {number} არ არის მითითებული.",
    "DATE-01.contract-after-invoice": "ხელშეკრულების თარიღი ({contract}) ინვოისის თარიღზე ({invoice}) გვიანია.",
    "DATE-01.invoice-after-shipment": "ინვოისის თარიღი ({invoice}) ტვირთის მიღების თარიღზე ({shipment}) გვიანია.",
    "PTY-01.name": "{role} განსხვავდება: „{a}“ ({aDocument}) და „{b}“ ({bDocument}).",
    "INC-01.mismatch": "Incoterms პირობა განსხვავდება: {codes}.",
    "INC-01.unknown": "„{code}“ Incoterms 2020-ის პირობა არ არის.",
    "INC-02.sea-term-road": "{code} საზღვაო და შიდა წყლის ტრანსპორტის პირობაა, ტვირთი კი CMR-ით, საავტომობილო ტრანსპორტით გადაიზიდება.",
    "INC-03.no-insurance": "{code} პირობით ტვირთს გამყიდველი აზღვევს, დოკუმენტებში კი არც დაზღვევის პოლისია და არც დაზღვევის თანხა.",
    "CMR-01.missing": "CMR-ს აკლია მუხ. 6(1)({item}): {particular}.",
    "DOC-01.missing": "აკლია დოკუმენტი: {document}.",
    "DOC-01.multiple": "{document}: {count} {docs}; შედარებისას პირველი გამოიყენება.",
    "DOC-01.multiple-invoices-declaration": "{document}: {count} {docs}. დეკლარაციასთან შედარებისას ყველა ინვოისის HS კოდების პირველი ექვსი ციფრი, ვალუტა და ჯამი მოწმდება.",
    "HS-01.unreadable": "სტრიქონი {line}: HS კოდი ვერ იკითხება.",
    "HS-01.unknown-subheading": "სტრიქონი {line}: სასაქონლო სუბპოზიცია {subheading} საქართველოს სასაქონლო ნომენკლატურაში (№21 ბრძანების პირვანდელ ტექსტში) არ არის. შემდგომი ცვლილებები არ შემოწმებულა.",
    "HS-01.unknown-subheading-heading": "სტრიქონი {line}: სასაქონლო სუბპოზიცია {subheading} საქართველოს სასაქონლო ნომენკლატურაში (№21 ბრძანების პირვანდელ ტექსტში) არ არის. შემდგომი ცვლილებები არ შემოწმებულა. უახლოესი სასაქონლო პოზიცია: {heading} · {description}",
    "HS-01.unknown-national": "სტრიქონი {line}: ეროვნული კოდი {code} საქართველოს სასაქონლო ნომენკლატურაში (№21 ბრძანების პირვანდელ ტექსტში) არ არის. შემდგომი ცვლილებები არ შემოწმებულა. კოდები {subheading}-ის ფარგლებში: {neighbours}",
    "PTY-02.unreadable": "„{name}“: საიდენტიფიკაციო ნომერი ვერ იკითხება.",
    "PTY-02.number": "„{name}“: საიდენტიფიკაციო ნომერი განსხვავდება: „{a}“ და „{b}“.",
    "TAX-01.name": "დაბეჭდილი სახელი „{printed}“ განსხვავდება შემოსავლების სამსახურის {snapshotDate}-ის ჩანაწერში მითითებული სახელისგან „{registered}“.",
    "TAX-02.vat": "ინვოისში გადასახადი დარიცხულია, შემოსავლების სამსახურის ჩანაწერით კი {code} არ არის დღგ-ის გადამხდელი {checkedAt} მომენტისთვის. სტატუსი ჩანაწერის დროს ასახავს და არა ინვოისის თარიღს.",
    "TAX-03.reply": "შემოსავლების სამსახურის პასუხი {code} კოდზე: „{reply}“",
    "REF-01.declaration-missing-invoice": "საბაჟო დეკლარაციის თანდართულ დოკუმენტებში (გრაფა 44) ინვოისი {number} არ არის მითითებული.",
    "DATE-01.invoice-after-declaration": "ინვოისის თარიღი ({invoice}) დეკლარაციის რეგისტრაციის თარიღზე ({registration}) გვიანია.",
    "DEC-01.tax-id": "{role}: ინვოისში საიდენტიფიკაციო ნომერია {invoice}, დეკლარაციაში კი წერია {declaration}.",
    "DEC-01.name": "{role}: ინვოისში წერია {invoice}, დეკლარაციაში კი {declaration}.",
    "DEC-02.unreadable": "საქონელი {line}: HS კოდი 11-ნიშნა ეროვნულ კოდად ვერ იკითხება.",
    "DEC-02.invoice-prefix": "ინვოისის სტრიქონი {line}: კოდის {code} პირველი ექვსი ციფრი დეკლარაციის არცერთ კოდს არ ემთხვევა.",
    "DEC-02.declaration-prefix": "დეკლარაციის საქონელი {line}: კოდის {code} პირველი ექვსი ციფრი ინვოისების არცერთ კოდს არ ემთხვევა.",
    "DEC-03.gross": "დეკლარირებული საქონლის საერთო ბრუტო წონაა {found}, {documentIn} კი {expected}.",
    "DEC-03.net": "დეკლარირებული საქონლის საერთო ნეტო წონაა {found}, {documentIn} კი {expected}.",
    "DEC-04.packages": "დეკლარაციაში შეფუთვების რაოდენობაა {found}, {documentIn} კი {expected}.",
    "DEC-05.currency": "გრაფა 22-ში ვალუტაა {found}, ინვოისებში კი {expected}.",
    "DEC-05.invoice-total": "გრაფა 22-ში თანხაა {found}, ინვოისის ჯამი კი {expected}.",
    "DEC-05.item-total": "გრაფა 42-ში თანხების ჯამია {found}, გრაფა 22-ში კი {expected} წერია.",
    "DEC-06.origin": "საქონელი {line}: დეკლარაციაში წარმოშობაა {declaration}, ინვოისში კი {invoice}.",
    "DEC-06.unestablished": "საქონელი {line}: გრაფა 34ა-ში წერია კოდი 999 (წარმოშობა დაუდგენელია).",
    "DEC-02.unknown-national": "საქონელი {line}: ეროვნული კოდი {code} საქართველოს სასაქონლო ნომენკლატურაში (№21 ბრძანების პირვანდელ ტექსტში) არ არის. შემდგომი ცვლილებები არ შემოწმებულა. კოდები {subheading}-ის ფარგლებში: {neighbours}",
    "DEC-02.unknown-national-heading": "საქონელი {line}: ეროვნული კოდი {code} საქართველოს სასაქონლო ნომენკლატურაში (№21 ბრძანების პირვანდელ ტექსტში) არ არის. შემდგომი ცვლილებები არ შემოწმებულა. უახლოესი სასაქონლო პოზიცია: {heading} · {description}",
    "DEC-02.unknown-national-alone": "საქონელი {line}: ეროვნული კოდი {code} საქართველოს სასაქონლო ნომენკლატურაში (№21 ბრძანების პირვანდელ ტექსტში) არ არის. შემდგომი ცვლილებები არ შემოწმებულა.",
  },
  ru: {
    "AMT-01.mismatch": "Прописью указано {wordsAmount}, а цифрами — {amount}.",
    "AMT-01.currency": "Сумма прописью в валюте {wordsCurrency}, а валюта документа — {currency}.",
    "AMT-01.unreadable": "Не удалось прочитать сумму прописью: {reason}.",
    "SUM-01.line": "Строка {line}: {quantity} × {unitPrice} = {expected}, а в сумме строки указано {found}.",
    "SUM-02.subtotal": "Сумма строк — {expected}, а стоимость товара указана {found}.",
    "SUM-02.total": "Ожидаемый итог {expected} ({formula}), а в инвойсе указано {found}.",
    "SUM-03.total": "{document}: сумма строк {expected} ({metric}), а в итоге указано {found}.",
    "CUR-01.mismatch": "В документах разные валюты: {currencies}.",
    "QTY-01.quantity": "Количество различается: в инвойсе {invoice}, в упаковочном листе {packingList}.",
    "QTY-01.line": "Позиция {model}: в инвойсе {invoice}, в упаковочном листе {packingList}.",
    "QTY-01.missing-line": "Позиция {model} есть {presentIn}, но её нет {missingIn}.",
    "QTY-01.packages": "Число мест различается: {values}.",
    "WGT-01.gross-below-net": "{where}: вес брутто {gross} кг меньше веса нетто {net} кг.",
    "WGT-02.gross": "Вес брутто различается: {values}.",
    "WGT-02.net": "Вес нетто различается: {values}.",
    "REF-01.invoice-number": "Упаковочный лист ссылается на инвойс {found}, а номер инвойса — {expected}.",
    "REF-01.invoice-date": "В упаковочном листе дата инвойса {found}, а инвойс датирован {expected}.",
    "REF-01.contract-number": "Инвойс ссылается на договор {found}, а номер договора — {expected}.",
    "REF-01.contract-date": "В инвойсе дата договора {found}, а договор датирован {expected}.",
    "REF-01.cmr-missing-document": "Среди прилагаемых документов CMR не указан {document} {number}.",
    "DATE-01.contract-after-invoice": "Дата договора ({contract}) позже даты инвойса ({invoice}).",
    "DATE-01.invoice-after-shipment": "Дата инвойса ({invoice}) позже даты принятия груза ({shipment}).",
    "PTY-01.name": "{role} различается: «{a}» ({aDocument}) и «{b}» ({bDocument}).",
    "INC-01.mismatch": "Условия Инкотермс различаются: {codes}.",
    "INC-01.unknown": "«{code}» не является правилом Инкотермс 2020.",
    "INC-02.sea-term-road": "{code} — правило для морского и внутреннего водного транспорта, а груз идёт автомобилем по CMR.",
    "INC-03.no-insurance": "По условию {code} груз страхует продавец, но в документах нет ни страхового полиса, ни суммы страхования.",
    "CMR-01.missing": "В CMR нет реквизита ст. 6(1)({item}): {particular}.",
    "DOC-01.missing": "Нет документа: {document}.",
    "DOC-01.multiple": "{document}: {count} {docs}; при сверке используется первый.",
    "DOC-01.multiple-invoices-declaration": "{document}: {count} {docs}. При сверке с декларацией учитываются префиксы кодов ТН ВЭД, валюта и суммы всех инвойсов.",
    "HS-01.unreadable": "Строка {line}: не удалось прочитать код ТН ВЭД.",
    "HS-01.unknown-subheading": "Строка {line}: субпозиции {subheading} нет в грузинской номенклатуре (приказ № 21, первоначальная редакция). Последующие изменения не проверялись.",
    "HS-01.unknown-subheading-heading": "Строка {line}: субпозиции {subheading} нет в грузинской номенклатуре (приказ № 21, первоначальная редакция). Последующие изменения не проверялись. Ближайшая позиция: {heading} · {description}",
    "HS-01.unknown-national": "Строка {line}: национального кода {code} нет в грузинской номенклатуре (приказ № 21, первоначальная редакция). Последующие изменения не проверялись. Коды в субпозиции {subheading}: {neighbours}",
    "PTY-02.unreadable": "Не удалось прочитать налоговый номер стороны «{name}».",
    "PTY-02.number": "Налоговый номер стороны «{name}» различается: «{a}» и «{b}».",
    "TAX-01.name": "Напечатанное название «{printed}» отличается от названия «{registered}» в данных Службы доходов от {snapshotDate}.",
    "TAX-02.vat": "В инвойсе начислен налог, а по данным Службы доходов на {checkedAt} код {code} не является плательщиком НДС. Статус указан на момент запроса, а не на дату инвойса.",
    "TAX-03.reply": "Ответ Службы доходов для кода {code}: «{reply}»",
    "REF-01.declaration-missing-invoice": "В перечне приложенных документов таможенной декларации (графа 44) не указан инвойс {number}.",
    "DATE-01.invoice-after-declaration": "Дата инвойса ({invoice}) позже даты регистрации декларации ({registration}).",
    "DEC-01.tax-id": "Для стороны «{role}» в инвойсе указан идентификационный номер {invoice}, а в декларации — {declaration}.",
    "DEC-01.name": "Для стороны «{role}» в инвойсе указано имя {invoice}, а в декларации — {declaration}.",
    "DEC-02.unreadable": "Товар {line}: не удалось прочитать 11-значный национальный код ТН ВЭД.",
    "DEC-02.invoice-prefix": "Строка инвойса {line}: для кода {code} не найден совпадающий шестизначный префикс в декларации.",
    "DEC-02.declaration-prefix": "Товар декларации {line}: для кода {code} не найден совпадающий шестизначный префикс в инвойсах.",
    "DEC-03.gross": "Общий вес брутто заявленных товаров — {found}, а {documentIn} — {expected}.",
    "DEC-03.net": "Общий вес нетто заявленных товаров — {found}, а {documentIn} — {expected}.",
    "DEC-04.packages": "В декларации {found} грузовых мест, а {documentIn} — {expected}.",
    "DEC-05.currency": "В графе 22 указана валюта {found}, а в инвойсах — {expected}.",
    "DEC-05.invoice-total": "В графе 22 указана сумма {found}, а итог инвойса — {expected}.",
    "DEC-05.item-total": "Сумма значений графы 42 составляет {found}, а в графе 22 указано {expected}.",
    "DEC-06.origin": "Товар {line}: в декларации указано происхождение {declaration}, а в инвойсе — {invoice}.",
    "DEC-06.unestablished": "Товар {line}: в графе 34а указан код 999 (происхождение не установлено).",
    "DEC-02.unknown-national": "Товар {line}: национального кода {code} нет в грузинской номенклатуре (приказ № 21, первоначальная редакция). Последующие изменения не проверялись. Коды в субпозиции {subheading}: {neighbours}",
    "DEC-02.unknown-national-heading": "Товар {line}: национального кода {code} нет в грузинской номенклатуре (приказ № 21, первоначальная редакция). Последующие изменения не проверялись. Ближайшая позиция: {heading} · {description}",
    "DEC-02.unknown-national-alone": "Товар {line}: национального кода {code} нет в грузинской номенклатуре (приказ № 21, первоначальная редакция). Последующие изменения не проверялись.",
  },
  tr: {
    "AMT-01.mismatch": "Yazıyla {wordsAmount} yazıyor, rakamla tutar ise {amount}.",
    "AMT-01.currency": "Yazıyla tutarın dövizi {wordsCurrency}, belgenin dövizi ise {currency}.",
    "AMT-01.unreadable": "Yazıyla tutar okunamadı: {reason}.",
    "SUM-01.line": "Satır {line}: {quantity} × {unitPrice} = {expected}, satır tutarında ise {found} yazıyor.",
    "SUM-02.subtotal": "Satırların toplamı {expected}, mal bedelinde ise {found} yazıyor.",
    "SUM-02.total": "Beklenen toplam {expected} ({formula}), faturada ise {found} yazıyor.",
    "SUM-03.total": "{document}: satırların toplamı {expected} ({metric}), toplamda ise {found} yazıyor.",
    "CUR-01.mismatch": "Belgelerde farklı dövizler var: {currencies}.",
    "QTY-01.quantity": "Miktar farklı: faturada {invoice}, çeki listesinde {packingList}.",
    "QTY-01.line": "Kalem {model}: faturada {invoice}, çeki listesinde {packingList}.",
    "QTY-01.missing-line": "Kalem {model} {presentIn} var, {missingIn} yok.",
    "QTY-01.packages": "Kap sayısı farklı: {values}.",
    "WGT-01.gross-below-net": "{where}: brüt ağırlık {gross} kg, net ağırlıktan ({net} kg) az.",
    "WGT-02.gross": "Brüt ağırlık farklı: {values}.",
    "WGT-02.net": "Net ağırlık farklı: {values}.",
    "REF-01.invoice-number": "Çeki listesi {found} numaralı faturaya atıf yapıyor, fatura numarası ise {expected}.",
    "REF-01.invoice-date": "Çeki listesinde fatura tarihi {found}, fatura ise {expected} tarihli.",
    "REF-01.contract-number": "Fatura {found} numaralı sözleşmeye atıf yapıyor, sözleşme numarası ise {expected}.",
    "REF-01.contract-date": "Faturada sözleşme tarihi {found}, sözleşme ise {expected} tarihli.",
    "REF-01.cmr-missing-document": "CMR'nin ekli belgeleri arasında {document} {number} yok.",
    "DATE-01.contract-after-invoice": "Sözleşme tarihi ({contract}) fatura tarihinden ({invoice}) sonra.",
    "DATE-01.invoice-after-shipment": "Fatura tarihi ({invoice}) yükleme tarihinden ({shipment}) sonra.",
    "PTY-01.name": "{role} farklı: \"{a}\" ({aDocument}) ve \"{b}\" ({bDocument}).",
    "INC-01.mismatch": "Incoterms farklı: {codes}.",
    "INC-01.unknown": "\"{code}\" bir Incoterms 2020 kuralı değil.",
    "INC-02.sea-term-road": "{code} deniz ve iç su yolu taşımacılığı kuralıdır, eşya ise CMR ile karayoluyla taşınıyor.",
    "INC-03.no-insurance": "{code} teslim şeklinde sigortayı satıcı yaptırır, ancak belgeler arasında ne sigorta poliçesi ne de sigorta bedeli var.",
    "CMR-01.missing": "CMR'de Madde 6(1)({item}) eksik: {particular}.",
    "DOC-01.missing": "Eksik belge: {document}.",
    "DOC-01.multiple": "{document}: {count} {docs}; karşılaştırmada ilki kullanılır.",
    "DOC-01.multiple-invoices-declaration": "{document}: {count} {docs}. Beyannameyle karşılaştırmada tüm faturaların HS kodu önekleri, para birimi ve toplamları kullanılır.",
    "HS-01.unreadable": "Satır {line}: HS kodu okunamadı.",
    "HS-01.unknown-subheading": "Satır {line}: {subheading} alt pozisyonu Gürcistan eşya nomenklatüründe (21 sayılı emrin ilk metni) yer almıyor. Sonraki değişiklikler doğrulanmadı.",
    "HS-01.unknown-subheading-heading": "Satır {line}: {subheading} alt pozisyonu Gürcistan eşya nomenklatüründe (21 sayılı emrin ilk metni) yer almıyor. Sonraki değişiklikler doğrulanmadı. En yakın pozisyon: {heading} · {description}",
    "HS-01.unknown-national": "Satır {line}: {code} ulusal kodu Gürcistan eşya nomenklatüründe (21 sayılı emrin ilk metni) yer almıyor. Sonraki değişiklikler doğrulanmadı. {subheading} alt pozisyonundaki kodlar: {neighbours}",
    "PTY-02.unreadable": "“{name}” için vergi kimlik numarası okunamadı.",
    "PTY-02.number": "“{name}” için vergi kimlik numarası farklı: “{a}” ve “{b}”.",
    "TAX-01.name": "Basılı “{printed}” adı, Gelir İdaresinin {snapshotDate} tarihli kaydındaki “{registered}” adından farklı.",
    "TAX-02.vat": "Faturada vergi eklenmiş, ancak Gelir İdaresi {code} kodunu {checkedAt} itibarıyla KDV mükellefi olarak göstermiyor. Bu durum fatura tarihini değil, sorgulama anını yansıtır.",
    "TAX-03.reply": "{code} için Gelir İdaresinin yanıtı: “{reply}”",
    "REF-01.declaration-missing-invoice": "Gümrük beyannamesinin ekli belgeleri (kutu 44) {number} numaralı faturayı içermiyor.",
    "DATE-01.invoice-after-declaration": "Fatura tarihi ({invoice}) beyannamenin tescil tarihinden ({registration}) sonra.",
    "DEC-01.tax-id": "{role} için faturada vergi numarası {invoice}, beyannamede ise {declaration}.",
    "DEC-01.name": "{role} için faturada {invoice}, beyannamede ise {declaration} yazıyor.",
    "DEC-02.unreadable": "Kalem {line}: HS kodu 11 haneli ulusal kod olarak okunamadı.",
    "DEC-02.invoice-prefix": "Faturanın {line}. satırı: {code} kodunun ilk altı hanesi beyannamede bulunamadı.",
    "DEC-02.declaration-prefix": "Beyannamenin {line}. kalemi: {code} kodunun ilk altı hanesi faturalarda bulunamadı.",
    "DEC-03.gross": "Beyan edilen kalemlerin toplam brüt ağırlığı {found}, {documentIn} ise {expected}.",
    "DEC-03.net": "Beyan edilen kalemlerin toplam net ağırlığı {found}, {documentIn} ise {expected}.",
    "DEC-04.packages": "Beyannamede {found} kap, {documentIn} ise {expected} kap yazıyor.",
    "DEC-05.currency": "22. kutuda para birimi {found}, faturalarda ise {expected}.",
    "DEC-05.invoice-total": "22. kutuda tutar {found}, fatura toplamı ise {expected}.",
    "DEC-05.item-total": "42. kutudaki tutarların toplamı {found}, 22. kutudaki tutar ise {expected}.",
    "DEC-06.origin": "Kalem {line}: beyannamede menşe {declaration}, faturada ise {invoice}.",
    "DEC-06.unestablished": "Kalem {line}: 34a kutusunda 999 kodu (menşe belirlenemedi) yazıyor.",
    "DEC-02.unknown-national": "Kalem {line}: {code} ulusal kodu Gürcistan eşya nomenklatüründe (21 sayılı emrin ilk metni) yer almıyor. Sonraki değişiklikler doğrulanmadı. {subheading} alt pozisyonundaki kodlar: {neighbours}",
    "DEC-02.unknown-national-heading": "Kalem {line}: {code} ulusal kodu Gürcistan eşya nomenklatüründe (21 sayılı emrin ilk metni) yer almıyor. Sonraki değişiklikler doğrulanmadı. En yakın pozisyon: {heading} · {description}",
    "DEC-02.unknown-national-alone": "Kalem {line}: {code} ulusal kodu Gürcistan eşya nomenklatüründe (21 sayılı emrin ilk metni) yer almıyor. Sonraki değişiklikler doğrulanmadı.",
  },
} as const satisfies Record<ReportLanguage, Record<string, string>>;

export type MessageKey = keyof (typeof MESSAGES)["en"];

// Every language must define exactly the English keys.
const _sameKeys: Record<ReportLanguage, Record<MessageKey, string>> = MESSAGES;
void _sameKeys;

/** English texts, kept for callers that only need the source language. */
export const MESSAGES_EN = MESSAGES.en;

const DOC_PARAMS = new Set(["document", "present", "missing", "aDocument", "bDocument"]);

/** Lookup that ignores inherited keys ("constructor", "toString"…). */
function own<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** Decodes a list param: JSON [[documentType, value], …]. */
function pairs(encoded: string): [string, string][] {
  try {
    const parsed: unknown = JSON.parse(encoded);
    return Array.isArray(parsed) ? parsed.map((p) => [String(p?.[0] ?? ""), String(p?.[1] ?? "")]) : [];
  } catch {
    return [];
  }
}

/**
 * Sentence case. Georgian has no letter case in running text (toUpperCase
 * would turn Mkhedruli into Mtavruli), so it is left as is.
 */
function capitalize(text: string, language: ReportLanguage): string {
  if (language === "ka" || text.length === 0) return text;
  return text.charAt(0).toLocaleUpperCase(language) + text.slice(1);
}

const CANONICAL_NUMBER = /^(-?)([0-9]+)(?:\.([0-9]+))?$/;

/**
 * A canonical decimal the way the language writes a number: thousands in
 * groups of three, the language's decimal sign, the printed decimals kept.
 * "15694.00" is "15,694.00" in English, "15 694,00" in Georgian and Russian
 * (a no-break space) and "15.694,00" in Turkish. Text that is not a
 * canonical decimal comes back unchanged.
 */
export function formatNumber(value: string, language: ReportLanguage): string {
  const match = CANONICAL_NUMBER.exec(value);
  if (!match) return value;
  const { group, decimal } = VOCAB[language].number;
  const [, sign = "", whole = "", fraction] = match;
  const grouped = whole.replace(/\B(?=(?:[0-9]{3})+$)/g, group);
  return `${sign}${grouped}${fraction === undefined ? "" : `${decimal}${fraction}`}`;
}

/** A number param as it is shown, with its unit; text that is not a number is escaped like any document text. */
function numberText(kind: NumberKind, value: string, unit: string | undefined, vocab: Vocab, language: ReportLanguage, escape: (text: string) => string): string {
  if (kind === "formula") return escape(value).replace(/[0-9]+(?:\.[0-9]+)?/g, (number) => formatNumber(number, language));
  if (!CANONICAL_NUMBER.test(value)) return escape(value);
  const shown = formatNumber(value, language);
  if (kind === "kg") return `${shown} ${vocab.kg}`;
  return kind === "money" && unit ? `${shown} ${escape(unit)}` : shown;
}

function localize(name: string, value: string, vocab: Vocab, language: ReportLanguage, escape: (text: string) => string, kind?: NumberKind): string {
  const docLabel = (code: string) => own<string>(vocab.doc, code) ?? code;
  if (DOC_PARAMS.has(name)) return escape(docLabel(value));
  if (name === "metric") return escape(own<string>(vocab.metric, value) ?? value);
  if (name === "role") return escape(own<string>(vocab.role, value) ?? value);
  if (name === "values") {
    const listed = (doc: string) => (vocab.listIn ? own<string>(vocab.docIn, doc) : undefined) ?? docLabel(doc);
    if (!kind) return escape(pairs(value).map(([doc, v]) => `${listed(doc)} ${v}`).join(", "));
    return pairs(value).map(([doc, v]) => `${escape(listed(doc))} ${numberText(kind, v, undefined, vocab, language, escape)}`).join(", ");
  }
  if (name === "currencies" || name === "codes") return escape(pairs(value).map(([doc, v]) => `${v} (${docLabel(doc)})`).join(", "));
  if (name === "where") {
    const [doc = "", part, n] = value.split(":");
    const capital = capitalize(docLabel(doc), language);
    if (part === "total") return escape(`${capital}, ${vocab.total}`);
    if (part === "line") return escape(`${capital}, ${vocab.line} ${n}`);
    return escape(capital);
  }
  return escape(value);
}

/** A date the way the language writes it: "5 October 2026" in English, 05.10.2026 in Georgian, Russian and Turkish. */
export function formatDate(iso: string, language: ReportLanguage): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match || !isIsoDate(iso)) return iso;
  const [, year, month, day] = match;
  const { months } = VOCAB[language];
  return months ? `${Number(day)} ${months[Number(month) - 1]} ${year}` : `${day}.${month}.${year}`;
}

/**
 * What a CMR-01 finding says is missing: the parts of the particular that are
 * ("address of the carrier"), or the whole particular when all of it is, or
 * when the fields are not ones this table knows.
 */
function particularText(item: string, fields: string | undefined, vocab: Vocab): string {
  const whole = own(vocab.particular, item) ?? item;
  const parts = own(CMR_PARTS, item);
  if (!parts || fields === undefined) return whole;
  // "goods[1].description" -> "goods.description": the line does not change the wording.
  const missing = [...new Set(fields.split(", ").map((field) => field.replace(/\[[^\]]*\]/g, "")))];
  const known = (field: string): field is CmrPart => (parts as readonly string[]).includes(field);
  if (!missing.every(known) || parts.every((part) => missing.includes(part))) return whole;
  return missing.map((field) => vocab.cmrField[field]).join(", ");
}

/** Which noun form follows the number `count`. */
export function pluralCategory(count: number, language: ReportLanguage): keyof PluralForms {
  if (language === "ru") {
    const tens = count % 100;
    const ones = count % 10;
    if (ones === 1 && tens !== 11) return "one";
    if (ones >= 2 && ones <= 4 && (tens < 12 || tens > 14)) return "few";
    return "many";
  }
  return count === 1 ? "one" : "many";
}

/** "1 document", "3 документа", "5 документов". */
export function countDocuments(count: number, language: ReportLanguage): string {
  return `${count} ${VOCAB[language].documentCount[pluralCategory(count, language)]}`;
}

/**
 * Renders a finding message in the given language. `escape` is applied to
 * every value taken from the params (document text), not to the template.
 * `units` is the finding's own: the currency of each money param the rule
 * knows it for.
 */
export function formatMessage(
  key: MessageKey,
  params: Record<string, string>,
  language: ReportLanguage = "en",
  escape: (text: string) => string = (text) => text,
  units: Readonly<Record<string, string>> = {},
): string {
  const vocab = VOCAB[language];
  const values: Record<string, string> = {};
  const dates = own(DATE_PARAMS, key) ?? [];
  const numbers = own(NUMBER_PARAMS, key) ?? {};
  for (const [name, value] of Object.entries(params)) {
    const kind = own(numbers, name);
    if (dates.includes(name)) values[name] = escape(formatDate(value, language));
    else if (kind && name !== "values") values[name] = numberText(kind, value, own(units, name), vocab, language, escape);
    else values[name] = localize(name, value, vocab, language, escape, kind);
    if (DOC_PARAMS.has(name)) values[`${name}In`] = escape(own<string>(vocab.docIn, value) ?? value);
  }
  if (params.item) values.particular = particularText(params.item, params.fields, vocab);
  if (params.reason !== undefined) {
    const reason = own<string>(vocab.reason, params.reason) ?? values.reason!;
    values.reason = reason.replace(/\{word\}/g, () => values.word ?? "");
  }
  if (params.count !== undefined && /^\d+$/.test(params.count)) {
    values.docs = vocab.documentCount[pluralCategory(Number(params.count), language)];
  }
  const text = MESSAGES[language][key].replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match);
  // A localized label may open the message ("packing list: …").
  return capitalize(text, language);
}
