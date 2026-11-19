/**
 * Every finding message and every extraction issue, produced by its rule from
 * the Georgian test pack and read in all four languages. The two tables are
 * typed by the key lists, so a new message key or issue code without a case
 * here fails the typecheck, and the first test fails if a table falls behind.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  blankDocument,
  buildReport,
  checkDocuments,
  checkExtraction,
  checkLine,
  CMR_PARTS,
  FIELD_LABELS,
  formatDate,
  formatMessage,
  formatNumber,
  KEY_CHECKS,
  MESSAGES,
  type RegistrySnapshot,
  renderMarkdown,
  renderReports,
  REPORT_LANGUAGES,
  RULE_CHECKS,
  RULE_IDS,
  RULE_REFERENCE,
  RULE_SUMMARIES_KA,
  RULE_TITLES,
  UI,
  VOCAB,
  type Cmr,
  type CommercialInvoice,
  type CustomsDeclaration,
  type Contract,
  type Extraction,
  type ExtractionIssueCode,
  type MessageKey,
  type PackingList,
  type ReportLanguage,
} from "../src/index.ts";
import { c, kaPack } from "./support/ka-pack.ts";

interface Docs {
  pack: Extraction;
  registry?: RegistrySnapshot;
  invoice: CommercialInvoice;
  pl: PackingList;
  cmr: Cmr;
  contract: Contract;
}

function docs(key?: MessageKey): Docs {
  const declaration = key === "DOC-01.multiple-invoices-declaration" || key?.startsWith("DEC-") || key?.endsWith("declaration-missing-invoice") || key?.endsWith("invoice-after-declaration");
  const pack = declaration ? JSON.parse(readFileSync(new URL("../../../fixtures/ka-office-furniture/declaration-clean/extraction.json", import.meta.url), "utf8")) as Extraction : kaPack();
  const [invoice, pl, cmr, contract] = pack.documents as [CommercialInvoice, PackingList, Cmr, Contract];
  return { pack, invoice, pl, cmr, contract };
}

function snapshot(id: string): RegistrySnapshot {
  return JSON.parse(readFileSync(new URL(`../../../fixtures/ka-office-furniture/${id}/registry.json`, import.meta.url), "utf8"));
}

const declarationOf = ({ pack }: Docs) => pack.documents[4] as CustomsDeclaration;
const itemOf = (d: Docs) => declarationOf(d).items[0]!;

/** One change to the clean pack per message key: the smallest one that makes its rule report it. */
const CASES: Record<MessageKey, (docs: Docs) => void> = {
  "AMT-01.mismatch": ({ invoice }) => void (invoice.totalInWords = c("ცამეტი ათას ხუთასი ევრო და ნული ცენტი")),
  "AMT-01.currency": ({ invoice }) => void (invoice.totalInWords = c("ცამეტი ათას სამასი აშშ დოლარი")),
  "AMT-01.unreadable": ({ invoice }) => void (invoice.totalInWords = c("ცამეტი ათას ბანანი ევრო")),
  "SUM-01.line": ({ invoice }) => void (invoice.lines[1]!.lineTotal = c("4700.00", "4,700.00")),
  "SUM-02.subtotal": ({ invoice }) => void (invoice.subtotal = c("13000.00", "EUR 13,000.00")),
  "SUM-02.total": ({ invoice }) => void (invoice.freight = c("500.00", "EUR 500.00")),
  "SUM-03.total": ({ pl }) => void (pl.totalGrossWeightKg = c("1850", "1,850 კგ")),
  "CUR-01.mismatch": ({ contract }) => void (contract.currency = c("USD")),
  "QTY-01.quantity": ({ pl }) => void (pl.totalQuantity = c("95")),
  "QTY-01.line": ({ pl }) => {
    pl.lines[0]!.quantity = c("60");
    pl.lines[1]!.quantity = c("50");
    for (const line of pl.lines) line.unit = c("ცალი");
    pl.totalQuantity = c("110");
  },
  "QTY-01.missing-line": ({ pl }) => {
    pl.lines[0]!.quantity = c("60");
    pl.lines[1]!.quantity = c("40");
    for (const line of pl.lines) line.unit = c("ცალი");
    pl.lines[1]!.model = c("AOS-MP9");
  },
  "QTY-01.packages": ({ cmr }) => void (cmr.totalPackages = c("90", "90 ყუთი")),
  "WGT-01.gross-below-net": ({ pl }) => void (pl.lines[1]!.grossWeightKg = c("580")),
  "WGT-02.gross": ({ cmr }) => void (cmr.totalGrossWeightKg = c("1850", "1,850")),
  "WGT-02.net": ({ invoice }) => void (invoice.netWeightKg = c("1700", "1,700 კგ")),
  "REF-01.invoice-number": ({ pl }) => void (pl.invoiceRef.number = c("AOS-INV-2026-0918-02")),
  "REF-01.invoice-date": ({ pl }) => void (pl.invoiceRef.date = c("2026-09-08", "08.09.2026")),
  "REF-01.contract-number": ({ invoice }) => void (invoice.contractRef.number = c("AOS-SC-2026-0915-02")),
  "REF-01.contract-date": ({ invoice }) => void (invoice.contractRef.date = c("2026-09-05", "05.09.2026")),
  "REF-01.cmr-missing-document": ({ cmr }) => void (cmr.attachedDocuments = cmr.attachedDocuments.slice(1)),
  "DATE-01.contract-after-invoice": ({ contract, invoice }) => {
    contract.date = c("2026-10-02", "02.10.2026");
    invoice.contractRef.date = c("2026-10-02", "02.10.2026");
  },
  "DATE-01.invoice-after-shipment": ({ invoice }) => void (invoice.date = c("2026-09-25", "25.09.2026")),
  "PTY-01.name": ({ cmr }) => void (cmr.consignee.name = c("სხვა კომპანია")),
  "INC-01.mismatch": ({ contract }) => void (contract.incoterm.code = c("EXW")),
  "INC-01.unknown": ({ invoice, contract }) => void (invoice.incoterm.code = contract.incoterm.code = c("XYZ")),
  "INC-02.sea-term-road": ({ invoice, contract }) => void (invoice.incoterm.code = contract.incoterm.code = c("FOB")),
  "INC-03.no-insurance": ({ invoice, contract }) => void (invoice.incoterm.code = contract.incoterm.code = c("CIP")),
  "CMR-01.missing": ({ cmr }) => void (cmr.carrier.address = c(null)),
  "DOC-01.missing": ({ pack }) => void (pack.documents = pack.documents.filter((d) => d.type !== "cmr")),
  "DOC-01.multiple": ({ pack }) => void pack.documents.push(blankDocument("commercial_invoice", "invoice-2")),
  "DOC-01.multiple-invoices-declaration": ({ pack }) => void pack.documents.push(blankDocument("commercial_invoice", "invoice-2")),
  "HS-01.unreadable": ({ invoice }) => void (invoice.lines[0]!.hsCode = c("94O310")),
  "HS-01.unknown-subheading": ({ invoice }) => void (invoice.lines[0]!.hsCode = c("999999")),
  "HS-01.unknown-subheading-heading": ({ invoice }) => void (invoice.lines[0]!.hsCode = c("940398")),
  "HS-01.unknown-national": ({ invoice }) => void (invoice.lines[0]!.hsCode = c("94033099999")),
  "PTY-02.unreadable": ({ invoice }) => void (invoice.buyer.taxId = c("90000000?")),
  "PTY-02.number": ({ cmr }) => void (cmr.consignee.taxId = c("900000009")),
  "TAX-01.name": (d) => void (d.registry = snapshot("registry-name-mismatch")),
  "TAX-02.vat": (d) => {
    d.registry = snapshot("registry-vat-mismatch");
    d.invoice.seller = { ...d.invoice.buyer, taxId: c("900000007") };
    d.invoice.tax = c("2394.00", "EUR 2,394.00");
  },
  "TAX-03.reply": (d) => void (d.registry = snapshot("registry-status-minus-one")),
  "REF-01.declaration-missing-invoice": (d) => { declarationOf(d).attachedDocuments = [c("ინვოისი OTHER-1")]; },
  "DATE-01.invoice-after-declaration": (d) => { declarationOf(d).date = c("2026-09-17", "17.09.2026"); },
  "DEC-01.tax-id": (d) => { declarationOf(d).importer.taxId = c("900000009"); },
  "DEC-01.name": (d) => {
    declarationOf(d).importer.taxId = c(null);
    declarationOf(d).importer.name = c("სატესტო მარანი");
  },
  "DEC-02.unreadable": (d) => { itemOf(d).hsCode = c("940310"); },
  "DEC-02.unknown-national": (d) => { itemOf(d).hsCode = c("94033099999"); },
  "DEC-02.unknown-national-heading": (d) => { itemOf(d).hsCode = c("94039899999"); },
  "DEC-02.unknown-national-alone": (d) => { itemOf(d).hsCode = c("99999999999"); },
  "DEC-02.invoice-prefix": (d) => { d.invoice.lines[1]!.hsCode = c("940330"); },
  "DEC-02.declaration-prefix": (d) => {
    declarationOf(d).items.push({ ...structuredClone(itemOf(d)), itemNumber: c("2"), hsCode: c("94033011000") });
  },
  "DEC-03.gross": (d) => { itemOf(d).grossWeightKg = c("1205", "1 205"); },
  "DEC-03.net": (d) => { itemOf(d).netWeightKg = c("1000", "1 000"); },
  "DEC-04.packages": (d) => { declarationOf(d).totalPackages = c("99", "99 ყუთი"); },
  "DEC-05.currency": (d) => { declarationOf(d).currency = c("USD"); },
  "DEC-05.invoice-total": (d) => { declarationOf(d).totalInvoiceAmount = c("13301.00", "13,301.00"); },
  "DEC-05.item-total": (d) => { itemOf(d).invoiceValue = c("13301.00", "13,301.00"); },
  "DEC-06.origin": (d) => { itemOf(d).countryOfOrigin = c("DE"); },
  "DEC-06.unestablished": (d) => { itemOf(d).countryOfOrigin = c("999"); },
};

