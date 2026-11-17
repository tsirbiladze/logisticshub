import { STYLES } from "../format.ts";
import { cite, printed, type Pack } from "../model.ts";

/** Russian pack: home textiles, Almaty → Tbilisi by road, USD, CPT. */
export const ruTextile: Pack = {
  spec: {
    id: "ru-textile",
    language: "ru",
    style: STYLES.ru,
    title: { ka: "საოჯახო ტექსტილი · ალმათი → თბილისი", en: "Home textiles · Almaty → Tbilisi" },
    currency: "USD",
    seller: {
      name: "ТОО «Алтын Текстиль»",
      address: "ул. Тимирязева, 42, 050057 Алматы",
      country: "Казахстан",
      registration: "БИН TEST-120540012345",
    },
    buyer: {
      name: "ООО «Колхида Хоум»",
      address: "пр. Руставели, 7, 0108 Тбилиси",
      country: "Грузия",
      registration: "ИН TEST-406060606",
    },
    carrier: {
      name: "ТОО «Шёлковый Путь Транс»",
      address: "пр. Райымбека, 210, Алматы",
      country: "Казахстан",
      registration: "БИН TEST-130640054321",
    },
    incoterm: { code: "CPT", place: "Тбилиси, Грузия", version: "Инкотермс 2020" },
    origin: "Казахстан",
    packagesUnit: "коробок",
    packingListQuantities: true,
    invoice: { number: "AT-2026/118", date: "2026-10-05" },
    packingList: { number: "AT-2026/118-УЛ", date: "2026-10-06" },
    contract: { number: "AT-K-2026/07", date: "2026-09-21", goodsDescription: "Текстильные изделия: махровые полотенца и постельное бельё" },
    cmr: {
      number: "KZ 0471925",
      date: "2026-10-07",
      placeOfIssue: "Алматы",
      takingOverPlace: "ул. Тимирязева, 42, Алматы, Казахстан",
      takingOverDate: "2026-10-07",
      deliveryPlace: "пр. Руставели, 7, Тбилиси, Грузия",
      charges: "Фрахт оплачивает отправитель (CPT)",
      instructions: "Экспортное оформление: Алматы. Импортное оформление: Тбилиси",
      convention:
        "Настоящая перевозка, независимо от любой оговорки об ином, регулируется Конвенцией о договоре международной дорожной перевозки грузов (КДПГ/CMR).",
      attached: ["Инвойс {invoice}", "Упаковочный лист {packingList}"],
    },
    lines: [
      {
        model: "AT-TWL-70",
        description: "Полотенце махровое 70×140 см, хлопок 100%",
        quantity: "2400",
        unit: "шт",
        unitPrice: "4.80",
        packages: "48",
        packing: "коробки",
        netKg: "1440",
        grossKg: "1536",
        volumeM3: "6.72",
        marks: "АТ/118/1-48",
      },
      {
        model: "AT-BED-200",
        description: "Комплект постельного белья 200×220 см, сатин",
        quantity: "600",
        unit: "компл.",
        unitPrice: "15.50",
        packages: "30",
        packing: "коробки",
        netKg: "900",
        grossKg: "960",
        volumeM3: "3.60",
        marks: "АТ/118/49-78",
      },
    ],
    totalInWords: "Двадцать тысяч восемьсот двадцать долларов США 00 центов",
  },
  variants: [
    { id: "clean", title: { ka: "სუფთა ნაკრები", en: "Clean set" }, expected: [] },
    {
      id: "words-mismatch",
      title: { ka: "სიტყვიერი თანხა ციფრებს არ ემთხვევა", en: "Amount in words does not match figures" },
      expected: ["AMT-01.mismatch"],
      mutate: (d) => {
        d.invoice.totalInWords = cite("Двадцать тысяч двести восемьдесят долларов США 00 центов");
      },
    },
    {
      id: "weight-mismatch",
      title: { ka: "CMR-ზე სხვა ბრუტო წონაა", en: "CMR shows a different gross weight" },
      expected: ["WGT-02.gross"],
      mutate: (d, f) => {
        d.cmr.goods[0]!.grossWeightKg = printed(f, "1986");
        d.cmr.totalGrossWeightKg = printed(f, "2946");
      },
    },
    {
      id: "contract-date",
      title: { ka: "ხელშეკრულება ინვოისის შემდეგაა დათარიღებული", en: "Contract dated after the invoice" },
      expected: ["REF-01.contract-date", "DATE-01.contract-after-invoice"],
      mutate: (d, f) => {
        d.contract.date = cite("2026-10-12", f.date("2026-10-12"));
      },
    },
    {
      // The CMR prints its date three times (header, box 4, box 21); the finding cites the one in box 4.
      id: "invoice-after-shipment",
      title: { ka: "ინვოისი ტვირთის მიღების შემდეგაა დათარიღებული", en: "Invoice dated after the goods were taken over" },
      expected: ["DATE-01.invoice-after-shipment"],
      mutate: (d, f) => {
        d.invoice.date = cite("2026-10-09", f.date("2026-10-09"));
        d.packingList.invoiceRef.date = cite("2026-10-09", f.date("2026-10-09"));
      },
    },
    {
      id: "quantity-mismatch",
      title: { ka: "შეფუთვის ფურცელში სხვა რაოდენობაა", en: "Packing list shows a different quantity" },
      expected: ["QTY-01.line"],
      mutate: (d, f) => {
        d.packingList.lines[0]!.quantity = printed(f, "2300");
        d.packingList.totalQuantity = printed(f, "2900");
      },
    },
  ],
};
