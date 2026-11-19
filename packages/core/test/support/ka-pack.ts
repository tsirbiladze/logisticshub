/**
 * Extraction of the synthetic Georgian pack LH-TEST-20260920-01 (office
 * pedestals, Kayseri → Tbilisi): the reference "clean" set. All companies
 * and people are fictional.
 */
import { blankDocument, SCHEMA_VERSION, type Extraction } from "../../src/index.ts";

export function c(value: string | null, quote: string | null = value, page: number | null = value === null ? null : 1) {
  return { value, quote, page };
}

const SELLER = {
  name: c("Anatolia Office Systems Ltd."),
  address: c("საწარმო A, 12. Cadde No:34, Organize Sanayi Bölgesi, ქაისერი, თურქეთი"),
  country: c("თურქეთი"),
  taxId: c(null),
};
const BUYER = {
  name: c("ტესტ კომპანია"),
  address: c("საწყობი B, ლოგისტიკის ქ. 12, თბილისი, საქართველო"),
  country: c("საქართველო"),
  taxId: c("900000001"),
};
const WORDS = "ცამეტი ათას სამასი ევრო და ნული ცენტი";
const INVOICE_NO = "AOS-INV-2026-0918-01";
const PL_NO = "AOS-PL-2026-0919-01";
const CONTRACT_NO = "AOS-SC-2026-0915-01";