/** What each case reads as. Read them aloud before changing one: every line is a sentence someone has to act on. */
const EXPECTED: Record<MessageKey, Record<ReportLanguage, string>> = {
  "AMT-01.mismatch": {
    en: "Amount in words reads 13,500.00 EUR, but the amount in figures is 13,300.00 EUR.",
    ka: "სიტყვიერად წერია 13\u00a0500,00 EUR, ციფრებით კი 13\u00a0300,00 EUR.",
    ru: "Прописью указано 13\u00a0500,00 EUR, а цифрами — 13\u00a0300,00 EUR.",
    tr: "Yazıyla 13.500,00 EUR yazıyor, rakamla tutar ise 13.300,00 EUR.",
  },
  "AMT-01.currency": {
    en: "Amount in words is in USD, but the document currency is EUR.",
    ka: "სიტყვიერად თანხა USD-ში წერია, დოკუმენტის ვალუტა კი EUR-ია.",
    ru: "Сумма прописью в валюте USD, а валюта документа — EUR.",
    tr: "Yazıyla tutarın dövizi USD, belgenin dövizi ise EUR.",
  },
  "AMT-01.unreadable": {
    en: "Amount in words could not be read: unknown word \"ბანანი\".",
    ka: "სიტყვიერი თანხა ვერ იკითხება: უცნობი სიტყვა „ბანანი“.",
    ru: "Не удалось прочитать сумму прописью: неизвестное слово «ბანანი».",
    tr: "Yazıyla tutar okunamadı: bilinmeyen kelime \"ბანანი\".",
  },
  "SUM-01.line": {
    en: "Line 2: 40 × 115.00 = 4,600.00 EUR, but the line total is 4,700.00 EUR.",
    ka: "სტრიქონი 2: 40 × 115,00 = 4\u00a0600,00 EUR, სტრიქონის ჯამად კი წერია 4\u00a0700,00 EUR.",
    ru: "Строка 2: 40 × 115,00 = 4\u00a0600,00 EUR, а в сумме строки указано 4\u00a0700,00 EUR.",
    tr: "Satır 2: 40 × 115,00 = 4.600,00 EUR, satır tutarında ise 4.700,00 EUR yazıyor.",
  },
  "SUM-02.subtotal": {
    en: "Line totals add up to 13,300.00 EUR, but the subtotal is 13,000.00 EUR.",
    ka: "სტრიქონების ჯამი 13\u00a0300,00 EUR-ია, საქონლის ღირებულებად კი წერია 13\u00a0000,00 EUR.",
    ru: "Сумма строк — 13\u00a0300,00 EUR, а стоимость товара указана 13\u00a0000,00 EUR.",
    tr: "Satırların toplamı 13.300,00 EUR, mal bedelinde ise 13.000,00 EUR yazıyor.",
  },
  "SUM-02.total": {
    en: "Expected total 13,800.00 EUR (13,300.00 − 0.00 + 500.00), but the invoice total is 13,300.00 EUR.",
    ka: "ჯამი 13\u00a0800,00 EUR უნდა იყოს (13\u00a0300,00 − 0,00 + 500,00), ინვოისში კი წერია 13\u00a0300,00 EUR.",
    ru: "Ожидаемый итог 13\u00a0800,00 EUR (13\u00a0300,00 − 0,00 + 500,00), а в инвойсе указано 13\u00a0300,00 EUR.",
    tr: "Beklenen toplam 13.800,00 EUR (13.300,00 − 0,00 + 500,00), faturada ise 13.300,00 EUR yazıyor.",
  },
  "SUM-03.total": {
    en: "Packing list: lines add up to 1,880 (gross weight, kg), but the stated total is 1,850.",
    ka: "შეფუთვის ფურცელი: სტრიქონების ჯამი 1\u00a0880-ია (ბრუტო, კგ), ჯამში კი წერია 1\u00a0850.",
    ru: "Упаковочный лист: сумма строк 1\u00a0880 (брутто, кг), а в итоге указано 1\u00a0850.",
    tr: "Çeki listesi: satırların toplamı 1.880 (brüt, kg), toplamda ise 1.850 yazıyor.",
  },
  "CUR-01.mismatch": {
    en: "Documents use different currencies: EUR (invoice), USD (contract).",
    ka: "დოკუმენტებში სხვადასხვა ვალუტაა: EUR (ინვოისი), USD (ხელშეკრულება).",
    ru: "В документах разные валюты: EUR (инвойс), USD (договор).",
    tr: "Belgelerde farklı dövizler var: EUR (fatura), USD (sözleşme).",
  },
  "QTY-01.quantity": {
    en: "Quantity differs: invoice 100, packing list 95.",
    ka: "რაოდენობა განსხვავდება: ინვოისში 100, შეფუთვის ფურცელში 95.",
    ru: "Количество различается: в инвойсе 100, в упаковочном листе 95.",
    tr: "Miktar farklı: faturada 100, çeki listesinde 95.",
  },
  "QTY-01.line": {
    en: "Item AOS-MP2: invoice quantity 40, packing list quantity 50.",
    ka: "პოზიცია AOS-MP2: ინვოისში 40, შეფუთვის ფურცელში 50.",
    ru: "Позиция AOS-MP2: в инвойсе 40, в упаковочном листе 50.",
    tr: "Kalem AOS-MP2: faturada 40, çeki listesinde 50.",
  },
  "QTY-01.missing-line": {
    en: "Item AOS-MP2 is in the invoice but not in the packing list.",
    ka: "პოზიცია AOS-MP2 ინვოისში არის, შეფუთვის ფურცელში კი არა.",
    ru: "Позиция AOS-MP2 есть в инвойсе, но её нет в упаковочном листе.",
    tr: "Kalem AOS-MP2 faturada var, çeki listesinde yok.",
  },
  "QTY-01.packages": {
    en: "Number of packages differs: invoice 100, packing list 100, CMR 90.",
    ka: "ადგილების რაოდენობა განსხვავდება: ინვოისში 100, შეფუთვის ფურცელში 100, CMR-ში 90.",
    ru: "Число мест различается: в инвойсе 100, в упаковочном листе 100, в CMR 90.",
    tr: "Kap sayısı farklı: faturada 100, çeki listesinde 100, CMR'de 90.",
  },
  "WGT-01.gross-below-net": {
    en: "Packing list, line 2: gross weight 580 kg is less than net weight 600 kg.",
    ka: "შეფუთვის ფურცელი, სტრიქონი 2: ბრუტო წონა 580 კგ ნეტო წონაზე (600 კგ) ნაკლებია.",
    ru: "Упаковочный лист, строка 2: вес брутто 580 кг меньше веса нетто 600 кг.",
    tr: "Çeki listesi, satır 2: brüt ağırlık 580 kg, net ağırlıktan (600 kg) az.",
  },
  "WGT-02.gross": {
    en: "Gross weight differs: packing list 1,880 kg, CMR 1,850 kg.",
    ka: "ბრუტო წონა განსხვავდება: შეფუთვის ფურცელში 1\u00a0880 კგ, CMR-ში 1\u00a0850 კგ.",
    ru: "Вес брутто различается: в упаковочном листе 1\u00a0880 кг, в CMR 1\u00a0850 кг.",
    tr: "Brüt ağırlık farklı: çeki listesinde 1.880 kg, CMR'de 1.850 kg.",
  },
  "WGT-02.net": {
    en: "Net weight differs: packing list 1,680 kg, invoice 1,700 kg.",
    ka: "ნეტო წონა განსხვავდება: შეფუთვის ფურცელში 1\u00a0680 კგ, ინვოისში 1\u00a0700 კგ.",
    ru: "Вес нетто различается: в упаковочном листе 1\u00a0680 кг, в инвойсе 1\u00a0700 кг.",
    tr: "Net ağırlık farklı: çeki listesinde 1.680 kg, faturada 1.700 kg.",
  },
  "REF-01.invoice-number": {
    en: "Packing list refers to invoice AOS-INV-2026-0918-02, but the invoice number is AOS-INV-2026-0918-01.",
    ka: "შეფუთვის ფურცელში მითითებულია ინვოისი AOS-INV-2026-0918-02, ინვოისის ნომერი კი AOS-INV-2026-0918-01-ია.",
    ru: "Упаковочный лист ссылается на инвойс AOS-INV-2026-0918-02, а номер инвойса — AOS-INV-2026-0918-01.",
    tr: "Çeki listesi AOS-INV-2026-0918-02 numaralı faturaya atıf yapıyor, fatura numarası ise AOS-INV-2026-0918-01.",
  },
  "REF-01.invoice-date": {
    en: "Packing list gives invoice date 8 September 2026, but the invoice is dated 18 September 2026.",
    ka: "შეფუთვის ფურცელში ინვოისის თარიღად 08.09.2026 წერია, ინვოისის თარიღი კი 18.09.2026-ია.",
    ru: "В упаковочном листе дата инвойса 08.09.2026, а инвойс датирован 18.09.2026.",
    tr: "Çeki listesinde fatura tarihi 08.09.2026, fatura ise 18.09.2026 tarihli.",
  },
  "REF-01.contract-number": {
    en: "Invoice refers to contract AOS-SC-2026-0915-02, but the contract number is AOS-SC-2026-0915-01.",
    ka: "ინვოისში მითითებულია ხელშეკრულება AOS-SC-2026-0915-02, ხელშეკრულების ნომერი კი AOS-SC-2026-0915-01-ია.",
    ru: "Инвойс ссылается на договор AOS-SC-2026-0915-02, а номер договора — AOS-SC-2026-0915-01.",
    tr: "Fatura AOS-SC-2026-0915-02 numaralı sözleşmeye atıf yapıyor, sözleşme numarası ise AOS-SC-2026-0915-01.",
  },
  "REF-01.contract-date": {
    en: "Invoice gives contract date 5 September 2026, but the contract is dated 15 September 2026.",
    ka: "ინვოისში ხელშეკრულების თარიღად 05.09.2026 წერია, ხელშეკრულების თარიღი კი 15.09.2026-ია.",
    ru: "В инвойсе дата договора 05.09.2026, а договор датирован 15.09.2026.",
    tr: "Faturada sözleşme tarihi 05.09.2026, sözleşme ise 15.09.2026 tarihli.",
  },
  "REF-01.cmr-missing-document": {
    en: "The CMR's attached documents do not list the invoice AOS-INV-2026-0918-01.",
    ka: "CMR-ის თანდართულ დოკუმენტებში ინვოისი AOS-INV-2026-0918-01 არ არის მითითებული.",
    ru: "Среди прилагаемых документов CMR не указан инвойс AOS-INV-2026-0918-01.",
    tr: "CMR'nin ekli belgeleri arasında fatura AOS-INV-2026-0918-01 yok.",
  },
  "DATE-01.contract-after-invoice": {
    en: "Contract date 2 October 2026 is after the invoice date 18 September 2026.",
    ka: "ხელშეკრულების თარიღი (02.10.2026) ინვოისის თარიღზე (18.09.2026) გვიანია.",
    ru: "Дата договора (02.10.2026) позже даты инвойса (18.09.2026).",
    tr: "Sözleşme tarihi (02.10.2026) fatura tarihinden (18.09.2026) sonra.",
  },
  "DATE-01.invoice-after-shipment": {
    en: "Invoice date 25 September 2026 is after the goods were taken over on 19 September 2026.",
    ka: "ინვოისის თარიღი (25.09.2026) ტვირთის მიღების თარიღზე (19.09.2026) გვიანია.",
    ru: "Дата инвойса (25.09.2026) позже даты принятия груза (19.09.2026).",
    tr: "Fatura tarihi (25.09.2026) yükleme tarihinden (19.09.2026) sonra.",
  },
  "PTY-01.name": {
    en: "Consignee differs: \"ტესტ კომპანია\" (invoice) and \"სხვა კომპანია\" (CMR).",
    ka: "მიმღები განსხვავდება: „ტესტ კომპანია“ (ინვოისი) და „სხვა კომპანია“ (CMR).",
    ru: "Грузополучатель различается: «ტესტ კომპანია» (инвойс) и «სხვა კომპანია» (CMR).",
    tr: "Alıcı (teslim alan) farklı: \"ტესტ კომპანია\" (fatura) ve \"სხვა კომპანია\" (CMR).",
  },
  "INC-01.mismatch": {
    en: "Incoterms differ: FCA (invoice), EXW (contract).",
    ka: "Incoterms პირობა განსხვავდება: FCA (ინვოისი), EXW (ხელშეკრულება).",
    ru: "Условия Инкотермс различаются: FCA (инвойс), EXW (договор).",
    tr: "Incoterms farklı: FCA (fatura), EXW (sözleşme).",
  },
  "INC-01.unknown": {
    en: "\"XYZ\" is not an Incoterms 2020 rule.",
    ka: "„XYZ“ Incoterms 2020-ის პირობა არ არის.",
    ru: "«XYZ» не является правилом Инкотермс 2020.",
    tr: "\"XYZ\" bir Incoterms 2020 kuralı değil.",
  },
  "INC-02.sea-term-road": {
    en: "FOB is a sea and inland waterway rule, but the goods travel by road under a CMR.",
    ka: "FOB საზღვაო და შიდა წყლის ტრანსპორტის პირობაა, ტვირთი კი CMR-ით, საავტომობილო ტრანსპორტით გადაიზიდება.",
    ru: "FOB — правило для морского и внутреннего водного транспорта, а груз идёт автомобилем по CMR.",
    tr: "FOB deniz ve iç su yolu taşımacılığı kuralıdır, eşya ise CMR ile karayoluyla taşınıyor.",
  },
  "INC-03.no-insurance": {
    en: "Under CIP the seller insures the goods, but the documents show neither an insurance policy nor an insurance charge.",
    ka: "CIP პირობით ტვირთს გამყიდველი აზღვევს, დოკუმენტებში კი არც დაზღვევის პოლისია და არც დაზღვევის თანხა.",
    ru: "По условию CIP груз страхует продавец, но в документах нет ни страхового полиса, ни суммы страхования.",
    tr: "CIP teslim şeklinde sigortayı satıcı yaptırır, ancak belgeler arasında ne sigorta poliçesi ne de sigorta bedeli var.",
  },
  "CMR-01.missing": {
    en: "CMR is missing Art. 6(1)(c): address of the carrier.",
    ka: "CMR-ს აკლია მუხ. 6(1)(c): გადამზიდველის მისამართი.",
    ru: "В CMR нет реквизита ст. 6(1)(c): адрес перевозчика.",
    tr: "CMR'de Madde 6(1)(c) eksik: taşıyıcının adresi.",
  },
  "DOC-01.missing": {
    en: "Missing document: CMR.",
    ka: "აკლია დოკუმენტი: CMR.",
    ru: "Нет документа: CMR.",
    tr: "Eksik belge: CMR.",
  },
  "DOC-01.multiple": {
    en: "2 documents of type invoice; cross-checks use the first one.",
    ka: "ინვოისი: 2 დოკუმენტი; შედარებისას პირველი გამოიყენება.",
    ru: "Инвойс: 2 документа; при сверке используется первый.",
    tr: "Fatura: 2 belge; karşılaştırmada ilki kullanılır.",
  },
  "DOC-01.multiple-invoices-declaration": {
    en: "2 documents of type invoice. The declaration checks use all invoices for HS prefixes, currency and totals.",
    ka: "ინვოისი: 2 დოკუმენტი. დეკლარაციასთან შედარებისას ყველა ინვოისის HS კოდების პირველი ექვსი ციფრი, ვალუტა და ჯამი მოწმდება.",
    ru: "Инвойс: 2 документа. При сверке с декларацией учитываются префиксы кодов ТН ВЭД, валюта и суммы всех инвойсов.",
    tr: "Fatura: 2 belge. Beyannameyle karşılaştırmada tüm faturaların HS kodu önekleri, para birimi ve toplamları kullanılır.",
  },
  "HS-01.unreadable": {
    en: "Line 1: the HS code could not be read.",
    ka: "სტრიქონი 1: HS კოდი ვერ იკითხება.",
    ru: "Строка 1: не удалось прочитать код ТН ВЭД.",
    tr: "Satır 1: HS kodu okunamadı.",
  },
  "HS-01.unknown-subheading": {
    en: "Line 1: subheading 999999 is absent from the Georgian nomenclature (Order No. 21, original text). Later amendments were not verified.",
    ka: "სტრიქონი 1: სასაქონლო სუბპოზიცია 999999 საქართველოს სასაქონლო ნომენკლატურაში (№21 ბრძანების პირვანდელ ტექსტში) არ არის. შემდგომი ცვლილებები არ შემოწმებულა.",
    ru: "Строка 1: субпозиции 999999 нет в грузинской номенклатуре (приказ № 21, первоначальная редакция). Последующие изменения не проверялись.",
    tr: "Satır 1: 999999 alt pozisyonu Gürcistan eşya nomenklatüründe (21 sayılı emrin ilk metni) yer almıyor. Sonraki değişiklikler doğrulanmadı.",
  },
  "HS-01.unknown-subheading-heading": {
    en: "Line 1: subheading 940398 is absent from the Georgian nomenclature (Order No. 21, original text). Later amendments were not verified. Nearest heading: 9403 · ავეჯი დანარჩენი და მისი ნაწილები:",
    ka: "სტრიქონი 1: სასაქონლო სუბპოზიცია 940398 საქართველოს სასაქონლო ნომენკლატურაში (№21 ბრძანების პირვანდელ ტექსტში) არ არის. შემდგომი ცვლილებები არ შემოწმებულა. უახლოესი სასაქონლო პოზიცია: 9403 · ავეჯი დანარჩენი და მისი ნაწილები:",
    ru: "Строка 1: субпозиции 940398 нет в грузинской номенклатуре (приказ № 21, первоначальная редакция). Последующие изменения не проверялись. Ближайшая позиция: 9403 · ავეჯი დანარჩენი და მისი ნაწილები:",
    tr: "Satır 1: 940398 alt pozisyonu Gürcistan eşya nomenklatüründe (21 sayılı emrin ilk metni) yer almıyor. Sonraki değişiklikler doğrulanmadı. En yakın pozisyon: 9403 · ავეჯი დანარჩენი და მისი ნაწილები:",
  },
  "HS-01.unknown-national": {
    en: "Line 1: national code 94033099999 is absent from the Georgian nomenclature (Order No. 21, original text). Later amendments were not verified. Codes under 940330: 94033011000 · საწერი მაგიდები; 94033019000 · დანარჩენი; 94033091000 · კარადები, აღჭურვილი კარებით, საკეტებით ან გადასაწევი დაფებით; დოკუმენტების შესანახი კარადები, კარადები კართოტეკებისათვის და სხვა კარადები; 94033099000 · დანარჩენი",
    ka: "სტრიქონი 1: ეროვნული კოდი 94033099999 საქართველოს სასაქონლო ნომენკლატურაში (№21 ბრძანების პირვანდელ ტექსტში) არ არის. შემდგომი ცვლილებები არ შემოწმებულა. კოდები 940330-ის ფარგლებში: 94033011000 · საწერი მაგიდები; 94033019000 · დანარჩენი; 94033091000 · კარადები, აღჭურვილი კარებით, საკეტებით ან გადასაწევი დაფებით; დოკუმენტების შესანახი კარადები, კარადები კართოტეკებისათვის და სხვა კარადები; 94033099000 · დანარჩენი",
    ru: "Строка 1: национального кода 94033099999 нет в грузинской номенклатуре (приказ № 21, первоначальная редакция). Последующие изменения не проверялись. Коды в субпозиции 940330: 94033011000 · საწერი მაგიდები; 94033019000 · დანარჩენი; 94033091000 · კარადები, აღჭურვილი კარებით, საკეტებით ან გადასაწევი დაფებით; დოკუმენტების შესანახი კარადები, კარადები კართოტეკებისათვის და სხვა კარადები; 94033099000 · დანარჩენი",
    tr: "Satır 1: 94033099999 ulusal kodu Gürcistan eşya nomenklatüründe (21 sayılı emrin ilk metni) yer almıyor. Sonraki değişiklikler doğrulanmadı. 940330 alt pozisyonundaki kodlar: 94033011000 · საწერი მაგიდები; 94033019000 · დანარჩენი; 94033091000 · კარადები, აღჭურვილი კარებით, საკეტებით ან გადასაწევი დაფებით; დოკუმენტების შესანახი კარადები, კარადები კართოტეკებისათვის და სხვა კარადები; 94033099000 · დანარჩენი",
  },
  "PTY-02.unreadable": {
    en: "The tax identification number for “ტესტ კომპანია” could not be read.",
    ka: "„ტესტ კომპანია“: საიდენტიფიკაციო ნომერი ვერ იკითხება.",
    ru: "Не удалось прочитать налоговый номер стороны «ტესტ კომპანია».",
    tr: "“ტესტ კომპანია” için vergi kimlik numarası okunamadı.",
  },
  "PTY-02.number": {
    en: "The tax identification number for “ტესტ კომპანია” differs: “900000001” and “900000009”.",
    ka: "„ტესტ კომპანია“: საიდენტიფიკაციო ნომერი განსხვავდება: „900000001“ და „900000009“.",
    ru: "Налоговый номер стороны «ტესტ კომპანია» различается: «900000001» и «900000009».",
    tr: "“ტესტ კომპანია” için vergi kimlik numarası farklı: “900000001” ve “900000009”.",
  },
  "TAX-01.name": {
    en: "The printed name “ტესტ კომპანია” differs from “შპს „სატესტო მარანი“” in the Revenue Service snapshot dated 2026-11-19.",
    ka: "დაბეჭდილი სახელი „ტესტ კომპანია“ განსხვავდება შემოსავლების სამსახურის 2026-11-19-ის ჩანაწერში მითითებული სახელისგან „შპს „სატესტო მარანი““.",
    ru: "Напечатанное название «ტესტ კომპანია» отличается от названия «შპს „სატესტო მარანი“» в данных Службы доходов от 2026-11-19.",
    tr: "Basılı “ტესტ კომპანია” adı, Gelir İdaresinin 2026-11-19 tarihli kaydındaki “შპს „სატესტო მარანი“” adından farklı.",
  },
  "TAX-02.vat": {
    en: "The invoice adds tax, and the Revenue Service lists 900000007 as not a VAT payer at 2026-11-19T10:30:00.000Z. This status is from the snapshot time, not the invoice date.",
    ka: "ინვოისში გადასახადი დარიცხულია, შემოსავლების სამსახურის ჩანაწერით კი 900000007 არ არის დღგ-ის გადამხდელი 2026-11-19T10:30:00.000Z მომენტისთვის. სტატუსი ჩანაწერის დროს ასახავს და არა ინვოისის თარიღს.",
    ru: "В инвойсе начислен налог, а по данным Службы доходов на 2026-11-19T10:30:00.000Z код 900000007 не является плательщиком НДС. Статус указан на момент запроса, а не на дату инвойса.",
    tr: "Faturada vergi eklenmiş, ancak Gelir İdaresi 900000007 kodunu 2026-11-19T10:30:00.000Z itibarıyla KDV mükellefi olarak göstermiyor. Bu durum fatura tarihini değil, sorgulama anını yansıtır.",
  },
  "TAX-03.reply": {
    en: "Revenue Service reply for 900000001: “გადამხდელი არ არის რეგისტრირებული ESERVICES.RS.GE-ზე”",
    ka: "შემოსავლების სამსახურის პასუხი 900000001 კოდზე: „გადამხდელი არ არის რეგისტრირებული ESERVICES.RS.GE-ზე“",
    ru: "Ответ Службы доходов для кода 900000001: «გადამხდელი არ არის რეგისტრირებული ESERVICES.RS.GE-ზე»",
    tr: "900000001 için Gelir İdaresinin yanıtı: “გადამხდელი არ არის რეგისტრირებული ESERVICES.RS.GE-ზე”",
  },
  "REF-01.declaration-missing-invoice": {
    en: "The customs declaration's attached documents (box 44) do not list invoice AOS-INV-2026-0918-01.",
    ka: "საბაჟო დეკლარაციის თანდართულ დოკუმენტებში (გრაფა 44) ინვოისი AOS-INV-2026-0918-01 არ არის მითითებული.",
    ru: "В перечне приложенных документов таможенной декларации (графа 44) не указан инвойс AOS-INV-2026-0918-01.",
    tr: "Gümrük beyannamesinin ekli belgeleri (kutu 44) AOS-INV-2026-0918-01 numaralı faturayı içermiyor.",
  },
  "DATE-01.invoice-after-declaration": {
    en: "Invoice date 18 September 2026 is after the declaration's registration date 17 September 2026.",
    ka: "ინვოისის თარიღი (18.09.2026) დეკლარაციის რეგისტრაციის თარიღზე (17.09.2026) გვიანია.",
    ru: "Дата инвойса (18.09.2026) позже даты регистрации декларации (17.09.2026).",
    tr: "Fatura tarihi (18.09.2026) beyannamenin tescil tarihinden (17.09.2026) sonra.",
  },
  "DEC-01.tax-id": {
    en: "For the Buyer, the invoice gives tax ID 900000001, and the declaration gives 900000009.",
    ka: "მყიდველი: ინვოისში საიდენტიფიკაციო ნომერია 900000001, დეკლარაციაში კი წერია 900000009.",
    ru: "Для стороны «Покупатель» в инвойсе указан идентификационный номер 900000001, а в декларации — 900000009.",
    tr: "Alıcı için faturada vergi numarası 900000001, beyannamede ise 900000009.",
  },
  "DEC-01.name": {
    en: "For the Buyer, the invoice names ტესტ კომპანია, and the declaration names სატესტო მარანი.",
    ka: "მყიდველი: ინვოისში წერია ტესტ კომპანია, დეკლარაციაში კი სატესტო მარანი.",
    ru: "Для стороны «Покупатель» в инвойсе указано имя ტესტ კომპანია, а в декларации — სატესტო მარანი.",
    tr: "Alıcı için faturada ტესტ კომპანია, beyannamede ise სატესტო მარანი yazıyor.",
  },
  "DEC-02.unreadable": {
    en: "Item 1: the HS code could not be read as an 11-digit national code.",
    ka: "საქონელი 1: HS კოდი 11-ნიშნა ეროვნულ კოდად ვერ იკითხება.",
    ru: "Товар 1: не удалось прочитать 11-значный национальный код ТН ВЭД.",
    tr: "Kalem 1: HS kodu 11 haneli ulusal kod olarak okunamadı.",
  },
  "DEC-02.invoice-prefix": {
    en: "Invoice line 2: code 940330 has no matching six-digit prefix on the declaration.",
    ka: "ინვოისის სტრიქონი 2: კოდის 940330 პირველი ექვსი ციფრი დეკლარაციის არცერთ კოდს არ ემთხვევა.",
    ru: "Строка инвойса 2: для кода 940330 не найден совпадающий шестизначный префикс в декларации.",
    tr: "Faturanın 2. satırı: 940330 kodunun ilk altı hanesi beyannamede bulunamadı.",
  },
  "DEC-02.declaration-prefix": {
    en: "Declared item 2: code 94033011000 has no matching six-digit prefix on the invoices.",
    ka: "დეკლარაციის საქონელი 2: კოდის 94033011000 პირველი ექვსი ციფრი ინვოისების არცერთ კოდს არ ემთხვევა.",
    ru: "Товар декларации 2: для кода 94033011000 не найден совпадающий шестизначный префикс в инвойсах.",
    tr: "Beyannamenin 2. kalemi: 94033011000 kodunun ilk altı hanesi faturalarda bulunamadı.",
  },
  "DEC-03.gross": {
    en: "The declared items total 1,205 kg gross, and in the packing list the gross total is 1,250 kg.",
    ka: "დეკლარირებული საქონლის საერთო ბრუტო წონაა 1\u00a0205 კგ, შეფუთვის ფურცელში კი 1\u00a0250 კგ.",
    ru: "Общий вес брутто заявленных товаров — 1\u00a0205 кг, а в упаковочном листе — 1\u00a0250 кг.",
    tr: "Beyan edilen kalemlerin toplam brüt ağırlığı 1.205 kg, çeki listesinde ise 1.250 kg.",
  },
  "DEC-03.net": {
    en: "The declared items total 1,000 kg net, and in the packing list the net total is 1,050 kg.",
    ka: "დეკლარირებული საქონლის საერთო ნეტო წონაა 1\u00a0000 კგ, შეფუთვის ფურცელში კი 1\u00a0050 კგ.",
    ru: "Общий вес нетто заявленных товаров — 1\u00a0000 кг, а в упаковочном листе — 1\u00a0050 кг.",
    tr: "Beyan edilen kalemlerin toplam net ağırlığı 1.000 kg, çeki listesinde ise 1.050 kg.",
  },
  "DEC-04.packages": {
    en: "The declaration gives 99 packages, and in the packing list the count is 100.",
    ka: "დეკლარაციაში შეფუთვების რაოდენობაა 99, შეფუთვის ფურცელში კი 100.",
    ru: "В декларации 99 грузовых мест, а в упаковочном листе — 100.",
    tr: "Beyannamede 99 kap, çeki listesinde ise 100 kap yazıyor.",
  },
  "DEC-05.currency": {
    en: "Box 22 gives currency USD, and the invoices use EUR.",
    ka: "გრაფა 22-ში ვალუტაა USD, ინვოისებში კი EUR.",
    ru: "В графе 22 указана валюта USD, а в инвойсах — EUR.",
    tr: "22. kutuda para birimi USD, faturalarda ise EUR.",
  },
  "DEC-05.invoice-total": {
    en: "Box 22 gives 13,301.00 EUR, and the invoice total is 13,300.00 EUR.",
    ka: "გრაფა 22-ში თანხაა 13\u00a0301,00 EUR, ინვოისის ჯამი კი 13\u00a0300,00 EUR.",
    ru: "В графе 22 указана сумма 13\u00a0301,00 EUR, а итог инвойса — 13\u00a0300,00 EUR.",
    tr: "22. kutuda tutar 13.301,00 EUR, fatura toplamı ise 13.300,00 EUR.",
  },
  "DEC-05.item-total": {
    en: "Box 42 values add up to 13,301.00 EUR, and box 22 gives 13,300.00 EUR.",
    ka: "გრაფა 42-ში თანხების ჯამია 13\u00a0301,00 EUR, გრაფა 22-ში კი 13\u00a0300,00 EUR წერია.",
    ru: "Сумма значений графы 42 составляет 13\u00a0301,00 EUR, а в графе 22 указано 13\u00a0300,00 EUR.",
    tr: "42. kutudaki tutarların toplamı 13.301,00 EUR, 22. kutudaki tutar ise 13.300,00 EUR.",
  },
  "DEC-06.origin": {
    en: "Item 1 gives origin DE, and the invoice gives თურქეთი.",
    ka: "საქონელი 1: დეკლარაციაში წარმოშობაა DE, ინვოისში კი თურქეთი.",
    ru: "Товар 1: в декларации указано происхождение DE, а в инвойсе — თურქეთი.",
    tr: "Kalem 1: beyannamede menşe DE, faturada ise თურქეთი.",
  },
  "DEC-06.unestablished": {
    en: "Item 1: box 34a gives code 999 (origin not established).",
    ka: "საქონელი 1: გრაფა 34ა-ში წერია კოდი 999 (წარმოშობა დაუდგენელია).",
    ru: "Товар 1: в графе 34а указан код 999 (происхождение не установлено).",
    tr: "Kalem 1: 34a kutusunda 999 kodu (menşe belirlenemedi) yazıyor.",
  },
  "DEC-02.unknown-national": {
    en: "Item 1: national code 94033099999 is absent from the Georgian nomenclature (Order No. 21, original text). Later amendments were not verified. Codes under 940330: 94033011000 · საწერი მაგიდები; 94033019000 · დანარჩენი; 94033091000 · კარადები, აღჭურვილი კარებით, საკეტებით ან გადასაწევი დაფებით; დოკუმენტების შესანახი კარადები, კარადები კართოტეკებისათვის და სხვა კარადები; 94033099000 · დანარჩენი",
    ka: "საქონელი 1: ეროვნული კოდი 94033099999 საქართველოს სასაქონლო ნომენკლატურაში (№21 ბრძანების პირვანდელ ტექსტში) არ არის. შემდგომი ცვლილებები არ შემოწმებულა. კოდები 940330-ის ფარგლებში: 94033011000 · საწერი მაგიდები; 94033019000 · დანარჩენი; 94033091000 · კარადები, აღჭურვილი კარებით, საკეტებით ან გადასაწევი დაფებით; დოკუმენტების შესანახი კარადები, კარადები კართოტეკებისათვის და სხვა კარადები; 94033099000 · დანარჩენი",
    ru: "Товар 1: национального кода 94033099999 нет в грузинской номенклатуре (приказ № 21, первоначальная редакция). Последующие изменения не проверялись. Коды в субпозиции 940330: 94033011000 · საწერი მაგიდები; 94033019000 · დანარჩენი; 94033091000 · კარადები, აღჭურვილი კარებით, საკეტებით ან გადასაწევი დაფებით; დოკუმენტების შესანახი კარადები, კარადები კართოტეკებისათვის და სხვა კარადები; 94033099000 · დანარჩენი",
    tr: "Kalem 1: 94033099999 ulusal kodu Gürcistan eşya nomenklatüründe (21 sayılı emrin ilk metni) yer almıyor. Sonraki değişiklikler doğrulanmadı. 940330 alt pozisyonundaki kodlar: 94033011000 · საწერი მაგიდები; 94033019000 · დანარჩენი; 94033091000 · კარადები, აღჭურვილი კარებით, საკეტებით ან გადასაწევი დაფებით; დოკუმენტების შესანახი კარადები, კარადები კართოტეკებისათვის და სხვა კარადები; 94033099000 · დანარჩენი",
  },
  "DEC-02.unknown-national-heading": {
    en: "Item 1: national code 94039899999 is absent from the Georgian nomenclature (Order No. 21, original text). Later amendments were not verified. Nearest heading: 9403 · ავეჯი დანარჩენი და მისი ნაწილები:",
    ka: "საქონელი 1: ეროვნული კოდი 94039899999 საქართველოს სასაქონლო ნომენკლატურაში (№21 ბრძანების პირვანდელ ტექსტში) არ არის. შემდგომი ცვლილებები არ შემოწმებულა. უახლოესი სასაქონლო პოზიცია: 9403 · ავეჯი დანარჩენი და მისი ნაწილები:",
    ru: "Товар 1: национального кода 94039899999 нет в грузинской номенклатуре (приказ № 21, первоначальная редакция). Последующие изменения не проверялись. Ближайшая позиция: 9403 · ავეჯი დანარჩენი და მისი ნაწილები:",
    tr: "Kalem 1: 94039899999 ulusal kodu Gürcistan eşya nomenklatüründe (21 sayılı emrin ilk metni) yer almıyor. Sonraki değişiklikler doğrulanmadı. En yakın pozisyon: 9403 · ავეჯი დანარჩენი და მისი ნაწილები:",
  },
  "DEC-02.unknown-national-alone": {
    en: "Item 1: national code 99999999999 is absent from the Georgian nomenclature (Order No. 21, original text). Later amendments were not verified.",
    ka: "საქონელი 1: ეროვნული კოდი 99999999999 საქართველოს სასაქონლო ნომენკლატურაში (№21 ბრძანების პირვანდელ ტექსტში) არ არის. შემდგომი ცვლილებები არ შემოწმებულა.",
    ru: "Товар 1: национального кода 99999999999 нет в грузинской номенклатуре (приказ № 21, первоначальная редакция). Последующие изменения не проверялись.",
    tr: "Kalem 1: 99999999999 ulusal kodu Gürcistan eşya nomenklatüründe (21 sayılı emrin ilk metni) yer almıyor. Sonraki değişiklikler doğrulanmadı.",
  },
};

