/**
 * Exact decimal arithmetic for money, quantities and weights.
 *
 * Values travel as canonical decimal strings ("13300.00", "-5", "0.125"):
 * optional leading "-", digits, optional "." and digits. No thousands
 * separators, no exponent. Floats are never used, so 0.1 + 0.2 === 0.3.
 */

export interface Decimal {
  /** value = units / 10^scale */
  readonly units: bigint;
  readonly scale: number;
}

const CANONICAL = /^-?\d+(\.\d+)?$/;

export function isCanonicalDecimal(text: string): boolean {
  return CANONICAL.test(text);
}

/** Parses a canonical decimal string. Returns null for anything else. */
export function parseDecimal(text: string): Decimal | null {
  if (!CANONICAL.test(text)) return null;
  const negative = text.startsWith("-");
  const body = negative ? text.slice(1) : text;
  const [whole = "0", fraction = ""] = body.split(".");
  const units = BigInt(whole + fraction);
  return { units: negative ? -units : units, scale: fraction.length };
}

function rescale(value: Decimal, scale: number): bigint {
  return value.units * 10n ** BigInt(scale - value.scale);
}

function align(a: Decimal, b: Decimal): [bigint, bigint, number] {
  const scale = Math.max(a.scale, b.scale);
  return [rescale(a, scale), rescale(b, scale), scale];
}

export function add(a: Decimal, b: Decimal): Decimal {
  const [x, y, scale] = align(a, b);
  return { units: x + y, scale };
}

export function sub(a: Decimal, b: Decimal): Decimal {
  const [x, y, scale] = align(a, b);
  return { units: x - y, scale };
}

export function mul(a: Decimal, b: Decimal): Decimal {
  return { units: a.units * b.units, scale: a.scale + b.scale };
}

export function sum(values: readonly Decimal[]): Decimal {
  return values.reduce(add, ZERO);
}

/** -1, 0 or 1. Scale-insensitive: "1.50" equals "1.5". */
export function compare(a: Decimal, b: Decimal): -1 | 0 | 1 {
  const [x, y] = align(a, b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function equals(a: Decimal, b: Decimal): boolean {
  return compare(a, b) === 0;
}

export function abs(value: Decimal): Decimal {
  return value.units < 0n ? { units: -value.units, scale: value.scale } : value;
}

/** True when |a - b| <= tolerance. */
export function within(a: Decimal, b: Decimal, tolerance: Decimal): boolean {
  return compare(abs(sub(a, b)), tolerance) <= 0;
}

/** Canonical string without trailing fractional zeros: 13300.00 -> "13300". */
export function toCanonical(value: Decimal): string {
  if (value.units === 0n) return "0";
  const negative = value.units < 0n;
  let digits = (negative ? -value.units : value.units).toString();
  let scale = value.scale;
  while (scale > 0 && digits.endsWith("0") && digits.length > 1) {
    digits = digits.slice(0, -1);
    scale -= 1;
  }
  if (scale > 0) {
    digits = digits.padStart(scale + 1, "0");
    digits = `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  }
  return negative && digits !== "0" ? `-${digits}` : digits;
}

/** Fixed number of fraction digits, half-up rounding: 13300 -> "13300.00". */
export function toFixed(value: Decimal, fractionDigits: number): string {
  let units = value.units;
  const diff = value.scale - fractionDigits;
  if (diff > 0) {
    const factor = 10n ** BigInt(diff);
    const half = factor / 2n;
    units = (units + (units < 0n ? -half : half)) / factor;
  } else if (diff < 0) {
    units = units * 10n ** BigInt(-diff);
  }
  return toCanonicalFixed({ units, scale: fractionDigits });
}

function toCanonicalFixed(value: Decimal): string {
  const negative = value.units < 0n;
  let digits = (negative ? -value.units : value.units).toString();
  if (value.scale > 0) {
    digits = digits.padStart(value.scale + 1, "0");
    digits = `${digits.slice(0, -value.scale)}.${digits.slice(-value.scale)}`;
  }
  return negative ? `-${digits}` : digits;
}

export const ZERO: Decimal = { units: 0n, scale: 0 };

/** Shorthand for literals in code and tests. Throws on non-canonical input. */
export function dec(text: string): Decimal {
  const value = parseDecimal(text);
  if (!value) throw new Error(`Not a canonical decimal: ${JSON.stringify(text)}`);
  return value;
}
