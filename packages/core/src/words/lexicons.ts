/**
 * Vocabulary for reading amounts written in words, per language.
 *
 * Numbers have three roles:
 * - "unit": added to the current group (one, twenty, ორასი, двести…)
 * - "hundred": multiplies the current group by 100 (hundred, yüz, bare ას)
 * - "scale": closes the group and multiplies it (thousand, million…)
 *
 * Turkish and Georgian glue numbers together ("onüçbinüçyüz",
 * "ორმოცდაათი"), so their words are split into the morphemes below.
 */
import type { Language } from "../schema.ts";

export type NumberRole = "unit" | "hundred" | "scale";

export interface NumberWord {
  value: bigint;
  role: NumberRole;
}

export interface Lexicon {
  language: Exclude<Language, "other">;
  locale: string;
  numbers: Record<string, NumberWord>;
  /** Words that join numbers or amounts: "and", "და", "и". */
  connectors: string[];
  /** Words that carry no amount: "say", "only", "yalnız", "მხოლოდ", "US"… */
  ignorable: string[];
  /** Articles that mean one before "hundred", "thousand"…: "a hundred". */
  articles: string[];
  /** Tens are counted in twenties, so 1–19 can follow one (Georgian: ოცდაათი = 20 + 10). */
  vigesimal: boolean;
  /** The teens are "ten" plus a unit (Turkish: on bir = 11). */
  compoundTeens: boolean;
  /**
   * Currency word stems → ISO code. A word matches when it starts with the
   * stem. A word that names two currencies lists both ("manat": "AZN/TMT");
   * one that names too many to list is null until a qualifier settles it
   * ("franc", "Swiss franc").
   */
  major: Record<string, string | null>;
  /**
   * Stems of words that say which country's currency is meant → the code
   * they give to the currency word (by its stem) next to them. {} for words
   * that only need to be understood ("Kazakh" tenge).
   */
  qualifiers: Record<string, Record<string, string>>;
  /**
   * Minor-unit word stems → ISO code of their major currency (null = several).
   * Compounds ("eurocent", "евроцент") win over the shorter major stem ("euro").
   */
  minor: Record<string, string | null>;
  /** Split words into morphemes (agglutinative spelling). */
  glued: boolean;
  /** Endings allowed after the last morpheme of a word (glued languages). */
  suffixes: string[];
}

const u = (value: number): NumberWord => ({ value: BigInt(value), role: "unit" });
const HUNDRED: NumberWord = { value: 100n, role: "hundred" };
const THOUSAND: NumberWord = { value: 1000n, role: "scale" };
const MILLION: NumberWord = { value: 1_000_000n, role: "scale" };
const BILLION: NumberWord = { value: 1_000_000_000n, role: "scale" };

function forms(words: string[], word: NumberWord): Record<string, NumberWord> {
  return Object.fromEntries(words.map((w) => [w, word]));
}

export const en: Lexicon = {
  language: "en",
  locale: "en",
  numbers: {
    zero: u(0), nil: u(0), one: u(1), two: u(2), three: u(3), four: u(4), five: u(5), six: u(6),
    no: u(0), seven: u(7), eight: u(8), nine: u(9), ten: u(10), eleven: u(11), twelve: u(12),
    thirteen: u(13), fourteen: u(14), fifteen: u(15), sixteen: u(16), seventeen: u(17),
    eighteen: u(18), nineteen: u(19), twenty: u(20), thirty: u(30), forty: u(40), fourty: u(40),
    fifty: u(50), sixty: u(60), seventy: u(70), eighty: u(80), ninety: u(90),
    hundred: HUNDRED, thousand: THOUSAND, million: MILLION, billion: BILLION,
  },
  connectors: ["and", "&"],
  ignorable: ["say", "only", "total", "amount", "sum", "of", "in", "words", "the", "us", "u", "s", "american", "united", "states", "arab", "turkish", "georgian", "russian", "new", "exactly"],
  articles: ["a", "an"],
  vigesimal: false,
  compoundTeens: false,
  major: {
    euro: "EUR", eur: "EUR", dollar: "USD", usd: "USD", lari: "GEL", gel: "GEL", lira: "TRY", lire: "TRY",
    try: "TRY", tl: "TRY", rouble: "RUB", ruble: "RUB", rub: "RUB", pound: "GBP", gbp: "GBP",
    sterling: "GBP", yuan: "CNY", cny: "CNY", renminbi: "CNY",
    tenge: "KZT", kzt: "KZT", manat: "AZN/TMT", azn: "AZN", tmt: "TMT", dram: "AMD", amd: "AMD",
    hryvnia: "UAH", hryvnya: "UAH", grivna: "UAH", uah: "UAH", franc: null, chf: "CHF", dirham: "AED/MAD", aed: "AED",
  },
  qualifiers: {
    swiss: { franc: "CHF" }, azerbaijan: { manat: "AZN" }, azeri: { manat: "AZN" }, turkmen: { manat: "TMT" },
    uae: { dirham: "AED" }, emirat: { dirham: "AED" }, moroccan: { dirham: "MAD" },
    kazakh: {}, armenian: {}, ukrainian: {},
  },
  minor: {
    cent: null, eurocent: "EUR", tetri: "GEL", kurus: "TRY", kuruş: "TRY", kopeck: "RUB", kopek: "RUB", kopeyka: "RUB", penny: "GBP", pence: "GBP", fen: "CNY",
    tiyn: "KZT", qapik: "AZN", gapik: "AZN", luma: "AMD", kopiy: "UAH", rappen: "CHF", centime: null, fils: null,
  },
  glued: false,
  suffixes: [],
};