const KEYS = Object.keys(MESSAGES.en) as MessageKey[];

describe("finding messages", () => {
  it("every message key has a case and a reading in four languages", () => {
    expect(Object.keys(CASES).sort()).toEqual([...KEYS].sort());
    expect(Object.keys(EXPECTED).sort()).toEqual([...KEYS].sort());
    for (const language of REPORT_LANGUAGES) expect(Object.keys(MESSAGES[language]).sort()).toEqual([...KEYS].sort());
  });

  it.each(KEYS)("%s: its rule reports it, and it reads as a sentence in every language", (key) => {
    const d = docs(key);
    CASES[key](d);
    const finding = checkExtraction(d.pack, d.registry ? { registry: d.registry } : {}).find((f) => f.key === key);
    expect(finding, `${key} is not reported`).toBeDefined();
    expect(key.startsWith(`${finding!.rule}.`)).toBe(true);
    if (key !== "CMR-01.missing") {
      expect(finding!.severity).toBe(RULE_REFERENCE[finding!.rule].findings.find((item) => item.key === key)?.severity);
    }
    for (const language of REPORT_LANGUAGES) {
      const text = formatMessage(key, finding!.params, language, undefined, finding!.units);
      expect(text, `${key} ${language}`).toBe(EXPECTED[key][language]);
      expect(text).not.toMatch(/[{}]/);
    }
  });

  it("says where an item is and where it is not, as a sentence", () => {
    const say = (language: ReportLanguage, present: string, missing: string) => formatMessage("QTY-01.missing-line", { model: "X-1", present, missing }, language);
    expect(say("en", "packing_list", "commercial_invoice")).toBe("Item X-1 is in the packing list but not in the invoice.");
    expect(say("ka", "packing_list", "commercial_invoice")).toBe("პოზიცია X-1 შეფუთვის ფურცელში არის, ინვოისში კი არა.");
    expect(say("ru", "packing_list", "commercial_invoice")).toBe("Позиция X-1 есть в упаковочном листе, но её нет в инвойсе.");
    expect(say("tr", "packing_list", "commercial_invoice")).toBe("Kalem X-1 çeki listesinde var, faturada yok.");
    // Every document type has its "in the …" form, and no language falls back to a bare label.
    for (const language of REPORT_LANGUAGES) {
      expect(Object.keys(VOCAB[language].docIn)).toEqual(Object.keys(VOCAB[language].doc));
      expect(say(language, "cmr", "contract")).toContain(VOCAB[language].docIn.cmr);
    }
  });
});

