import { STYLES } from "../format.ts";
import { cite, printed, type Pack, type ShipmentDocuments } from "../model.ts";

const officePedestalCode = "9403 10 580 00";

function printHsCodes(d: ShipmentDocuments, first = officePedestalCode) {
  d.invoice.lines[0]!.hsCode = cite(first);
  d.invoice.lines[1]!.hsCode = cite(officePedestalCode);
}

/** Georgian pack, based on the original LH-TEST-20260920-01 test shipment. */
export const kaOfficeFurniture: Pack = {
  spec: {
    id: "ka-office-furniture",
    language: "ka",
    style: STYLES.ka,
    title: { ka: "საოფისე ავეჯი · ქაისერი → თბილისი", en: "Office furniture · Kayseri → Tbilisi" },
    currency: "EUR",
    seller: {
      name: "Anatolia Office Systems Ltd.",
      address: "საწარმო A, 12. Cadde No:34, Organize Sanayi Bölgesi, ქაისერი",
      country: "თურქეთი",
      registration: "სატესტო რეგისტრაცია: TR-TEST-900001",
    },
    buyer: {
      name: "ტესტ კომპანია",
      address: "საწყობი B, ლოგისტიკის ქ. 12, თბილისი",
      country: "საქართველო",
      registration: "საიდენტიფიკაციო კოდი: TEST-123123123",
    },
    carrier: {
      name: "Caucasus Demo Transit LLC",
      address: "გზატკეცილის ქ. 8, ქუთაისი",
      country: "საქართველო",
      registration: "სატესტო კოდი: TEST-998877665",
    },
    incoterm: { code: "FCA", place: "გამყიდველის საწარმო A, ქაისერი", version: "Incoterms 2020" },
    origin: "თურქეთი",
    packagesUnit: "ყუთი",
    packingListQuantities: false,
    invoice: { number: "AOS-INV-2026-0918-01", date: "2026-09-18" },
    packingList: { number: "AOS-PL-2026-0919-01", date: "2026-09-19" },
    contract: { number: "AOS-SC-2026-0915-01", date: "2026-09-15", goodsDescription: "ახალი საოფისე ლითონის ავეჯი საკუთარი წარმოებიდან" },
    cmr: {
      number: "CDT-CMR-2026-0919-01",
      date: "2026-09-19",
      placeOfIssue: "ქაისერი",
      takingOverPlace: "საწარმო A, ქაისერი, თურქეთი",
      takingOverDate: "2026-09-19",
      deliveryPlace: "საწყობი B, ლოგისტიკის ქ. 12, თბილისი, საქართველო",
      charges: "ფრახტი EUR 1,800.00, იხდის მიმღები",
      instructions: "საბაჟო გაფორმება: საქართველოში იმპორტი",
      convention:
        "ეს გადაზიდვა, მიუხედავად ნებისმიერი საწინააღმდეგო პირობისა, ექვემდებარება საქონლის საერთაშორისო საავტომობილო გადაზიდვის ხელშეკრულების შესახებ კონვენციას (CMR).",
      attached: ["ინვოისი {invoice}", "შეფუთვის ფურცელი {packingList}"],
    },
    lines: [
      {
        model: "AOS-MP3",
        description: "საოფისე ლითონის ტუმბო, 3 უჯრით",
        quantity: "60",
        unit: "ცალი",
        unitPrice: "145.00",
        packages: "60",
        packing: "მუყაოს ყუთი",
        netKg: "1080",
        grossKg: "1200",
        volumeM3: "9.0619",
        marks: "LH-TEST-20260920-01 / AOS-MP3 / 001-060",
      },
      {
        model: "AOS-MP2",
        description: "საოფისე ლითონის ტუმბო, 2 უჯრით",
        quantity: "40",
        unit: "ცალი",
        unitPrice: "115.00",
        packages: "40",
        packing: "მუყაოს ყუთი",
        netKg: "600",
        grossKg: "680",
        volumeM3: "5.0669",
        marks: "LH-TEST-20260920-01 / AOS-MP2 / 061-100",
      },
    ],
    totalInWords: "ცამეტი ათას სამასი ევრო და ნული ცენტი",
  },
  variants: [
    { id: "clean", title: { ka: "სუფთა ნაკრები", en: "Clean set" }, expected: [], mutate: (d) => printHsCodes(d) },
    {
      id: "unknown-hs-national-code",
      title: { ka: "ნომენკლატურაში შეტანილი არ არის ინვოისის ეროვნული კოდი", en: "Invoice national code is absent from the nomenclature" },
      expected: ["HS-01.unknown-national"],
      mutate: (d) => printHsCodes(d, "9403 10 999 99"),
    },
    {
      id: "unknown-hs-subheading",
      title: { ka: "ნომენკლატურაში შეტანილი არ არის ინვოისის სასაქონლო სუბპოზიცია", en: "Invoice subheading is absent from the nomenclature" },
      expected: ["HS-01.unknown-subheading-heading"],
      mutate: (d) => printHsCodes(d, "9403 98"),
    },
    {
      id: "words-mismatch",
      title: { ka: "სიტყვიერი თანხა ციფრებს არ ემთხვევა", en: "Amount in words does not match figures" },
      expected: ["AMT-01.mismatch"],
      mutate: (d) => {
        d.invoice.totalInWords = cite("ცამეტი ათას ხუთასი ევრო და ნული ცენტი");
      },
    },
    {
      id: "packages-mismatch",
      title: { ka: "CMR-ზე ნაკლები ყუთია", en: "CMR shows fewer packages" },
      expected: ["QTY-01.packages"],
      mutate: (d, f) => {
        d.cmr.goods[1]!.packages = printed(f, "30");
        d.cmr.totalPackages = printed(f, "90");
      },
    },
    {
      id: "gross-below-net",
      title: { ka: "ბრუტო წონა ნეტოზე ნაკლებია", en: "Gross weight below net weight" },
      expected: ["WGT-01.gross-below-net", "WGT-02.gross"],
      mutate: (d, f) => {
        d.packingList.lines[1]!.grossWeightKg = printed(f, "580");
        d.packingList.totalGrossWeightKg = printed(f, "1780");
      },
    },
    {
      // 13,300.00 + VAT 18% (2,394.00) = 15,694.00, but the total still shows 13,300.00.
      id: "vat-not-in-total",
      title: { ka: "დღგ გადასახდელ თანხაში არ არის ჩათვლილი", en: "VAT left out of the total" },
      expected: ["SUM-02.total"],
      mutate: (d, f) => {
        d.invoice.tax = cite("2394.00", `EUR ${f.number("2394.00")}`);
      },
    },
    {
      // The CMR comes as a scan (an image, no text layer) and shows 1,800 kg where the packing list has 1,880.
      id: "scanned-cmr",
      title: { ka: "დასკანერებული CMR, რომელშიც სხვა ბრუტო წონა წერია", en: "A scanned CMR that shows a different gross weight" },
      expected: ["WGT-02.gross"],
      layout: { scanned: ["cmr"] },
      mutate: (d, f) => {
        d.cmr.goods[1]!.grossWeightKg = printed(f, "600");
        d.cmr.totalGrossWeightKg = printed(f, "1800");
      },
    },
    {
      id: "cmr-missing-particulars",
      title: { ka: "CMR-ს სავალდებულო ველები აკლია", en: "CMR is missing required particulars" },
      expected: ["CMR-01.missing", "CMR-01.missing"],
      mutate: (d) => {
        d.cmr.carrier.address = cite(null);
        d.cmr.customsInstructions = cite(null);
      },
    },
  ],
};
