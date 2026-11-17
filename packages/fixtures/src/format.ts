/** How numbers and dates are printed on a pack's documents. */
export interface NumberStyle {
  thousands: string;
  decimal: string;
  /** 18.09.2026, 14 Oct 2026, or the month first as in the United States: 10/14/2026. */
  date: "dmy-dot" | "d-mon-y" | "mdy-slash";
}

export const STYLES = {
  /** 13,300.00 · 18.09.2026 (as on the original Georgian test pack) */
  ka: { thousands: ",", decimal: ".", date: "dmy-dot" },
  /** 15,500.00 · 14 Oct 2026 */
  en: { thousands: ",", decimal: ".", date: "d-mon-y" },
  /** 20 820,00 · 05.10.2026 */
  ru: { thousands: " ", decimal: ",", date: "dmy-dot" },
  /** 9.684,00 · 20.10.2026 */
  tr: { thousands: ".", decimal: ",", date: "dmy-dot" },
} as const satisfies Record<string, NumberStyle>;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatter(style: NumberStyle) {
  /** Canonical decimal string -> printed form. */
  const number = (canonical: string): string => {
    const negative = canonical.startsWith("-");
    const [whole = "0", fraction] = (negative ? canonical.slice(1) : canonical).split(".");
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, style.thousands);
    return `${negative ? "-" : ""}${grouped}${fraction !== undefined ? style.decimal + fraction : ""}`;
  };
  const date = (iso: string): string => {
    const [y, m, d] = iso.split("-");
    if (style.date === "mdy-slash") return `${m}/${d}/${y}`;
    return style.date === "dmy-dot" ? `${d}.${m}.${y}` : `${d} ${MONTHS[Number(m) - 1]} ${y}`;
  };
  return { number, date };
}

export type Formatter = ReturnType<typeof formatter>;