describe("dates in messages", () => {
  it("are written the way each language writes them", () => {
    expect(formatDate("2026-10-05", "en")).toBe("5 October 2026");
    expect(formatDate("2026-10-05", "ka")).toBe("05.10.2026");
    expect(formatDate("2026-10-05", "ru")).toBe("05.10.2026");
    expect(formatDate("2026-10-05", "tr")).toBe("05.10.2026");
    expect(formatDate("2026-01-31", "en")).toBe("31 January 2026");
    expect(formatDate("2026-12-01", "en")).toBe("1 December 2026");
  });

  it("leave alone what is not a date", () => {
    for (const text of ["2026-02-30", "05.10.2026", "2026-10-5", "", "soon"]) expect(formatDate(text, "en")).toBe(text);
  });

  it("change only the message: params and evidence keep the ISO date", () => {
    const d = docs();
    CASES["REF-01.contract-date"](d);
    const result = checkDocuments(d.pack);
    const view = buildReport(result, "ka");
    expect(view.errors[0]!.message).toContain("05.09.2026 წერია");
    expect(view.errors[0]!.params).toEqual({ expected: "2026-09-15", found: "2026-09-05" });
    expect(view.errors[0]!.evidence[0]).toMatchObject({ value: "2026-09-05", quote: "05.09.2026" });
  });

  it("do not touch a number that only looks like one of the date params", () => {
    // "found" and "expected" are dates in REF-01.*-date and plain values everywhere else.
    expect(formatMessage("SUM-02.subtotal", { expected: "2026-10-05", found: "1" }, "en")).toBe("Line totals add up to 2026-10-05, but the subtotal is 1.");
  });
});

