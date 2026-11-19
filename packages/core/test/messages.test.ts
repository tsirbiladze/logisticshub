/**
 * Every finding message and every extraction issue, produced by its rule from
 * the Georgian test pack and read in all four languages. The two tables are
 * typed by the key lists, so a new message key or issue code without a case
 * here fails the typecheck, and the first test fails if a table falls behind.
 */
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
  renderMarkdown,
  renderReports,
  REPORT_LANGUAGES,
  RULE_CHECKS,
  RULE_IDS,
  RULE_SUMMARIES_KA,
  RULE_TITLES,
  UI,
  VOCAB,
  type Cmr,
  type CommercialInvoice,
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
  invoice: CommercialInvoice;
  pl: PackingList;
  cmr: Cmr;
  contract: Contract;
}

function docs(): Docs {
  const pack = kaPack();
  const [invoice, pl, cmr, contract] = pack.documents as [CommercialInvoice, PackingList, Cmr, Contract];
  return { pack, invoice, pl, cmr, contract };
}

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
};

const KEYS = Object.keys(MESSAGES.en) as MessageKey[];

describe("finding messages", () => {
  it("every message key has a case and a reading in four languages", () => {
    expect(Object.keys(CASES).sort()).toEqual([...KEYS].sort());
    expect(Object.keys(EXPECTED).sort()).toEqual([...KEYS].sort());
    for (const language of REPORT_LANGUAGES) expect(Object.keys(MESSAGES[language]).sort()).toEqual([...KEYS].sort());
  });

  it.each(KEYS)("%s: its rule reports it, and it reads as a sentence in every language", (key) => {
    const d = docs();
    CASES[key](d);
    const finding = checkExtraction(d.pack).find((f) => f.key === key);
    expect(finding, `${key} is not reported`).toBeDefined();
    expect(key.startsWith(`${finding!.rule}.`)).toBe(true);
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
    const d = docs();
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
      ({ contract, pl, cmr }) => {
        // The seller's name is in Latin letters, and names are compared within one script only.
        contract.seller.name = c("Baltic Desk Works");
        contract.buyer.name = c("სხვა მყიდველი");
        pl.shipper.name = c("Northern Shelving Co");
        cmr.sender.name = c("Eastern Cabinet Trade");
      },
    ];
    const seen = new Set<string>();
    for (const change of [...Object.values(CASES), ...more]) {
      const d = docs();
      change(d);
      const result = checkDocuments(d.pack);
      for (const language of REPORT_LANGUAGES) {
        const view = buildReport(result, language);
        for (const finding of [...view.errors, ...view.warnings]) {
          for (const e of finding.evidence) {
            if (e.computed) expect(e.label).toBeNull();
            else expect(e.label, `${finding.key} ${e.documentType} ${e.path} ${language}`).toEqual(expect.any(String));
            if (!e.computed) seen.add(`${e.documentType === "cmr" && e.path === "date" ? "cmr:" : ""}${e.path.replace(/\[[^\]]*\]/g, "")}`);
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
