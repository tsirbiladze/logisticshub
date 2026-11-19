import type { CheckResult } from "../check/index.ts";
import type { ReportLanguage } from "../check/messages.ts";
import { REGISTRY_FIELDS, type RegistryEntry } from "../registry.ts";

export const REGISTRY_LABELS = {
  en: ["Revenue Service registry", "Source", "Party", "Snapshot time (UTC)", "Could not be checked", "Reply status", "Reply message", "Full name", "Status", "Registered subject", "Identification code assigned", "VAT payer", "Mortgage", "Sequestration", "Additional status", "Non-resident"],
  ka: ["შემოსავლების სამსახურის რეესტრი", "წყარო", "მხარე", "ჩანაწერის დრო (UTC)", "შემოწმება ვერ მოხერხდა", "პასუხის კოდი", "პასუხის ტექსტი", "სრული სახელი", "სტატუსი", "რეგისტრირებული სუბიექტი", "საიდენტიფიკაციო კოდის მინიჭება", "დღგ-ის გადამხდელი", "გირავნობა ან იპოთეკა", "ყადაღა", "დამატებითი სტატუსი", "არარეზიდენტი"],
  ru: ["Реестр Службы доходов", "Источник", "Сторона", "Время запроса (UTC)", "Не удалось проверить", "Код ответа", "Сообщение", "Полное название", "Статус", "Зарегистрированный субъект", "Дата присвоения кода", "Плательщик НДС", "Залог или ипотека", "Арест имущества", "Дополнительный статус", "Нерезидент"],
  tr: ["Gelir İdaresi sicili", "Kaynak", "Taraf", "Sorgu zamanı (UTC)", "Kontrol edilemedi", "Yanıt kodu", "Yanıt mesajı", "Tam ad", "Durum", "Kayıtlı kişi veya kuruluş", "Kimlik kodu verilme tarihi", "KDV mükellefi", "Rehin veya ipotek", "Haciz", "Ek durum", "Yerleşik olmayan"],
} as const;

export function registryView({ snapshot, parties }: NonNullable<CheckResult["registry"]>, language: ReportLanguage) {
  const [title, source, party, time, unavailable, replyStatus, replyMessage, ...fieldLabels] = REGISTRY_LABELS[language];
  const byCode = new Map<string, Set<string>>();
  for (const { code, name } of parties) {
    const names = byCode.get(code) ?? new Set<string>();
    if (name) names.add(name);
    byCode.set(code, names);
  }
  const replies = new Map<string, RegistryEntry>(snapshot.entries.map((entry) => [entry.code, entry]));
  const codes = new Set([...byCode.keys(), ...replies.keys()]);
  return {
    title,
    source: { label: source, value: snapshot.sourceUrl },
    labels: { party, time, unavailable, replyStatus, replyMessage, ...Object.fromEntries(REGISTRY_FIELDS.map((field, i) => [field, fieldLabels[i]!])) as Record<(typeof REGISTRY_FIELDS)[number], string> },
    entries: [...codes].map((code) => {
      const names = [...(byCode.get(code) ?? [])];
      const reply = replies.get(code);
      const checked = reply && ("answer" in reply ? reply.answer.length > 0 : "Status" in reply.error && reply.error.Status === -1);
      return { code, parties: names, checkedAt: reply?.checkedAt ?? null, ...(reply && ("answer" in reply ? { answer: reply.answer } : { error: reply.error })), checked: Boolean(checked) };
    }),
  };
}

type RegistryView = ReturnType<typeof registryView>;

export function registryRows({ labels }: RegistryView, entry: RegistryView["entries"][number]): [string, string][] {
  const rows: [string, string][] = [[labels.party, entry.parties.join(" · ") || "—"], [labels.time, entry.checkedAt ?? "—"]];
  if (!entry.checked) rows.push([labels.unavailable, ""]);
  if ("error" in entry) {
    if ("Status" in entry.error) rows.push([labels.replyStatus, String(entry.error.Status)], [labels.replyMessage, entry.error.Message]);
    else rows.push([labels.replyMessage, entry.error.transport]);
  }
  for (const answer of "answer" in entry ? entry.answer : []) {
    for (const field of REGISTRY_FIELDS) rows.push([labels[field]!, answer[field]]);
  }
  return rows;
}