describe("numbers in messages", () => {
  it("are grouped the way each language writes them, with the printed decimals kept", () => {
    const shown = (value: string) => REPORT_LANGUAGES.map((language) => formatNumber(value, language));
    // en, ka, ru, tr. Georgian and Russian group with a no-break space, so a number never breaks over two lines.
    expect(shown("15694.00")).toEqual(["15,694.00", "15\u00a0694,00", "15\u00a0694,00", "15.694,00"]);
    expect(shown("1234567.5")).toEqual(["1,234,567.5", "1\u00a0234\u00a0567,5", "1\u00a0234\u00a0567,5", "1.234.567,5"]);
    expect(shown("1880")).toEqual(["1,880", "1\u00a0880", "1\u00a0880", "1.880"]);
    expect(shown("-5000.00")).toEqual(["-5,000.00", "-5\u00a0000,00", "-5\u00a0000,00", "-5.000,00"]);
    expect(shown("999")).toEqual(["999", "999", "999", "999"]);
    expect(shown("0.5")).toEqual(["0.5", "0,5", "0,5", "0,5"]);
    expect(shown("14.1288")).toEqual(["14.1288", "14,1288", "14,1288", "14,1288"]);
    expect(shown("100000")).toEqual(["100,000", "100\u00a0000", "100\u00a0000", "100.000"]);
  });

  it("leave alone what is not a canonical decimal", () => {
    for (const text of ["", "13,300.00", "1 500", "AOS-MP2", "1e3", "12.", ".5", "+5", "12\n"]) expect(formatNumber(text, "en")).toBe(text);
  });

  it("change only the message: params and expected.json keep the canonical decimal", () => {
    const d = docs();
    CASES["SUM-02.total"](d);
    const result = checkDocuments(d.pack);
    const finding = result.findings.find((f) => f.key === "SUM-02.total")!;
    expect(finding.params).toEqual({ expected: "13800.00", formula: "13300.00 − 0.00 + 500.00", found: "13300.00" });
    expect(finding.units).toEqual({ expected: "EUR", found: "EUR" });
    expect(buildReport(result, "tr").errors[0]!.message).toBe("Beklenen toplam 13.800,00 EUR (13.300,00 − 0,00 + 500,00), faturada ise 13.300,00 EUR yazıyor.");
  });

  it("carry the currency only where the rule knows it", () => {
    // No currency on the invoice: the amounts stand alone.
    const d = docs();
    CASES["SUM-01.line"](d);
    d.invoice.currency = c(null);
    const [finding] = checkExtraction(d.pack).filter((f) => f.key === "SUM-01.line");
    expect(finding!.units).toBeUndefined();
    expect(formatMessage(finding!.key, finding!.params, "en", undefined, finding!.units)).toBe("Line 2: 40 × 115.00 = 4,600.00, but the line total is 4,700.00.");
    // A currency that is not a code is an extraction issue, never a unit.
    const e = docs();
    CASES["SUM-02.subtotal"](e);
    e.invoice.currency = c("€");
    expect(checkExtraction(e.pack).find((f) => f.key === "SUM-02.subtotal")!.units).toBeUndefined();
  });

  it("give the amount in words the currency the words name, and the figures the document's", () => {
    const say = (words: string) => {
      const d = docs();
      d.invoice.totalInWords = c(words);
      const finding = checkExtraction(d.pack).find((f) => f.key === "AMT-01.mismatch")!;
      return formatMessage(finding.key, finding.params, "en", undefined, finding.units);
    };
    expect(say("ცამეტი ათას ხუთასი ევრო")).toBe("Amount in words reads 13,500.00 EUR, but the amount in figures is 13,300.00 EUR.");
    expect(say("ცამეტი ათას ხუთასი აშშ დოლარი")).toBe("Amount in words reads 13,500.00 USD, but the amount in figures is 13,300.00 EUR.");
    // The words name no currency, or one word that two currencies share: only the figures carry one.
    expect(say("ცამეტი ათას ხუთასი")).toBe("Amount in words reads 13,500.00, but the amount in figures is 13,300.00 EUR.");
    expect(say("ცამეტი ათას ხუთასი მანათი")).toBe("Amount in words reads 13,500.00, but the amount in figures is 13,300.00 EUR.");
  });

  it("show a weight with its unit in every list of values", () => {
    const values = JSON.stringify([["packing_list", "22500"], ["cmr", "22050.5"]]);
    expect(formatMessage("WGT-02.gross", { values }, "en")).toBe("Gross weight differs: packing list 22,500 kg, CMR 22,050.5 kg.");
    expect(formatMessage("WGT-02.gross", { values }, "ka")).toBe("ბრუტო წონა განსხვავდება: შეფუთვის ფურცელში 22\u00a0500 კგ, CMR-ში 22\u00a0050,5 კგ.");
    expect(formatMessage("WGT-02.gross", { values }, "ru")).toBe("Вес брутто различается: в упаковочном листе 22\u00a0500 кг, в CMR 22\u00a0050,5 кг.");
    expect(formatMessage("WGT-02.gross", { values }, "tr")).toBe("Brüt ağırlık farklı: çeki listesinde 22.500 kg, CMR'de 22.050,5 kg.");
    expect(formatMessage("QTY-01.packages", { values: JSON.stringify([["commercial_invoice", "1200"], ["cmr", "1150"]]) }, "en")).toBe("Number of packages differs: invoice 1,200, CMR 1,150.");
  });

  it("keep a number whole in report.md: the no-break space survives, document text is still escaped", () => {
    const d = docs();
    CASES["SUM-02.total"](d);
    const md = renderMarkdown(buildReport(checkDocuments(d.pack), "ka"));
    expect(md).toContain("ჯამი 13\u00a0800,00 EUR უნდა იყოს (13\u00a0300,00 − 0,00 + 500,00), ინვოისში კი წერია 13\u00a0300,00 EUR.");
    // A param that is not a number is shown as document text.
    expect(formatMessage("SUM-02.subtotal", { expected: "*1*", found: "2500.00" }, "en", (text) => text.replace(/\*/g, "\\*"), { found: "U*D" })).toBe(
      "Line totals add up to \\*1\\*, but the subtotal is 2,500.00 U\\*D.",
    );
  });
});