export const ru: Lexicon = {
  language: "ru",
  locale: "ru",
  numbers: {
    ...forms(["ноль", "нуль", "ноля", "нуля"], u(0)),
    ...forms(["один", "одна", "одно", "одного", "одной", "одну"], u(1)),
    ...forms(["два", "две", "двух"], u(2)),
    ...forms(["три", "трех"], u(3)),
    ...forms(["четыре", "четырех"], u(4)),
    ...forms(["пять", "пяти"], u(5)),
    ...forms(["шесть", "шести"], u(6)),
    ...forms(["семь", "семи"], u(7)),
    ...forms(["восемь", "восьми"], u(8)),
    ...forms(["девять", "девяти"], u(9)),
    ...forms(["десять", "десяти"], u(10)),
    ...forms(["одиннадцать", "одиннадцати"], u(11)),
    ...forms(["двенадцать", "двенадцати"], u(12)),
    ...forms(["тринадцать", "тринадцати"], u(13)),
    ...forms(["четырнадцать", "четырнадцати"], u(14)),
    ...forms(["пятнадцать", "пятнадцати"], u(15)),
    ...forms(["шестнадцать", "шестнадцати"], u(16)),
    ...forms(["семнадцать", "семнадцати"], u(17)),
    ...forms(["восемнадцать", "восемнадцати"], u(18)),
    ...forms(["девятнадцать", "девятнадцати"], u(19)),
    ...forms(["двадцать", "двадцати"], u(20)),
    ...forms(["тридцать", "тридцати"], u(30)),
    ...forms(["сорок", "сорока"], u(40)),
    ...forms(["пятьдесят", "пятидесяти"], u(50)),
    ...forms(["шестьдесят", "шестидесяти"], u(60)),
    ...forms(["семьдесят", "семидесяти"], u(70)),
    ...forms(["восемьдесят", "восьмидесяти"], u(80)),
    ...forms(["девяносто", "девяноста"], u(90)),
    ...forms(["сто", "ста"], u(100)),
    ...forms(["двести", "двухсот"], u(200)),
    ...forms(["триста", "трехсот"], u(300)),
    ...forms(["четыреста", "четырехсот"], u(400)),
    ...forms(["пятьсот", "пятисот"], u(500)),
    ...forms(["шестьсот", "шестисот"], u(600)),
    ...forms(["семьсот", "семисот"], u(700)),
    ...forms(["восемьсот", "восьмисот"], u(800)),
    ...forms(["девятьсот", "девятисот"], u(900)),
    ...forms(["тысяча", "тысячи", "тысяч", "тысячу"], THOUSAND),
    ...forms(["миллион", "миллиона", "миллионов"], MILLION),
    ...forms(["миллиард", "миллиарда", "миллиардов"], BILLION),
  },
  connectors: ["и"],
  ignorable: ["сумма", "сумму", "итого", "всего", "только", "ровно", "прописью", "в", "размере", "сша", "американских", "турецких", "турецкая", "турецкие", "грузинских", "российских", "рф"],
  articles: [],
  vigesimal: false,
  compoundTeens: false,
  major: {
    евро: "EUR", доллар: "USD", долл: "USD", рубл: "RUB", руб: "RUB", лари: "GEL", лир: "TRY", фунт: "GBP", юан: "CNY",
    тенге: "KZT", манат: "AZN/TMT", драм: "AMD", гривн: "UAH", гривен: "UAH", грн: "UAH", франк: null, дирхам: "AED/MAD", дирхем: "AED/MAD",
  },
  qualifiers: {
    швейцарск: { франк: "CHF" }, азербайджанск: { манат: "AZN" }, туркменск: { манат: "TMT" },
    оаэ: { дирхам: "AED", дирхем: "AED" }, марокканск: { дирхам: "MAD", дирхем: "MAD" },
    казахстанск: {}, армянск: {}, украинск: {},
  },
  minor: {
    цент: null, евроцент: "EUR", копе: "RUB", коп: "RUB", тетри: "GEL", куруш: "TRY", пенс: "GBP", фэн: "CNY",
    тиын: "KZT", тиин: "KZT", гяпик: "AZN", лум: "AMD", раппен: "CHF", сантим: null, филс: null,
  },
  glued: false,
  suffixes: [],
};

