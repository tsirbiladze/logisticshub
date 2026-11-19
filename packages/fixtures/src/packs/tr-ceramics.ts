import { STYLES } from "../format.ts";
import { cite, type Pack } from "../model.ts";

/** Turkish pack: ceramic tiles, İzmir → Batumi by road, EUR, EXW. */
export const trCeramics: Pack = {
  spec: {
    id: "tr-ceramics",
    language: "tr",
    style: STYLES.tr,
    title: { ka: "კერამიკული ფილა · იზმირი → ბათუმი", en: "Ceramic tiles · İzmir → Batumi" },
    currency: "EUR",
    seller: {
      name: "Erguvan Seramik Sanayi ve Ticaret A.Ş.",
      address: "Atatürk OSB 10003 Sk. No:5, 35620 Çiğli / İzmir",
      country: "Türkiye",
      registration: "Vergi No: TEST-1234567890",
    },
    buyer: {
      name: "Batumi Yapı Market LLC",
      address: "Gorgiladze Cad. No:60, 6010 Batum",
      country: "Gürcistan",
      registration: "Vergi No: TEST-445566778",
    },
    carrier: {
      name: "Karadeniz Lojistik Ltd. Şti.",
      address: "Liman Cad. No:12, 61100 Trabzon",
      country: "Türkiye",
      registration: "Vergi No: TEST-9988776655",
    },
    incoterm: { code: "EXW", place: "Çiğli / İzmir", version: "Incoterms 2020" },
    origin: "Türkiye",
    packagesUnit: "palet",
    packingListQuantities: true,
    invoice: { number: "ESR2026000781", date: "2026-10-20" },
    packingList: { number: "ESR2026000781-ÇL", date: "2026-10-21" },
    contract: { number: "ESR-SZL-2026-019", date: "2026-10-08", goodsDescription: "Seramik yer ve duvar karoları" },
    cmr: {
      number: "TR 1029384",
      date: "2026-10-22",
      placeOfIssue: "İzmir",
      takingOverPlace: "Atatürk OSB, Çiğli / İzmir, Türkiye",
      takingOverDate: "2026-10-22",
      deliveryPlace: "Gorgiladze Cad. No:60, Batum, Gürcistan",
      charges: "Navlun alıcıya aittir (EXW)",
      instructions: "İhracat beyannamesi: İzmir Gümrüğü. İthalat: Sarpi gümrük kapısı",
      convention:
        "Bu taşıma, aksine herhangi bir hükme bakılmaksızın, Eşyaların Karayoluyla Uluslararası Taşınması için Sözleşme Mukavelesine (CMR) tabidir.",
      attached: ["Ticari fatura {invoice}", "Çeki listesi {packingList}"],
    },
    lines: [
      {
        model: "ESR-GRN-6060",
        description: "Granit seramik 60×60 cm, mat gri",
        quantity: "720",
        unit: "m²",
        unitPrice: "9.75",
        packages: "12",
        packing: "palet",
        netKg: "16560",
        grossKg: "16920",
        volumeM3: "13.2",
        marks: "ESR/781/P01-P12",
      },
      {
        model: "ESR-DUV-3060",
        description: "Duvar seramiği 30×60 cm, parlak beyaz",
        quantity: "360",
        unit: "m²",
        unitPrice: "7.40",
        packages: "6",
        packing: "palet",
        netKg: "5400",
        grossKg: "5580",
        volumeM3: "6.6",
        marks: "ESR/781/P13-P18",
      },
    ],
    totalInWords: "YALNIZ DOKUZBİNALTIYÜZSEKSENDÖRT AVRO SIFIR SENT",
  },
  variants: [
    { id: "clean", title: { ka: "სუფთა ნაკრები", en: "Clean set" }, expected: [] },
    {
      id: "words-mismatch",
      title: { ka: "სიტყვიერი თანხა ციფრებს არ ემთხვევა", en: "Amount in words does not match figures" },
      expected: ["AMT-01.mismatch"],
      mutate: (d) => {
        d.invoice.totalInWords = cite("YALNIZ DOKUZBİNSEKİZYÜZSEKSENDÖRT AVRO SIFIR SENT");
      },
    },
    {
      id: "cip-without-insurance",
      title: { ka: "CIP პირობა დაზღვევის გარეშე", en: "CIP without insurance" },
      expected: ["INC-03.no-insurance"],
      mutate: (d) => {
        for (const doc of [d.invoice, d.contract]) {
          doc.incoterm.code = cite("CIP");
          doc.incoterm.place = cite("Batum, Gürcistan");
        }
        // The CMR's charges box follows the rule: under CIP the seller pays the carriage.
        d.cmr.carriageCharges = cite("Navlun göndericiye aittir (CIP)");
      },
    },
    {
      id: "consignee-mismatch",
      title: { ka: "CMR-ზე სხვა მიმღებია", en: "Different consignee on the CMR" },
      expected: ["PTY-01.name"],
      mutate: (d) => {
        d.cmr.consignee.name = cite("Tiflis Yapı Market LLC");
      },
    },
    {
      id: "cmr-missing-invoice",
      title: { ka: "CMR-ის თანდართულ დოკუმენტებში ინვოისი არ წერია", en: "Invoice not listed on the CMR" },
      expected: ["REF-01.cmr-missing-document"],
      mutate: (d) => {
        d.cmr.attachedDocuments = d.cmr.attachedDocuments.slice(1);
      },
    },
  ],
};