describe("CMR-01 names what is missing", () => {
  const say = (item: string, fields: string | undefined, language: ReportLanguage = "en") =>
    formatMessage("CMR-01.missing", fields === undefined ? { item } : { item, fields }, language);

  it("the one part that is missing, not the whole particular", () => {
    expect(say("c", "carrier.address")).toBe("CMR is missing Art. 6(1)(c): address of the carrier.");
    expect(say("c", "carrier.name")).toBe("CMR is missing Art. 6(1)(c): name of the carrier.");
    expect(say("c", "carrier.address", "ka")).toBe("CMR-ს აკლია მუხ. 6(1)(c): გადამზიდველის მისამართი.");
    expect(say("c", "carrier.address", "ru")).toBe("В CMR нет реквизита ст. 6(1)(c): адрес перевозчика.");
    expect(say("c", "carrier.address", "tr")).toBe("CMR'de Madde 6(1)(c) eksik: taşıyıcının adresi.");
    expect(say("d", "placeOfTakingOver, placeOfDelivery")).toBe("CMR is missing Art. 6(1)(d): place of taking over, place of delivery.");
    expect(say("a", "placeOfIssue", "ka")).toBe("CMR-ს აკლია მუხ. 6(1)(a): შედგენის ადგილი.");
  });

  it("the whole particular when all of it is missing", () => {
    expect(say("c", "carrier.name, carrier.address")).toBe("CMR is missing Art. 6(1)(c): name and address of the carrier.");
    expect(say("k", "convention")).toBe("CMR is missing Art. 6(1)(k): statement that the CMR Convention applies.");
    expect(say("f", "goods")).toBe("CMR is missing Art. 6(1)(f): description of the goods and method of packing.");
    expect(say("c", undefined)).toBe("CMR is missing Art. 6(1)(c): name and address of the carrier.");
    expect(say("c", "something.else")).toBe("CMR is missing Art. 6(1)(c): name and address of the carrier.");
  });

  it("a part missing on several goods lines once", () => {
    expect(say("f", "goods[0].packingMethod, goods[2].packingMethod")).toBe("CMR is missing Art. 6(1)(f): method of packing.");
    expect(say("g", "goods[*].marksAndNumbers", "ru")).toBe("В CMR нет реквизита ст. 6(1)(g): маркировка и номера мест.");
    expect(say("f", "goods[0].description, goods[0].packingMethod")).toBe("CMR is missing Art. 6(1)(f): description of the goods and method of packing.");
  });

  it("has a name for every part in every language", () => {
    const parts = Object.values(CMR_PARTS).flat().sort();
    for (const language of REPORT_LANGUAGES) expect(Object.keys(VOCAB[language].cmrField).sort()).toEqual(parts);
    // The rule's own field paths are the ones the table knows.
    const d = docs();
    Object.assign(d.cmr, { date: c(null), placeOfIssue: c("ქაისერი"), placeOfDelivery: c(null) });
    d.cmr.sender.name = c(null);
    d.cmr.consignee.address = c(null);
    d.cmr.goods[1]!.packingMethod = c(null);
    d.cmr.goods[0]!.marksAndNumbers = c(null);
    d.cmr.goods[1]!.marksAndNumbers = c(null);
    const findings = checkExtraction(d.pack).filter((f) => f.rule === "CMR-01");
    expect(findings.map((f) => formatMessage(f.key, f.params, "en").replace("CMR is missing Art. 6(1)", ""))).toEqual([
      "(b): name of the sender.",
      "(d): place of delivery.",
      "(e): address of the consignee.",
      "(f): method of packing.",
      "(g): marks and numbers.",
      "(a): date the CMR was made out.",
    ]);
  });
});