export const tr: Lexicon = {
  language: "tr",
  locale: "tr",
  numbers: {
    ...forms(["sıfır", "sifir"], u(0)),
    bir: u(1), iki: u(2), ...forms(["üç", "uc"], u(3)), ...forms(["dört", "dort"], u(4)),
    ...forms(["beş", "bes"], u(5)), ...forms(["altı", "alti"], u(6)), yedi: u(7), sekiz: u(8),
    dokuz: u(9), on: u(10), yirmi: u(20), otuz: u(30), ...forms(["kırk", "kirk"], u(40)), elli: u(50),
    ...forms(["altmış", "altmis"], u(60)), ...forms(["yetmiş", "yetmis"], u(70)), seksen: u(80),
    doksan: u(90), ...forms(["yüz", "yuz"], HUNDRED), bin: THOUSAND, milyon: MILLION, milyar: BILLION,
  },
  connectors: ["ve"],
  ignorable: ["yalnız", "yalniz", "yazıyla", "yaziyla", "toplam", "tutar", "tutarında", "tutarinda", "abd", "amerikan", "türk", "turk", "gürcü", "gurcu", "rus"],
  articles: [],
  vigesimal: false,
  compoundTeens: true,
  major: {
    avro: "EUR", euro: "EUR", dolar: "USD", lira: "TRY", tl: "TRY", ruble: "RUB", lari: "GEL", sterlin: "GBP", yuan: "CNY",
    tenge: "KZT", manat: "AZN/TMT", dram: "AMD", grivna: "UAH", frank: null, frang: null, dirhem: "AED/MAD",
  },
  qualifiers: {
    isviçre: { frank: "CHF", frang: "CHF" }, isvicre: { frank: "CHF", frang: "CHF" }, azerbaycan: { manat: "AZN" },
    türkmenistan: { manat: "TMT" }, turkmenistan: { manat: "TMT" }, bae: { dirhem: "AED" }, fas: { dirhem: "MAD" },
    kazak: {}, ermeni: {}, ukrayna: {},
  },
  minor: { kuruş: "TRY", kurus: "TRY", sent: null, cent: null, eurocent: "EUR", tetri: "GEL", kopek: "RUB", peni: "GBP" },
  glued: true,
  suffixes: ["sı", "si", "ı", "i"],
};

export const ka: Lexicon = {
  language: "ka",
  locale: "ka",
  numbers: {
    ნულ: u(0), ერთ: u(1), ორ: u(2), სამ: u(3), ოთხ: u(4), ხუთ: u(5), ექვს: u(6), შვიდ: u(7),
    // "რვ"/"ცხრ": elided forms before ათასი, as n2words writes them ("რვ ათას").
    რვა: u(8), რვ: u(8), ცხრა: u(9), ცხრ: u(9), ათ: u(10), თერთმეტ: u(11), თორმეტ: u(12), ცამეტ: u(13),
    თოთხმეტ: u(14), თხუთმეტ: u(15), თექვსმეტ: u(16), ჩვიდმეტ: u(17), თვრამეტ: u(18),
    ცხრამეტ: u(19), ოც: u(20), ორმოც: u(40), სამოც: u(60), ოთხმოც: u(80),
    ას: HUNDRED, ორას: u(200), სამას: u(300), ოთხას: u(400), ხუთას: u(500), ექვსას: u(600),
    შვიდას: u(700), რვაას: u(800), ცხრაას: u(900),
    ათას: THOUSAND, მილიონ: MILLION, მილიარდ: BILLION,
  },
  // "და" glues vigesimal numbers (ოცდაათი = 20 + 10) and joins major/minor parts.
  connectors: ["და"],
  ignorable: ["მხოლოდ", "სულ", "თანხა", "თანხით", "ოდენობით", "ოდენობა", "სიტყვიერად", "აშშ", "ამერიკულ", "თურქულ", "რუსულ", "ქართულ", "ინგლისურ"],
  articles: [],
  vigesimal: true,
  compoundTeens: false,
  major: {
    ევრო: "EUR", დოლარ: "USD", ლარ: "GEL", ლირ: "TRY", რუბლ: "RUB", ფუნტ: "GBP", იუან: "CNY",
    ტენგე: "KZT", მანათ: "AZN/TMT", დრამ: "AMD", გრივნა: "UAH", გრივნ: "UAH", ფრანკ: null, დირჰამ: "AED/MAD", დირჰემ: "AED/MAD",
  },
  qualifiers: {
    შვეიცარიულ: { ფრანკ: "CHF" }, აზერბაიჯანულ: { მანათ: "AZN" }, თურქმენულ: { მანათ: "TMT" },
    ყაზახურ: {}, სომხურ: {}, უკრაინულ: {},
  },
  minor: { ცენტ: null, ევროცენტ: "EUR", თეთრ: "GEL", ქურუშ: "TRY", კაპიკ: "RUB", პენს: "GBP" },
  glued: true,
  suffixes: ["ი", "ის", "ს", "ით"],
};

export const LEXICONS: Record<Lexicon["language"], Lexicon> = { en, ru, tr, ka };
