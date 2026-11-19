import { blankDocument, REGISTRY_SOURCE, REGISTRY_VERSION, type CustomsDeclaration, type RegistryEntry, type RegistrySnapshot } from "@logisticshub/core";
import { STYLES, type Formatter } from "../format.ts";
import { cite, printed, type Pack, type ShipmentDocuments, type Variant } from "../model.ts";

const officePedestalCode = "9403 10 580 00";

function printHsCodes(d: ShipmentDocuments, first = officePedestalCode) {
  d.invoice.lines[0]!.hsCode = cite(first);
  d.invoice.lines[1]!.hsCode = cite(officePedestalCode);
}

const checkedAt = "2026-11-19T10:30:00.000Z";
const company = (code: string, FullName: string, VatPayer = "კი"): RegistryEntry => ({
  code, checkedAt, answer: [{
    FullName, Status: "სატესტო სტატუსი", RegisteredSubject: "სატესტო სუბიექტი",
    StartDate: "11/19/2026 9:00:00 AM", VatPayer, Mortgage: "", Sequestration: "",
    AdditionalStatus: "", NonResident: "არა",
  }],
});
const registry = (buyer = company("900000001", "შპს „ტესტ კომპანია“"), ...others: RegistryEntry[]): RegistrySnapshot => ({
  schemaVersion: REGISTRY_VERSION, sourceUrl: REGISTRY_SOURCE,
  entries: [buyer, company("900000002", "Caucasus Demo Transit LLC"), ...others],
});

function declarationShipment(d: ShipmentDocuments, f: Formatter) {
  printHsCodes(d);
  for (const [i, gross, net] of [[0, "750", "650"], [1, "500", "400"]] as const) {
    d.packingList.lines[i]!.grossWeightKg = d.cmr.goods[i]!.grossWeightKg = printed(f, gross);
    d.packingList.lines[i]!.netWeightKg = printed(f, net);
  }
  d.packingList.totalGrossWeightKg = d.cmr.totalGrossWeightKg = printed(f, "1250");
  d.packingList.totalNetWeightKg = printed(f, "1050");
}

function declaration(d: ShipmentDocuments, f: Formatter): CustomsDeclaration {
  const doc = blankDocument("customs_declaration", "declaration");
  return {
    ...doc,
    sourceFile: "declaration.pdf", language: "ka",
    number: cite("C-DEMO-2041"), date: cite("2026-09-20", "20.09.2026"),
    customsOfficeCode: cite("99099"), customsOfficeName: cite("სატესტო გაფორმების ზონა"),
    regime: cite("იმ 4"), assessmentNumber: cite("A-DEMO-2052"), assessmentDate: cite("2026-09-21", "21.09.2026"),
    exporter: structuredClone(d.invoice.seller), importer: structuredClone(d.invoice.buyer),
    countryOfDispatch: cite("თურქეთი"), countryOfDestination: cite("საქართველო"),
    currency: structuredClone(d.invoice.currency), totalInvoiceAmount: printed(f, "13300.00"),
    exchangeRate: printed(f, "3.0512"), totalPackages: structuredClone(d.invoice.packages),
    attachedDocuments: [cite(`ინვოისი ${d.invoice.number.value}`)],
    items: [{
      itemNumber: cite("1"), description: cite("საოფისე ავეჯი, ლითონის ტუმბოები"),
      packages: printed(f, "100"), packingMethod: cite("მუყაოს ყუთი"),
      hsCode: cite(officePedestalCode), countryOfOrigin: cite("TR"),
      grossWeightKg: printed(f, "1250"), procedure: cite("4000"),
      netWeightKg: printed(f, "1050"), supplementaryQuantity: printed(f, "100"), supplementaryUnit: cite("ცალი"),
      invoiceValue: printed(f, "13300.00"), customsValueGel: printed(f, "40582.96"), rsValueInGel: cite(null),
    }],
  };
}

function declarationVariant(id: string, ka: string, en: string, expected: Variant["expected"],
  change?: (doc: CustomsDeclaration, d: ShipmentDocuments, f: Formatter) => void): Variant {
  return {
    id, title: { ka, en }, expected,
    mutate(d, f) {
      declarationShipment(d, f);
      d.declaration = declaration(d, f);
      change?.(d.declaration, d, f);
    },
  };
}