describe("what to check", () => {
  it("every rule has one short line in every language", () => {
    for (const language of REPORT_LANGUAGES) {
      expect(Object.keys(RULE_CHECKS[language])).toEqual([...RULE_IDS]);
      for (const rule of RULE_IDS) {
        const line = RULE_CHECKS[language][rule];
        expect(line, `${rule} ${language}`).toMatch(/^\S.{30,220}\.$/su);
        expect(line).not.toMatch(/[{}\n]|\s{2}/);
      }
    }
  });

  it("reaches every finding of the report, in the report's language", () => {
    const d = docs();
    CASES["SUM-01.line"](d);
    CASES["CMR-01.missing"](d);
    for (const language of REPORT_LANGUAGES) {
      const view = buildReport(checkDocuments(d.pack), language);
      const findings = [...view.errors, ...view.warnings];
      expect(findings.length).toBeGreaterThanOrEqual(3);
      for (const finding of findings) expect(finding.check).toBe(RULE_CHECKS[language][finding.rule]);
    }
  });

  /** The keys whose rule line would send the reader the wrong way, with what each says instead. Read them aloud before changing one. */
  const OWN: Partial<Record<MessageKey, Record<ReportLanguage, string>>> = {
    "AMT-01.currency": {
      en: "Look at the currency the amount in words names and at the currency of the document: one of the two has to be corrected.",
      ka: "ნახე, რომელი ვალუტა წერია სიტყვიერ თანხაში და რომელია დოკუმენტის ვალუტა: ერთ-ერთი გასასწორებელია.",
      ru: "Посмотрите, какая валюта названа в сумме прописью и какова валюта документа: одно из двух нужно исправить.",
      tr: "Yazıyla tutarda geçen dövize ve belgenin dövizine bakın: ikisinden biri düzeltilmeli.",
    },
    "AMT-01.unreadable": {
      en: "Read the amount in words on the document yourself and compare it with the figures: the checker could not read it, so it was not compared with them.",
      ka: "დოკუმენტში სიტყვიერად დაწერილი თანხა თვითონ წაიკითხე და ციფრებს შეადარე: შემმოწმებელმა ის ვერ წაიკითხა, ამიტომ ციფრებთან არ შეუდარებია.",
      ru: "Прочитайте сумму прописью в документе сами и сравните её с цифрами: программа не смогла её прочитать, поэтому с цифрами она не сравнивалась.",
      tr: "Belgedeki yazıyla tutarı kendiniz okuyup rakamlarla karşılaştırın: program bu tutarı okuyamadı, bu yüzden rakamlarla karşılaştırılmadı.",
    },
    "REF-01.cmr-missing-document": {
      en: "Have the document entered among the documents attached to the CMR (box 5), or see whether it is listed there under another number.",
      ka: "ეს დოკუმენტი CMR-ის თანდართული დოკუმენტების სიაში (გრაფა 5) ჩააწერინე, ან ნახე, ხომ არ არის იქ სხვა ნომრით მითითებული.",
      ru: "Попросите внести этот документ в графу 5 CMR (прилагаемые документы) или посмотрите, не указан ли он там под другим номером.",
      tr: "Bu belgeyi CMR'nin ekli belgeler kutusuna (kutu 5) yazdırın ya da orada başka bir numarayla geçip geçmediğine bakın.",
    },
    "INC-01.unknown": {
      en: "Look at the delivery terms on the document: the rule may be misspelled or come from an older edition of Incoterms (DAF, DES, DEQ, DDU, DAT). Have it written as an Incoterms 2020 code.",
      ka: "ნახე მიწოდების პირობა დოკუმენტში: შესაძლოა, შეცდომით წერია ან Incoterms-ის ძველი გამოცემიდანაა (DAF, DES, DEQ, DDU, DAT). Incoterms 2020-ის კოდით ჩააწერინე.",
      ru: "Посмотрите условие поставки в документе: возможно, в нём опечатка или оно взято из старой редакции Инкотермс (DAF, DES, DEQ, DDU, DAT). Попросите указать его кодом Инкотермс 2020.",
      tr: "Belgedeki teslim şekline bakın: yanlış yazılmış ya da Incoterms'in eski bir sürümünden alınmış olabilir (DAF, DES, DEQ, DDU, DAT). Incoterms 2020 koduyla yazdırın.",
    },
    "DOC-01.missing": {
      en: "Add the missing document and run the check again.",
      ka: "ნაკლული დოკუმენტი დაამატე და შემოწმება თავიდან გაუშვი.",
      ru: "Добавьте недостающий документ и запустите проверку снова.",
      tr: "Eksik belgeyi ekleyip kontrolü yeniden çalıştırın.",
    },
    "DOC-01.multiple": {
      en: "See whether the first of them is the one that belongs to this shipment: the other documents were compared with the first one only.",
      ka: "ნახე, მათგან პირველი ნამდვილად ამ ტვირთის დოკუმენტია თუ არა: დანარჩენი დოკუმენტები მხოლოდ პირველს შედარდა.",
      ru: "Посмотрите, относится ли первый из них к этой поставке: остальные документы сверялись только с первым.",
      tr: "Bunlardan ilkinin bu sevkiyata ait olup olmadığına bakın: diğer belgeler yalnızca ilkiyle karşılaştırıldı.",
    },
    "DOC-01.multiple-invoices-declaration": {
      en: "Verify that each invoice belongs to this shipment and appears only once in the set.",
      ka: "გადაამოწმე, რომ ყველა ინვოისი ამ ტვირთს ეკუთვნის და ნაკრებში ერთხელაა ჩასმული.",
      ru: "Убедитесь, что каждый инвойс относится к этой поставке и включён один раз.",
      tr: "Her faturanın bu sevkiyata ait olduğunu ve sette bir kez yer aldığını doğrulayın.",
    },
    "HS-01.unreadable": {
      en: "Read the HS code on the invoice and check the extraction against it.",
      ka: "წაიკითხე HS კოდი ინვოისში და ამოკითხულ მონაცემს შეადარე.",
      ru: "Прочитайте код ТН ВЭД в инвойсе и сверьте его с извлечённым значением.",
      tr: "Faturadaki HS kodunu okuyup çıkarılan değerle karşılaştırın.",
    },
    "REF-01.declaration-missing-invoice": {
      en: "Check the invoice number against box 44 on the declaration.",
      ka: "შეადარე ინვოისის ნომერი დეკლარაციის გრაფა 44-ს.",
      ru: "Сверьте номер инвойса с графой 44 декларации.",
      tr: "Fatura numarasını beyannamenin 44. kutusuyla karşılaştırın.",
    },
    "DATE-01.invoice-after-declaration": {
      en: "Verify the invoice date and the date the declaration was registered.",
      ka: "გადაამოწმე ინვოისის თარიღი და დეკლარაციის რეგისტრაციის თარიღი.",
      ru: "Проверьте дату инвойса и дату регистрации декларации.",
      tr: "Fatura tarihini ve beyannamenin tescil tarihini doğrulayın.",
    },
  };

  it("a finding key has a line of its own where its rule's line would mislead, in every language", () => {
    for (const language of REPORT_LANGUAGES) {
      expect(Object.keys(KEY_CHECKS[language]).sort(), language).toEqual(Object.keys(OWN).sort());
      for (const [key, line] of Object.entries(KEY_CHECKS[language])) {
        expect(line, `${key} ${language}`).toMatch(/^\S.{30,220}\.$/su);
        expect(line).not.toMatch(/[{}\n]|\s{2}/);
      }
    }
    // Four that must keep a line of their own, named here so that none of them drops out with a change to the list above.
    for (const key of ["REF-01.cmr-missing-document", "DOC-01.multiple", "AMT-01.unreadable", "INC-01.unknown"]) expect(Object.keys(KEY_CHECKS.en)).toContain(key);
  });

  it.each(Object.keys(OWN) as MessageKey[])("%s: the report shows the key's own line under the finding, in Markdown, HTML and JSON", (key) => {
    const d = docs(key);
    CASES[key](d);
    const result = checkDocuments(d.pack);
    for (const language of REPORT_LANGUAGES) {
      const view = buildReport(result, language);
      const finding = [...view.errors, ...view.warnings].find((f) => f.key === key)!;
      expect(finding.check, `${key} ${language}`).toBe(OWN[key]![language]);
      expect(finding.check).not.toBe(RULE_CHECKS[language][finding.rule]);
      expect(checkLine(key, finding.rule, language)).toBe(finding.check);
      const reports = renderReports(result, language);
      expect(reports.md).toContain(`\n→ ${finding.check}\n`);
      expect(reports.html).toContain(`<p class="check">→ ${finding.check}</p>`);
      expect((JSON.parse(reports.json) as { findings: { key: string; check: string }[] }).findings.find((f) => f.key === key)!.check).toBe(finding.check);
    }
  });

  it("every other key keeps its rule's line", () => {
    for (const key of KEYS.filter((k) => !(k in OWN))) {
      const rule = key.split(".")[0] as (typeof RULE_IDS)[number];
      for (const language of REPORT_LANGUAGES) expect(checkLine(key, rule, language)).toBe(RULE_CHECKS[language][rule]);
    }
  });
});

describe("evidence labels", () => {
  it("every language names the same fields", () => {
    for (const language of REPORT_LANGUAGES) {
      expect(Object.keys(FIELD_LABELS[language])).toEqual(Object.keys(FIELD_LABELS.en));
      for (const label of Object.values(FIELD_LABELS[language])) expect(label).toMatch(/^\S(.*\S)?$/u);
    }
  });

  it("every piece of evidence a rule cites has a name, in every language", () => {
    // Every message case, plus the paths only a variation reaches.
    const more: ((docs: Docs) => void)[] = [
      ({ pack }) => {
        const a = blankDocument("customs_declaration", "declaration");
        const b = blankDocument("customs_declaration", "declaration-2");
        a.number = c("C-DEMO-1");
        b.number = c("C-DEMO-2");
        pack.documents.push(a, b);
      },
      ({ cmr, invoice }) => {
        cmr.dateOfTakingOver = c(null);
        invoice.date = c("2026-09-25", "25.09.2026");
      },
      ({ invoice }) => {
        Object.assign(invoice, { discount: c("100.00"), insurance: c("10.00"), otherCharges: [c("5.00")], tax: c("1.00"), freight: c("2.00") });
      },
      ({ invoice }) => void Object.assign(invoice, { netWeightKg: c("1700"), grossWeightKg: c("1600") }),
      ({ pl }) => void Object.assign(pl, { totalQuantity: c("7"), totalVolumeM3: c("1.5"), totalNetWeightKg: c("1"), totalPackages: c("3") }),
      ({ contract }) => void (contract.totalInWords = c("ცამეტი ათას ხუთასი ევრო")),
      ({ invoice, cmr, pl }) => {
        for (const party of [invoice.seller, cmr.sender, cmr.carrier, pl.shipper]) party.taxId = c("unreadable");
      },
      ({ contract, pl, cmr }) => {
        // The seller's name is in Latin letters, and names are compared within one script only.
        contract.seller.name = c("Baltic Desk Works");
        contract.buyer.name = c("სხვა მყიდველი");
        pl.shipper.name = c("Northern Shelving Co");
        cmr.sender.name = c("Eastern Cabinet Trade");
      },
    ];
    const exporter: [MessageKey, (docs: Docs) => void][] = [
      ["DEC-01.tax-id", (d) => { declarationOf(d).exporter.taxId = c("TR-900009"); }],
      ["DEC-01.name", (d) => {
        declarationOf(d).exporter.taxId = c(null);
        declarationOf(d).exporter.name = c("Different Exporter Ltd");
      }],
    ];
    const seen = new Set<string>();
    for (const [key, change] of [...KEYS.map((key) => [key, CASES[key]] as const), ...exporter, ...more.map((fn) => [undefined, fn] as const)]) {
      const d = docs(key);
      change(d);
      const result = checkDocuments(d.pack, d.registry ? { registry: d.registry } : {});
      for (const language of REPORT_LANGUAGES) {
        const view = buildReport(result, language);
        for (const finding of [...view.errors, ...view.warnings]) {
          for (const e of finding.evidence) {
            if (e.computed) expect(e.label).toBeNull();
            else expect(e.label, `${finding.key} ${e.documentType} ${e.path} ${language}`).toEqual(expect.any(String));
            if (!e.computed) {
              const key = e.path.replace(/\[[^\]]*\]/g, "");
              const typed = `${e.documentType}:${key}`;
              seen.add(Object.hasOwn(FIELD_LABELS.en, typed) ? typed : key);
            }
          }
        }
      }
    }
    // No name in the table that no rule ever shows.
    expect([...seen].sort()).toEqual(Object.keys(FIELD_LABELS.en).sort());
  });
});

