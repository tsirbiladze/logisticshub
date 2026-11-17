/** Printed labels for the synthetic documents, per document language. */
export interface Labels {
  invoice: string;
  packingList: string;
  cmr: string;
  contract: string;
  seller: string;
  buyer: string;
  shipper: string;
  consignee: string;
  carrier: string;
  number: string;
  date: string;
  contractRef: string;
  invoiceRef: string;
  incoterm: string;
  currency: string;
  origin: string;
  model: string;
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  amount: string;
  packages: string;
  packing: string;
  net: string;
  gross: string;
  volume: string;
  marks: string;
  subtotal: string;
  discount: string;
  freight: string;
  insurance: string;
  otherCharges: string;
  tax: string;
  total: string;
  /** Last row of a table that goes on over the page, and the first row on the next page. */
  carriedForward: string;
  broughtForward: string;
  inWords: string;
  totals: string;
  placeOfIssue: string;
  takingOver: string;
  delivery: string;
  attached: string;
  instructions: string;
  charges: string;
  goodsDescription: string;
  contractTotal: string;
  signature: string;
  synthetic: string;
}

export const LABELS: Record<"ka" | "en" | "ru" | "tr", Labels> = {
  ka: {
    invoice: "კომერციული ინვოისი",
    packingList: "შეფუთვის ფურცელი",
    cmr: "CMR / საერთაშორისო სატრანსპორტო ზედნადები",
    contract: "საქონლის ნასყიდობის ხელშეკრულება",
    seller: "გამყიდველი / გამგზავნი",
    buyer: "მყიდველი / მიმღები",
    shipper: "გამგზავნი",
    consignee: "მიმღები",
    carrier: "გადამზიდველი",
    number: "ნომერი",
    date: "თარიღი",
    contractRef: "ხელშეკრულება",
    invoiceRef: "ინვოისის მითითება",
    incoterm: "მიწოდების პირობა",
    currency: "ვალუტა",
    origin: "წარმოშობის ქვეყანა",
    model: "მოდელი",
    description: "აღწერა",
    quantity: "რაოდენობა",
    unit: "ერთეული",
    unitPrice: "ფასი",
    amount: "ჯამი",
    packages: "ადგილების რაოდენობა",
    packing: "შეფუთვის სახე",
    net: "ნეტო, კგ",
    gross: "ბრუტო, კგ",
    volume: "მოცულობა, მ³",
    marks: "მარკირება",
    subtotal: "საქონლის ღირებულება",
    discount: "ფასდაკლება",
    freight: "ტრანსპორტირება",
    insurance: "დაზღვევა",
    otherCharges: "შეფუთვა და დამუშავება",
    tax: "დღგ",
    total: "გადასახდელი",
    carriedForward: "გადასატანი ჯამი",
    broughtForward: "წინა გვერდიდან გადმოტანილი ჯამი",
    inWords: "თანხა სიტყვიერად",
    totals: "სულ",
    placeOfIssue: "21. შედგენის ადგილი",
    takingOver: "4. ტვირთის მიღების ადგილი და თარიღი",
    delivery: "3. დანიშნულების ადგილი",
    attached: "5. თანდართული საბუთები",
    instructions: "13. გამგზავნის მითითებები",
    charges: "20. გადასახდელი ხარჯები",
    goodsDescription: "ნასყიდობის საგანი",
    contractTotal: "საერთო ღირებულება",
    signature: "ხელმოწერა",
    synthetic: "სინთეზური დოკუმენტი · Logisticshub-ის სადემო ნაკრები",
  },
  en: {
    invoice: "Commercial Invoice",
    packingList: "Packing List",
    cmr: "CMR / International Consignment Note",
    contract: "Sales Contract",
    seller: "Seller / Exporter",
    buyer: "Buyer / Importer",
    shipper: "Shipper",
    consignee: "Consignee",
    carrier: "Carrier",
    number: "No.",
    date: "Date",
    contractRef: "Contract",
    invoiceRef: "Invoice ref.",
    incoterm: "Delivery terms",
    currency: "Currency",
    origin: "Country of origin",
    model: "Item",
    description: "Description",
    quantity: "Qty",
    unit: "Unit",
    unitPrice: "Unit price",
    amount: "Amount",
    packages: "Packages",
    packing: "Packing",
    net: "Net, kg",
    gross: "Gross, kg",
    volume: "Volume, m³",
    marks: "Marks",
    subtotal: "Subtotal",
    discount: "Discount",
    freight: "Freight",
    insurance: "Insurance",
    otherCharges: "Packing and handling",
    tax: "VAT",
    total: "Total due",
    carriedForward: "Carried forward",
    broughtForward: "Brought forward",
    inWords: "Amount in words",
    totals: "Total",
    placeOfIssue: "21. Established in",
    takingOver: "4. Place and date of taking over",
    delivery: "3. Place of delivery",
    attached: "5. Documents attached",
    instructions: "13. Sender's instructions",
    charges: "20. Charges",
    goodsDescription: "Subject of the contract",
    contractTotal: "Total contract value",
    signature: "Signature",
    synthetic: "Synthetic document · Logisticshub demo pack",
  },
  ru: {
    invoice: "Коммерческий инвойс",
    packingList: "Упаковочный лист",
    cmr: "CMR / Международная товарно-транспортная накладная",
    contract: "Договор купли-продажи",
    seller: "Продавец / Грузоотправитель",
    buyer: "Покупатель / Грузополучатель",
    shipper: "Грузоотправитель",
    consignee: "Грузополучатель",
    carrier: "Перевозчик",
    number: "№",
    date: "Дата",
    contractRef: "Договор",
    invoiceRef: "К инвойсу",
    incoterm: "Условия поставки",
    currency: "Валюта",
    origin: "Страна происхождения",
    model: "Артикул",
    description: "Наименование",
    quantity: "Кол-во",
    unit: "Ед.",
    unitPrice: "Цена",
    amount: "Сумма",
    packages: "Мест",
    packing: "Упаковка",
    net: "Нетто, кг",
    gross: "Брутто, кг",
    volume: "Объём, м³",
    marks: "Маркировка",
    subtotal: "Стоимость товара",
    discount: "Скидка",
    freight: "Фрахт",
    insurance: "Страхование",
    otherCharges: "Упаковка и обработка",
    tax: "НДС",
    total: "Итого к оплате",
    carriedForward: "Итого к переносу",
    broughtForward: "Перенесено с предыдущей страницы",
    inWords: "Сумма прописью",
    totals: "Итого",
    placeOfIssue: "21. Составлена в",
    takingOver: "4. Место и дата погрузки",
    delivery: "3. Место разгрузки",
    attached: "5. Прилагаемые документы",
    instructions: "13. Указания отправителя",
    charges: "20. Подлежит оплате",
    goodsDescription: "Предмет договора",
    contractTotal: "Общая стоимость договора",
    signature: "Подпись",
    synthetic: "Синтетический документ · демо-набор Logisticshub",
  },
  tr: {
    invoice: "Ticari Fatura",
    packingList: "Çeki Listesi",
    cmr: "CMR / Uluslararası Karayolu Taşıma Senedi",
    contract: "Satış Sözleşmesi",
    seller: "Satıcı / İhracatçı",
    buyer: "Alıcı / İthalatçı",
    shipper: "Gönderici",
    consignee: "Alıcı",
    carrier: "Taşıyıcı",
    number: "No",
    date: "Tarih",
    contractRef: "Sözleşme",
    invoiceRef: "Fatura ref.",
    incoterm: "Teslim şekli",
    currency: "Döviz",
    origin: "Menşei",
    model: "Ürün kodu",
    description: "Açıklama",
    quantity: "Miktar",
    unit: "Birim",
    unitPrice: "Birim fiyat",
    amount: "Tutar",
    packages: "Kap",
    packing: "Ambalaj",
    net: "Net, kg",
    gross: "Brüt, kg",
    volume: "Hacim, m³",
    marks: "Marka",
    subtotal: "Mal bedeli",
    discount: "İskonto",
    freight: "Navlun",
    insurance: "Sigorta",
    otherCharges: "Ambalaj ve elleçleme",
    tax: "KDV",
    total: "Ödenecek tutar",
    carriedForward: "Nakli yekûn",
    broughtForward: "Önceki sayfadan nakli yekûn",
    inWords: "Yazıyla",
    totals: "Toplam",
    placeOfIssue: "21. Düzenlendiği yer",
    takingOver: "4. Yükleme yeri ve tarihi",
    delivery: "3. Teslim yeri",
    attached: "5. Ekli belgeler",
    instructions: "13. Göndericinin talimatları",
    charges: "20. Ödenecek masraflar",
    goodsDescription: "Sözleşmenin konusu",
    contractTotal: "Toplam sözleşme bedeli",
    signature: "İmza",
    synthetic: "Sentetik belge · Logisticshub demo seti",
  },
};
