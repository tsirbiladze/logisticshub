import { toCardinal as enCardinal } from "n2words/en";
import { toCardinal as kaCardinal } from "n2words/ka";
import { toCardinal as ruCardinal } from "n2words/ru";
import { toCardinal as trCardinal } from "n2words/tr";
import { describe, expect, it } from "vitest";
import { toFixed } from "../src/decimal.ts";
import { detectWordsLanguage, parseAmountInWords, type WordsLanguage } from "../src/words/index.ts";

function read(text: string, language?: WordsLanguage) {
  const result = parseAmountInWords(text, language);
  if (!result.ok) throw new Error(`${text}: ${result.error.message}`);
  const { amount, currency, language: detected } = result.value;
  return { amount: toFixed(amount, amount.scale), currency, language: detected };
}

describe("phrases as they appear on documents", () => {
  const cases: [string, string, string | null][] = [
    // Georgian (synthetic KA pack invoice)
    ["ცამეტი ათას სამასი ევრო და ნული ცენტი", "13300.00", "EUR"],
    ["თორმეტ ათას ოთხას ორმოცდაათი ლარი სამოცდათხუთმეტი თეთრი", "12450.75", "GEL"],
    ["ორი ათას ლარი", "2000", "GEL"],
    ["ორ ათას ლარი", "2000", "GEL"],
    ["ცამეტი ათასი აშშ დოლარი", "13000", "USD"],
    ["ას ორმოცდაათი ლარის ოდენობით", "150", "GEL"],
    // English
    ["Thirteen Thousand Three Hundred Euro Only", "13300", "EUR"],
    ["SAY US DOLLARS THIRTEEN THOUSAND THREE HUNDRED AND CENTS FIFTY ONLY", "13300.50", "USD"],
    ["Thirteen thousand three hundred euros and 00/100", "13300.00", "EUR"],
    ["one hundred and twenty-one roubles fifty kopecks", "121.50", "RUB"],
    ["fifteen hundred U.S. dollars", "1500", "USD"],
    // Russian
    ["Тринадцать тысяч триста евро 00 центов", "13300.00", "EUR"],
    ["сто двадцать один рубль пятьдесят копеек", "121.50", "RUB"],
    ["тринадцати тысяч трёхсот евро", "13300", "EUR"],
    ["Одна тысяча девятьсот девяносто девять долларов США", "1999", "USD"],
    // Turkish
    ["YALNIZ ONÜÇBİNÜÇYÜZ AVRO SIFIR SENT", "13300.00", "EUR"],
    ["on üç bin üç yüz Türk Lirası elli kuruş", "13300.50", "TRY"],
    ["ON UC BIN UC YUZ TURK LIRASI", "13300", "TRY"],
    ["yalnız ikiyüzaltmışbeş ABD doları", "265", "USD"],
    // "and" before trailing cents splits the main amount from the cents
    ["SAY US DOLLARS FIFTEEN THOUSAND FIVE HUNDRED AND FIFTY CENTS ONLY", "15500.50", "USD"],
    ["US Dollars twenty and five cents", "20.05", "USD"],
    ["one hundred and five euro", "105", "EUR"],
    // the currency before and after the number
    ["EUR thirteen thousand three hundred euros and 00 cents", "13300.00", "EUR"],
    ["Euro: thirteen thousand three hundred euro and fifty cents", "13300.50", "EUR"],
    // euro-cent compounds
    ["thirteen thousand three hundred euros and fifty euro cents", "13300.50", "EUR"],
    ["fifty euro cents", "0.50", "EUR"],
    ["Тринадцать тысяч триста евро 00 евроцентов", "13300.00", "EUR"],
    ["ცამეტი ათას სამასი ევრო 50 ევროცენტი", "13300.50", "EUR"],
    ["ორმოცდაათი ევროცენტი", "0.50", "EUR"],
    ["Yalnız on üç bin üç yüz Avro sıfır Euro Cent", "13300.00", "EUR"],
    // "a hundred", "no cents", "no/100"
    ["a hundred US dollars", "100", "USD"],
    ["a thousand five hundred euro", "1500", "EUR"],
    ["an amount of a hundred and five euros", "105", "EUR"],
    ["Fifteen thousand five hundred US dollars and no cents", "15500.00", "USD"],
    ["Fifteen thousand five hundred and no/100 US dollars", "15500.00", "USD"],
    // Georgian counts in twenties, Turkish builds its teens from ten
    ["ოცდაათი ლარი", "30", "GEL"],
    ["ოთხმოცდაცხრამეტი ლარი", "99", "GEL"],
    ["on bir lira", "11", "TRY"],
    ["yüz on dokuz lira", "119", "TRY"],
    // the region's currencies
    ["fifteen thousand five hundred tenge", "15500", "KZT"],
    ["Fifteen thousand Kazakhstani tenge 00 tiyn", "15000.00", "KZT"],
    ["two thousand Azerbaijani manats", "2000", "AZN"],
    ["two thousand Turkmen manat", "2000", "TMT"],
    ["two thousand manat", "2000", "AZN/TMT"],
    ["five hundred Swiss francs", "500", "CHF"],
    ["five hundred francs", "500", null],
    ["CHF five hundred", "500", "CHF"],
    ["one thousand UAE dirhams", "1000", "AED"],
    ["one thousand dirhams", "1000", "AED/MAD"],
    ["ten thousand Armenian drams", "10000", "AMD"],
    ["twelve thousand hryvnias", "12000", "UAH"],
    ["Пятнадцать тысяч пятьсот казахстанских тенге 00 тиын", "15500.00", "KZT"],
    ["две тысячи азербайджанских манатов", "2000", "AZN"],
    ["пятьсот швейцарских франков", "500", "CHF"],
    ["двенадцать тысяч гривен 50 копеек", "12000.50", "UAH"],
    ["десять тысяч армянских драмов", "10000", "AMD"],
    ["одна тысяча дирхамов ОАЭ", "1000", "AED"],
    ["YALNIZ BEŞBİN TENGE", "5000", "KZT"],
    ["yalnız iki bin Azerbaycan manatı", "2000", "AZN"],
    ["BEŞ YÜZ ISVICRE FRANGI", "500", "CHF"],
    ["on bin Ermeni dramı", "10000", "AMD"],
    ["on iki bin grivna", "12000", "UAH"],
    ["bin BAE dirhemi", "1000", "AED"],
    ["თხუთმეტი ათას ხუთასი ტენგე", "15500", "KZT"],
    ["ორი ათასი აზერბაიჯანული მანათი", "2000", "AZN"],
    ["ორი ათასი მანათი", "2000", "AZN/TMT"],
    ["ხუთასი შვეიცარიული ფრანკი", "500", "CHF"],
    ["ათი ათასი სომხური დრამი", "10000", "AMD"],
    ["თორმეტი ათასი უკრაინული გრივნის ოდენობით", "12000", "UAH"],
    // more words after a currency inside one Turkish token; "долл."
    ["Yalnız #BinİkiyüzTürkLirasıElliKuruş#", "1200.50", "TRY"],
    ["YALNIZ #BİNİKİYÜZABDDOLARIELLİSENT#", "1200.50", "USD"],
    ["Тринадцать тысяч триста долл. США 00 центов", "13300.00", "USD"],
  ];

  it.each(cases)("%s", (text, amount, currency) => {
    expect(read(text)).toMatchObject({ amount, currency });
  });
});