const rsResponse = `${JSON.stringify({
  DATA: [{
    CustomsCode: "99099", CustomsName: "სატესტო გაფორმების ზონა", Regime: "იმ",
    RegistrationNumber: "C-DEMO-2041", RegistrationDate: "20.09.2026",
    AssessmentNumber: "A-DEMO-2052", AssessmentDate: "21.09.2026",
    ExporterCode: "TR-900001", ImporterCode: "900000001", SenderCountryCode: "792", DestinationCountryCode: "268",
    ItemNumber: 1, HSCode: "94031058000", CustomsProcedure: "4000", OriginCountryCode: "792",
    BruttoWeight: 1250, NettoWeight: 1050, ValueInGEL: 40582.96, GoodsDescription: "საოფისე ავეჯი, ლითონის ტუმბოები",
    SupplementaryQuantity: 100, SupplementaryUnit: "ცალი",
  }],
  STATUS: { ID: 0, TEXT: "ოპერაცია წარმატებით დასრულდა" },
}, null, 2)}\n`;

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
      taxId: "TR-900001",
    },
    buyer: {
      name: "ტესტ კომპანია",
      address: "საწყობი B, ლოგისტიკის ქ. 12, თბილისი",
      country: "საქართველო",
      taxId: "900000001",
    },
    carrier: {
      name: "Caucasus Demo Transit LLC",
      address: "გზატკეცილის ქ. 8, ქუთაისი",
      country: "საქართველო",
      taxId: "900000002",
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
      id: "tax-id-mismatch",
      title: { ka: "მიმღების საიდენტიფიკაციო ნომერი განსხვავდება", en: "Consignee’s tax ID differs" },
      expected: ["PTY-02.number"],
      mutate: (d) => { printHsCodes(d); d.cmr.consignee.taxId = cite("900000009"); },
    },
    {
      id: "registry-name-mismatch",
      title: { ka: "რეესტრში სხვა სახელია", en: "Registry gives a different name" },
      expected: ["TAX-01.name"],
      registry: registry(company("900000001", "შპს „სატესტო მარანი“")),
      mutate: (d) => printHsCodes(d),
    },
    {
      id: "registry-vat-mismatch",
      title: { ka: "გამყიდველი ჩანაწერში დღგ-ის გადამხდელი არ არის", en: "Seller is not a VAT payer in the snapshot" },
      expected: ["TAX-02.vat"],
      registry: registry(undefined, company("900000007", "შპს „სატესტო ავეჯი“", "არა")),
      mutate: (d, f) => {
        printHsCodes(d);
        const seller = {
          name: cite("შპს სატესტო ავეჯი"), country: cite("საქართველო"),
          address: cite("სატესტო მისამართი 7, თბილისი"), taxId: cite("900000007"),
        };
        d.invoice.seller = d.packingList.shipper = d.cmr.sender = d.contract.seller = seller;
        d.invoice.tax = cite("2394.00", `EUR ${f.number("2394.00")}`);
        d.invoice.total = cite("15694.00", `EUR ${f.number("15694.00")}`);
        d.invoice.totalInWords = cite("თხუთმეტი ათას ექვსას ოთხმოცდათოთხმეტი ევრო და ნული ცენტი");
      },
    },
    {
      id: "registry-status-minus-one",
      title: { ka: "რეესტრის პასუხი კოდით −1", en: "Registry returns status −1" },
      expected: ["TAX-03.reply"],
      registry: registry({
        code: "900000001", checkedAt,
        error: { Status: -1, Message: "გადამხდელი არ არის რეგისტრირებული ESERVICES.RS.GE-ზე" },
      }),
      mutate: (d) => printHsCodes(d),
    },
    {
      id: "registry-clean",
      title: { ka: "ნაკრები რეესტრის ჩანაწერს ემთხვევა", en: "Clean set with matching registry snapshot" },
      expected: [],
      registry: registry(),
      mutate: (d) => printHsCodes(d),
    },
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
    declarationVariant("declaration-clean", "სუფთა ნაკრები დეკლარაციით", "Clean set with a declaration", []),
    declarationVariant("declaration-gross-mismatch", "დეკლარაციის ბრუტო წონა განსხვავდება", "Declared gross weight differs", ["DEC-03.gross"],
      (doc, _d, f) => { doc.items[0]!.grossWeightKg = printed(f, "1205"); }),
    declarationVariant("declaration-national-code", "დეკლარაციის ეროვნული კოდი არ არსებობს", "Unknown declared national code", ["DEC-02.unknown-national"],
      (doc) => { doc.items[0]!.hsCode = cite("9403 10 999 99"); }),
    declarationVariant("declaration-invoice-prefix", "ინვოისის კოდი დეკლარაციაში არ ჩანს", "Invoice code missing from the declaration", ["DEC-02.invoice-prefix"],
      (_doc, d) => { d.invoice.lines[1]!.hsCode = cite("940330"); }),
    declarationVariant("declaration-invoice-total", "დეკლარაციაში ინვოისის თანხა განსხვავდება", "Box 22 differs from the invoice total", ["DEC-05.invoice-total"],
      (doc, _d, f) => { doc.totalInvoiceAmount = doc.items[0]!.invoiceValue = printed(f, "13301.00"); }),
    declarationVariant("declaration-importer-tax-id", "იმპორტიორის საიდენტიფიკაციო ნომერი განსხვავდება", "Declared importer tax ID differs", ["DEC-01.tax-id"],
      (doc) => { doc.importer.taxId = cite("900000009"); }),
    declarationVariant("declaration-packages", "შეფუთვების რაოდენობა განსხვავდება", "Declared package count differs", ["DEC-04.packages"],
      (doc) => { doc.totalPackages = cite("99", "99 ყუთი"); }),
    declarationVariant("declaration-origin", "დეკლარირებული წარმოშობა განსხვავდება", "Declared origin differs", ["DEC-06.origin"],
      (doc) => { doc.items[0]!.countryOfOrigin = cite("DE"); }),
    {
      id: "declaration-rs-clean", title: { ka: "სუფთა ნაკრები შემოსავლების სამსახურის პასუხით", en: "Clean set with a saved Revenue Service response" },
      expected: [], rsResponse, mutate: declarationShipment,
    },
  ],
};