describe("Georgian texts", () => {
  const strings = (value: unknown): string[] =>
    typeof value === "string" ? [value] : value && typeof value === "object" ? Object.values(value).flatMap(strings) : [];
  const georgian = [...strings(MESSAGES.ka), ...strings(VOCAB.ka), ...strings(RULE_TITLES.ka), ...strings(RULE_CHECKS.ka), ...strings(UI.ka), ...strings(RULE_SUMMARIES_KA), ...strings(FIELD_LABELS.ka), ...strings(KEY_CHECKS.ka)];

  it("are never in Mtavruli or Asomtavruli", () => {
    expect(georgian.length).toBeGreaterThan(120);
    // U+1C90–U+1CBF is Mtavruli (Georgian "capitals"), U+10A0–U+10CF Asomtavruli.
    expect(georgian.filter((text) => /[Ა-ᲿႠ-჏]/u.test(text))).toEqual([]);
  });

  it("are not capitalised when a message opens with a document's name", () => {
    expect(formatMessage("SUM-03.total", { document: "packing_list", expected: "1", metric: "packages", found: "2" }, "ka")).toMatch(/^შეფუთვის ფურცელი: /);
    expect(formatMessage("WGT-01.gross-below-net", { where: "commercial_invoice", gross: "1", net: "2" }, "ka")).toMatch(/^ინვოისი: /);
    expect(formatMessage("SUM-03.total", { document: "packing_list", expected: "1", metric: "packages", found: "2" }, "tr")).toMatch(/^Çeki listesi: /);
  });

  it("read as plain Georgian, not office language: one word for “may”, a document that is named and not written, the whole formula", () => {
    expect(UI.ka.extractionIssuesEffect).toBe("შესაძლოა, ხარვეზიანი მნიშვნელობა შემოწმებაში არ მოხვდა და ქვემოთ მოცემული შედეგი არასრულია.");
    expect(RULE_CHECKS.ka["REF-01"]).toBe("ნახე მითითებული დოკუმენტის ნომერი და თარიღი და მითითება გაასწორებინე.");
    expect(MESSAGES.ka["REF-01.cmr-missing-document"]).toBe("CMR-ის თანდართულ დოკუმენტებში {document} {number} არ არის მითითებული.");
    expect(RULE_SUMMARIES_KA["AMT-01"]).toBe("სიტყვიერ თანხას (KA, EN, RU, TR) კითხულობს და ციფრებსა და ვალუტას ადარებს.");
    // SUM-02's formula includes a tax and other charges, so its summary names them too.
    expect(RULE_SUMMARIES_KA["SUM-02"]).toBe("სტრიქონები → საქონლის ღირებულება → გადასახდელი, ფასდაკლების, ხარჯებისა და გადასახადის გათვალისწინებით.");
    // Office language and doubled words the texts no longer use.
    expect(georgian.filter((text) => /მონაწილეობდეს|შესაძლოა არასრული|რომელიც მითითებულია|ციფრებს და ვალუტას/u.test(text))).toEqual([]);
    // The term that waits for a practitioner stays as it was.
    expect(MESSAGES.ka["INC-02.sea-term-road"]).toContain("შიდა წყლის ტრანსპორტის");
  });

  it("use the owner's two terms: შეფუთვის ფურცელი for the packing list, ადგილების რაოდენობა for the number of packages", () => {
    expect(VOCAB.ka.doc.packing_list).toBe("შეფუთვის ფურცელი");
    expect(VOCAB.ka.docIn.packing_list).toBe("შეფუთვის ფურცელში");
    expect(VOCAB.ka.metric.packages).toBe("ადგილების რაოდენობა");
    expect(VOCAB.ka.particular.g).toBe("ადგილების რაოდენობა, მარკირება და ნომრები");
    expect(VOCAB.ka.cmrField.totalPackages).toBe("ადგილების რაოდენობა");
    expect(MESSAGES.ka["QTY-01.packages"]).toBe("ადგილების რაოდენობა განსხვავდება: {values}.");
    expect(FIELD_LABELS.ka.packages).toBe("ადგილების რაოდენობა");
    expect(FIELD_LABELS.ka.totalPackages).toBe("ადგილების საერთო რაოდენობა");
    expect(RULE_TITLES.ka["SUM-03"]).toBe("შეფუთვის ფურცლისა და CMR-ის ჯამები");
    expect(RULE_TITLES.ka["QTY-01"]).toBe("საქონლისა და ადგილების რაოდენობა");
    // The words they replace are in no Georgian text: "შეფუთვის სია" in any case form, "შეფუთვის რაოდენობა",
    // and a bare "შეფუთვა" for the count. The packing itself keeps its word (შეფუთვის სახე, შეფუთვასაც).
    expect(georgian.filter((text) => /შეფუთვის სი[აი]|შეფუთვის (?:საერთო )?რაოდენობ|^შეფუთვა$|რაოდენობა და შეფუთვა/u.test(text))).toEqual([]);
    // "ფურცელი" loses its vowel in the genitive: ფურცლის, never ფურცელის.
    expect(georgian.filter((text) => /ფურცელის|ფურცელით/u.test(text))).toEqual([]);
  });

  it("call a table row სტრიქონი, a document დოკუმენტი, and do not speak as “I”", () => {
    // ხაზ-: a drawn line. საბუთ-: a second word for "document". ამოღებ-: seizure, in customs language. ურთიერთ-: coined compounds.
    expect(georgian.filter((text) => /ხაზ|საბუთ|ამოღებ|ურთიერთ|ჯამურ/u.test(text))).toEqual([]);
    // First person singular of the verbs the texts used to use ("I could not read", "I could not find").
    expect(georgian.filter((text) => /ვერ წავიკითხე|ვერ ვიპოვე/u.test(text))).toEqual([]);
  });
});

/** One change per extraction issue code (EXT_MODEL belongs to the CLI's model calls and has its own tests there). */
const ISSUE_CASES: Record<Exclude<ExtractionIssueCode, "EXT_MODEL">, { change: (docs: Docs) => void; path: string; message: string; ok: boolean }> = {
  EXT_SHAPE: {
    change: ({ invoice }) => void delete (invoice as Partial<CommercialInvoice>).total,
    path: "documents[0].total",
    message: 'Missing. Write { "value": null, "quote": null, "page": null } when the document does not print it.',
    ok: false,
  },
  EXT_DUPLICATE_ID: { change: ({ invoice, pl }) => void (pl.id = invoice.id), path: "documents[1].id", message: 'Duplicate document id "invoice-1".', ok: true },
  EXT_DECIMAL_FORMAT: {
    change: ({ invoice }) => void (invoice.total = c("13,300.00", "EUR 13,300.00")),
    path: "documents[0].total",
    message: '"13,300.00" is not a canonical decimal like 13300.00.',
    ok: true,
  },
  EXT_DATE_FORMAT: { change: ({ invoice }) => void (invoice.date = c("18.09.2026")), path: "documents[0].date", message: '"18.09.2026" is not a valid YYYY-MM-DD date.', ok: true },
  EXT_CURRENCY_FORMAT: { change: ({ invoice }) => void (invoice.currency = c("€")), path: "documents[0].currency", message: '"€" is not an ISO 4217 code like EUR.', ok: true },
  EXT_QUOTE_MISMATCH: {
    change: ({ pl }) => void (pl.totalGrossWeightKg = c("1.880", "1,880 კგ")),
    path: "documents[1].totalGrossWeightKg",
    message: '"1.880" does not match the quote "1,880 კგ": this document writes decimals with "." (as in "9.0619"), so the quote reads 1880.',
    ok: true,
  },
  EXT_PERCENTAGE: {
    change: ({ invoice }) => void (invoice.discount = c("5", "5%")),
    path: "documents[0].discount",
    message: '"5" is a percentage in the quote "5%", and this field takes an amount. Give the printed amount, or null when only a rate is printed.',
    ok: true,
  },
  EXT_UNCITED: { change: ({ invoice }) => void (invoice.lines[0]!.unitPrice.quote = " "), path: "documents[0].lines[0].unitPrice", message: "Value has no supporting quote.", ok: true },
  EXT_PAGE: { change: ({ cmr }) => void (cmr.number.page = 0), path: "documents[2].number", message: "Page must be 1 or more, got 0.", ok: true },
};

describe("extraction issues", () => {
  it.each(Object.entries(ISSUE_CASES))("%s: reported with its field and what is wrong", (code, { change, path, message, ok }) => {
    const d = docs();
    change(d);
    const result = checkDocuments(d.pack);
    expect(result.ok).toBe(ok);
    expect(result.extractionIssues).toContainEqual({ code, path, message });
  });

  it("a page below 1 is an issue, a value on it stays in the rules", () => {
    const d = docs();
    d.cmr.totalPackages = c("90", "90 ყუთი", -3);
    const result = checkDocuments(d.pack);
    expect(result.extractionIssues).toEqual([{ code: "EXT_PAGE", path: "documents[2].totalPackages", message: "Page must be 1 or more, got -3." }]);
    expect(result.findings.map((f) => f.key)).toContain("QTY-01.packages");
  });
});