describe("round trip against n2words", () => {
  const cardinals: Record<WordsLanguage, (n: number) => string> = {
    en: enCardinal,
    ru: ruCardinal,
    tr: trCardinal,
    ka: kaCardinal,
  };

  // Deterministic sample: 0..1100 plus pseudo-random values up to ~2 billion.
  const numbers: number[] = Array.from({ length: 1101 }, (_, i) => i);
  let seed = 20261109;
  for (let i = 0; i < 1500; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    numbers.push(i % 3 === 0 ? seed % 1_000_000 : seed);
  }

  for (const [language, toWords] of Object.entries(cardinals) as [WordsLanguage, (n: number) => string][]) {
    it(`${language}: ${numbers.length} numbers`, () => {
      const failures: string[] = [];
      for (const n of numbers) {
        const words = toWords(n);
        const result = parseAmountInWords(words, language);
        if (!result.ok || result.value.major !== BigInt(n)) {
          failures.push(`${n} "${words}" -> ${result.ok ? result.value.major : result.error.message}`);
        }
      }
      expect(failures.slice(0, 5)).toEqual([]);
    });
  }
});

describe("refuses to guess", () => {
  it.each([
    ["five twenty euro", "INVALID_SEQUENCE"],
    ["five five", "INVALID_SEQUENCE"],
    ["one thousand one thousand", "INVALID_SEQUENCE"],
    ["thirteen thousand banana euro", "UNKNOWN_WORD"],
    ["ten euro twenty euro", "AMBIGUOUS"],
    ["ten euro one hundred cents", "MINOR_OUT_OF_RANGE"],
    ["euro only", "EMPTY"],
    // a currency or cent word that belongs to no number
    ["thirteen thousand euro dollars", "AMBIGUOUS"],
    ["fifty dollars cents", "AMBIGUOUS"],
    // no currency word to split off: 15550 cents, not 15500.50
    ["fifteen thousand five hundred and fifty cents", "MINOR_OUT_OF_RANGE"],
    ["one thousand eurocents", "MINOR_OUT_OF_RANGE"],
  ])("%s -> %s", (text, code) => {
    const result = parseAmountInWords(text, "en");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(code);
  });

  it.each<[string, "en" | "ru" | "tr" | "ka", string]>([
    // tens after tens or teens, a unit after a teen: nothing to add up
    ["THIRTY TWENTY dollars", "en", "thirty twenty"],
    ["twenty thirteen euro", "en", "twenty thirteen"],
    ["ten one euro", "en", "ten one"],
    ["nineteen one euro", "en", "nineteen one"],
    ["one hundred thirty twenty euro", "en", "one hundred thirty twenty"],
    ["двадцать десять рублей", "ru", "двадцать десять"],
    ["тридцать пятнадцать рублей", "ru", "тридцать пятнадцать"],
    ["сто двести рублей", "ru", "сто двести"],
    ["yirmi on lira", "tr", "yirmi on"],
    ["otuz yirmi lira", "tr", "otuz yirmi"],
    ["ოცდაოცი ლარი", "ka", "ოც ოც"],
    ["ათი ცხრა ლარი", "ka", "ათ ცხრა"],
  ])("%s is not a number", (text, language, phrase) => {
    expect(parseAmountInWords(text, language)).toMatchObject({ ok: false, error: { code: "INVALID_SEQUENCE", word: phrase } });
  });

  it("an article is one only before hundred, thousand or million", () => {
    expect(parseAmountInWords("a dollar", "en")).toMatchObject({ ok: false, error: { code: "EMPTY" } });
    expect(parseAmountInWords("a five dollars", "en")).toMatchObject({ ok: true, value: { major: 5n } });
    expect(parseAmountInWords("a million dollars", "en")).toMatchObject({ ok: true, value: { major: 1000000n } });
  });

  it("treats inherited object keys as unknown words, not numbers", () => {
    for (const word of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      const result = parseAmountInWords(`thirteen thousand ${word} euro`, "en");
      expect(result).toMatchObject({ ok: false, error: { code: "UNKNOWN_WORD" } });
    }
  });

  it("stays fast on long nonsense glued words", () => {
    const started = Date.now();
    const result = parseAmountInWords(`${"onon".repeat(40)}x`, "tr");
    expect(result.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("names the unknown word", () => {
    const result = parseAmountInWords("ცამეტი ათას სამასი ბანანი", "ka");
    expect(result).toMatchObject({ ok: false, error: { code: "UNKNOWN_WORD", word: "ბანანი" } });
  });

  it("names the invalid number phrase", () => {
    expect(parseAmountInWords("five twenty euro", "en")).toMatchObject({ ok: false, error: { code: "INVALID_SEQUENCE", word: "five twenty" } });
  });
});

describe("language fallback", () => {
  it("tries the detected language when the stated one fails", () => {
    expect(parseAmountInWords("Twenty thousand euro", "ka")).toMatchObject({
      ok: true,
      value: { language: "en", currency: "EUR", amount: { units: 20000n, scale: 0 } },
    });
  });

  it("reports the error of the language the words are in when both fail", () => {
    // English words on a Georgian document: the unknown word is "banana", not the first English word.
    expect(parseAmountInWords("twenty banana euro", "ka")).toMatchObject({ ok: false, error: { code: "UNKNOWN_WORD", word: "banana" } });
    // Russian words on an English document.
    expect(parseAmountInWords("пятнадцать тысяч бананов тенге", "en")).toMatchObject({ ok: false, error: { code: "UNKNOWN_WORD", word: "бананов" } });
    expect(parseAmountInWords("пятнадцать тысяч пятьсот тенге", "en")).toMatchObject({
      ok: true,
      value: { language: "ru", currency: "KZT", amount: { units: 15500n, scale: 0 } },
    });
    // Unmarked Latin text only defaults to English: a Turkish document's error stays Turkish.
    expect(parseAmountInWords("on on", "tr")).toMatchObject({ ok: false, error: { code: "INVALID_SEQUENCE", word: "on on" } });
    expect(parseAmountInWords("yirmi banana lira", "en")).toMatchObject({ ok: false, error: { code: "UNKNOWN_WORD", word: "banana" } });
  });
});

describe("detectWordsLanguage", () => {
  it.each([
    ["ცამეტი ათასი", "ka"],
    ["тринадцать тысяч", "ru"],
    ["on üç bin", "tr"],
    ["YALNIZ ONUCBIN", "tr"],
    ["thirteen thousand", "en"],
  ])("%s -> %s", (text, language) => {
    expect(detectWordsLanguage(text)).toBe(language);
  });
});
