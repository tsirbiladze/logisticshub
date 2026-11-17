import { STYLES } from "../format.ts";
import { cite, printed, type Pack } from "../model.ts";

/** English pack: LED lighting, Tallinn → Tbilisi by road, USD, DAP. */
export const enLedLighting: Pack = {
  spec: {
    id: "en-led-lighting",
    language: "en",
    style: STYLES.en,
    title: { ka: "LED განათება · ტალინი → თბილისი", en: "LED lighting · Tallinn → Tbilisi" },
    currency: "USD",
    seller: {
      name: "Baltic Lumen OÜ",
      address: "Tööstuse 14, 10416 Tallinn",
      country: "Estonia",
      registration: "Reg. code EE-TEST-100200",
    },
    buyer: {
      name: "Kartli Retail LLC",
      address: "12 Aghmashenebeli Ave, 0102 Tbilisi",
      country: "Georgia",
      registration: "ID TEST-404040404",
    },
    carrier: {
      name: "Via Caucasus Logistics LLC",
      address: "5 Airport Road, 4600 Kutaisi",
      country: "Georgia",
      registration: "ID TEST-405050505",
    },
    incoterm: { code: "DAP", place: "Tbilisi, Georgia", version: "Incoterms 2020" },
    origin: "Estonia",
    packagesUnit: "cartons",
    packingListQuantities: true,
    invoice: { number: "BL-INV-26-0412", date: "2026-10-14" },
    packingList: { number: "BL-PL-26-0412", date: "2026-10-15" },
    contract: { number: "BL-SC-26-031", date: "2026-10-02", goodsDescription: "LED lighting products: ceiling panels, tubes and drivers" },
    cmr: {
      number: "VCL-0915226",
      date: "2026-10-16",
      placeOfIssue: "Tallinn",
      takingOverPlace: "Tööstuse 14, Tallinn, Estonia",
      takingOverDate: "2026-10-16",
      deliveryPlace: "12 Aghmashenebeli Ave, Tbilisi, Georgia",
      charges: "Freight prepaid by sender (DAP)",
      instructions: "Export clearance in Tallinn; import clearance in Tbilisi",
      convention:
        "This carriage is subject, notwithstanding any clause to the contrary, to the Convention on the Contract for the International Carriage of Goods by Road (CMR).",
      attached: ["Commercial invoice {invoice}", "Packing list {packingList}"],
    },
    lines: [
      {
        model: "LED-PNL-60",
        description: "LED ceiling panel 600×600 mm, 40 W",
        quantity: "400",
        unit: "pcs",
        unitPrice: "18.50",
        packages: "40",
        packing: "cartons",
        netKg: "320",
        grossKg: "368",
        volumeM3: "2.4",
        marks: "BL/LED-PNL-60/1-40",
      },
      {
        model: "LED-TUBE-120",
        description: "LED tube T8 1200 mm, 18 W",
        quantity: "1500",
        unit: "pcs",
        unitPrice: "2.90",
        packages: "30",
        packing: "cartons",
        netKg: "255",
        grossKg: "285",
        volumeM3: "1.2",
        marks: "BL/LED-TUBE-120/41-70",
      },
      {
        model: "LED-DRV-40",
        description: "LED driver 40 W, constant current",
        quantity: "600",
        unit: "pcs",
        unitPrice: "6.25",
        packages: "12",
        packing: "cartons",
        netKg: "120",
        grossKg: "132",
        volumeM3: "0.3",
        marks: "BL/LED-DRV-40/71-82",
      },
    ],
    totalInWords: "SAY US DOLLARS FIFTEEN THOUSAND FIVE HUNDRED AND CENTS 00 ONLY",
  },
  variants: [
    { id: "clean", title: { ka: "სუფთა ნაკრები", en: "Clean set" }, expected: [] },
    {
      // 15,500.00 + packing 120.00 + VAT 20% of 15,620.00 = 18,744.00: an ordinary invoice, nothing to find.
      id: "vat-and-charges",
      title: { ka: "სუფთა ნაკრები: ინვოისზე დღგ და შეფუთვის ხარჯია", en: "Clean set with VAT and a packing charge" },
      expected: [],
      mutate: (d, f) => {
        d.invoice.otherCharges = [cite("120.00", `USD ${f.number("120.00")}`)];
        d.invoice.tax = cite("3124.00", `USD ${f.number("3124.00")}`);
        d.invoice.total = cite("18744.00", `USD ${f.number("18744.00")}`);
        d.invoice.totalInWords = cite("SAY US DOLLARS EIGHTEEN THOUSAND SEVEN HUNDRED FORTY FOUR AND CENTS 00 ONLY");
      },
    },
    {
      id: "line-arithmetic",
      title: { ka: "სტრიქონის ჯამი არასწორადაა დათვლილი", en: "Line total miscalculated" },
      expected: ["SUM-01.line", "SUM-02.subtotal"],
      mutate: (d, f) => {
        d.invoice.lines[1]!.lineTotal = printed(f, "4530.00");
      },
    },
    {
      // A long table in small: the invoice breaks after its second line. Page 1 ends with "Carried forward
      // USD 11,750.00"; page 2 repeats the header, opens with "Brought forward" and holds the third line (with
      // the planted total: 600 × 6.25 is 3,750.00), the totals and the amount in words.
      id: "two-page-invoice",
      title: { ka: "ორგვერდიანი ინვოისი: მეორე გვერდზე სტრიქონის ჯამი არასწორია", en: "Two-page invoice with a wrong line total on page 2" },
      expected: ["SUM-01.line", "SUM-02.subtotal"],
      layout: { invoiceBreakBefore: 2 },
      mutate: (d, f) => {
        d.invoice.lines[2]!.lineTotal = printed(f, "3570.00");
      },
    },
    {
      // The packing list writes decimals with a point (2.4 m³) and one quantity with a point for thousands
      // (1.500 pieces). The extraction is right, 1500, and the checker cannot know it: it reads the quote the
      // way the document's other numbers show, 1.5, says so in one extraction issue and leaves the value out
      // of every rule. No finding.
      id: "mixed-number-conventions",
      title: { ka: "შეფუთვის ფურცელში რიცხვები ორნაირადაა ჩაწერილი (2.4 და 1.500)", en: "Packing list writes numbers two ways (2.4 and 1.500)" },
      expected: [],
      expectedIssues: ["EXT_QUOTE_MISMATCH documents[1].lines[1].quantity"],
      mutate: (d) => {
        d.packingList.lines[1]!.quantity = cite("1500", "1.500");
      },
    },
    {
      // Dates the American way, month first: 10/14/2026 is 14 October. The invoice, the packing list and the
      // CMR each print a date that shows the order (a day above 12); the contract prints only 10/02/2026.
      id: "month-first-dates",
      title: { ka: "სუფთა ნაკრები: თარიღებში თვე პირველია (10/14/2026)", en: "Clean set with month-first dates (10/14/2026)" },
      expected: [],
      style: { date: "mdy-slash" },
    },
    {
      // A second invoice for the same shipment (spare drivers), right in itself. The cross-checks use the
      // first invoice, and DOC-01 says that there are two.
      id: "second-invoice",
      title: { ka: "ნაკრებში ორი ინვოისია", en: "Two invoices in the set" },
      expected: ["DOC-01.multiple"],
      mutate: (d, f) => {
        const second = structuredClone(d.invoice);
        Object.assign(second, {
          id: "invoice-2",
          sourceFile: "invoice-2.pdf",
          number: cite("BL-INV-26-0413"),
          lines: [
            {
              description: cite("LED driver 40 W, constant current, spare"),
              model: cite("LED-DRV-40"),
              hsCode: cite(null),
              quantity: printed(f, "100"),
              unit: cite("pcs"),
              unitPrice: printed(f, "6.25"),
              lineTotal: printed(f, "625.00"),
            },
          ],
          subtotal: cite("625.00", `USD ${f.number("625.00")}`),
          total: cite("625.00", `USD ${f.number("625.00")}`),
          totalInWords: cite("SAY US DOLLARS SIX HUNDRED TWENTY FIVE AND CENTS 00 ONLY"),
          packages: cite("2", "2 cartons"),
        });
        d.secondInvoice = second;
      },
    },
    {
      // The invoice and the packing list arrive as one PDF: the invoice is page 1, the packing list page 2.
      // The planted reference puts one mark on each page of the same file.
      id: "two-documents-in-one-pdf",
      title: { ka: "ინვოისი და შეფუთვის ფურცელი ერთ PDF-შია; შეფუთვის ფურცელი სხვა ინვოისს უთითებს", en: "Invoice and packing list in one PDF; the packing list refers to another invoice" },
      expected: ["REF-01.invoice-number"],
      layout: { combined: ["invoice", "packing-list"] },
      mutate: (d) => {
        d.packingList.invoiceRef.number = cite("BL-INV-26-0421");
      },
    },
    {
      id: "wrong-invoice-ref",
      title: { ka: "შეფუთვის ფურცელი სხვა ინვოისს უთითებს", en: "Packing list refers to another invoice" },
      expected: ["REF-01.invoice-number"],
      mutate: (d) => {
        d.packingList.invoiceRef.number = cite("BL-INV-26-0421");
      },
    },
    {
      id: "currency-in-words",
      title: { ka: "სიტყვიერ თანხაში სხვა ვალუტაა", en: "Different currency in words" },
      expected: ["AMT-01.currency"],
      mutate: (d) => {
        d.invoice.totalInWords = cite("SAY EURO FIFTEEN THOUSAND FIVE HUNDRED ONLY");
      },
    },
    {
      id: "sea-term-on-road",
      title: { ka: "საზღვაო პირობა (FOB) საავტომობილო გადაზიდვაზე", en: "Sea-only term (FOB) on a road shipment" },
      expected: ["INC-02.sea-term-road"],
      mutate: (d) => {
        for (const doc of [d.invoice, d.contract]) {
          doc.incoterm.code = cite("FOB");
          doc.incoterm.place = cite("Tallinn");
        }
        // The CMR's charges box follows the rule: under FOB the buyer pays the carriage.
        d.cmr.carriageCharges = cite("Freight payable by consignee (FOB)");
      },
    },
  ],
};