export function kaPack(): Extraction {
  const invoice = blankDocument("commercial_invoice", "invoice-1");
  Object.assign(invoice, {
    sourceFile: "logisticshub-test-01-commercial-invoice.pdf",
    language: "ka",
    number: c(INVOICE_NO),
    date: c("2026-09-18", "18.09.2026"),
    seller: structuredClone(SELLER),
    buyer: structuredClone(BUYER),
    contractRef: { number: c(CONTRACT_NO), date: c("2026-09-15", "15.09.2026") },
    incoterm: {
      code: c("FCA"),
      place: c("გამყიდველის საწარმო A, ქაისერი, თურქეთი"),
      version: c("Incoterms 2020"),
    },
    currency: c("EUR", "EUR / 18.10.2026"),
    lines: [
      {
        description: c("საოფისე ლითონის ტუმბო, 3 უჯრით"),
        model: c("AOS-MP3"),
        hsCode: c(null),
        quantity: c("60"),
        unit: c("ცალი"),
        unitPrice: c("145.00"),
        lineTotal: c("8700.00", "8,700.00"),
      },
      {
        description: c("საოფისე ლითონის ტუმბო, 2 უჯრით"),
        model: c("AOS-MP2"),
        hsCode: c(null),
        quantity: c("40"),
        unit: c("ცალი"),
        unitPrice: c("115.00"),
        lineTotal: c("4600.00", "4,600.00"),
      },
    ],
    subtotal: c("13300.00", "EUR 13,300.00"),
    discount: c("0.00", "EUR 0.00"),
    total: c("13300.00", "EUR 13,300.00"),
    totalInWords: c(WORDS),
    packages: c("100", "100 ცალი / 100 მუყაოს ყუთი"),
    countryOfOrigin: c("თურქეთი"),
  });

  const pl = blankDocument("packing_list", "packing-list-1");
  Object.assign(pl, {
    sourceFile: "logisticshub-test-02-packing-list.pdf",
    language: "ka",
    number: c(PL_NO),
    date: c("2026-09-19", "19.09.2026"),
    shipper: structuredClone(SELLER),
    consignee: structuredClone(BUYER),
    invoiceRef: { number: c(INVOICE_NO), date: c(null) },
    lines: [
      {
        description: c("AOS-MP3 ყუთები 001-060"),
        model: c("AOS-MP3"),
        quantity: c(null),
        unit: c("ყუთი"),
        packages: c("60"),
        packingMethod: c(null),
        netWeightKg: c("1080", "1,080"),
        grossWeightKg: c("1200", "1,200"),
        volumeM3: c("9.0619"),
      },
      {
        description: c("AOS-MP2 ყუთები 061-100"),
        model: c("AOS-MP2"),
        quantity: c(null),
        unit: c("ყუთი"),
        packages: c("40"),
        packingMethod: c(null),
        netWeightKg: c("600"),
        grossWeightKg: c("680"),
        volumeM3: c("5.0669"),
      },
    ],
    totalQuantity: c("100", "100 ყუთი / 100 ცალი"),
    totalPackages: c("100", "100 ყუთი / 100 ცალი"),
    totalNetWeightKg: c("1680", "1,680 კგ"),
    totalGrossWeightKg: c("1880", "1,880 კგ"),
    totalVolumeM3: c("14.1288", "14.1288 მ³"),
  });

  const cmr = blankDocument("cmr", "cmr-1");
  Object.assign(cmr, {
    sourceFile: "logisticshub-test-03-cmr.pdf",
    language: "ka",
    number: c("CDT-CMR-2026-0919-01"),
    date: c("2026-09-19", "19.09.2026"),
    placeOfIssue: c("ქაისერი"),
    sender: structuredClone(SELLER),
    carrier: {
      name: c("Caucasus Demo Transit LLC"),
      address: c("გზატკეცილის ქ. 8, ქუთაისი, საქართველო"),
      country: c("საქართველო"),
      taxId: c("900000002"),
    },
    placeOfTakingOver: c("საწარმო A, ქაისერი, თურქეთი"),
    dateOfTakingOver: c("2026-09-19", "19.09.2026, 09:00"),
    placeOfDelivery: c("საწყობი B, ლოგისტიკის ქ. 12, თბილისი, საქართველო"),
    consignee: structuredClone(BUYER),
    goods: [
      {
        marksAndNumbers: c("AOS-MP3 / 001-060"),
        packages: c("60"),
        packingMethod: c("ყუთი"),
        description: c("ლითონის საოფისე ტუმბო, 3 უჯრით"),
        grossWeightKg: c("1200", "1,200"),
        volumeM3: c("9.0619"),
      },
      {
        marksAndNumbers: c("AOS-MP2 / 061-100"),
        packages: c("40"),
        packingMethod: c("ყუთი"),
        description: c("ლითონის საოფისე ტუმბო, 2 უჯრით"),
        grossWeightKg: c("680"),
        volumeM3: c("5.0669"),
      },
    ],
    totalPackages: c("100", "100 ყუთი"),
    totalGrossWeightKg: c("1880", "1,880"),
    carriageCharges: c("ფრახტი: EUR 1,800.00; იხდის მიმღები."),
    customsInstructions: c("საბაჟო დამუშავება: საქართველოში იმპორტი."),
    convention: c("CMR-ის პირობებით გადაზიდვის სატესტო ნიმუში"),
    attachedDocuments: [
      c(`ინვოისი ${INVOICE_NO}`),
      c(`შეფუთვის ფურცელი ${PL_NO}`),
      c("პროდუქტის სპეციფიკაცია AOS-TS-2026-0915-01"),
    ],
  });

  const contract = blankDocument("contract", "contract-1");
  Object.assign(contract, {
    sourceFile: "logisticshub-test-05-sales-contract.pdf",
    language: "ka",
    number: c(CONTRACT_NO),
    date: c("2026-09-15", "15.09.2026"),
    seller: structuredClone(SELLER),
    buyer: structuredClone(BUYER),
    incoterm: { code: c("FCA"), place: c("გამყიდველის საწარმო A"), version: c("Incoterms 2020") },
    currency: c("EUR"),
    totalAmount: c("13300.00", "EUR 13,300.00"),
    totalInWords: c(WORDS),
    goodsDescription: c("ახალი საოფისე ლითონის ავეჯი"),
  });

  return { schemaVersion: SCHEMA_VERSION, documents: [invoice, pl, cmr, contract] };
}
