import { describe, expect, it } from "vitest";
import {
  add,
  compare,
  dec,
  equals,
  isCanonicalDecimal,
  mul,
  parseDecimal,
  sub,
  sum,
  toCanonical,
  toFixed,
  within,
} from "../src/decimal.ts";

describe("parseDecimal", () => {
  it("accepts canonical decimals", () => {
    for (const text of ["0", "13300", "13300.00", "-5", "0.125", "1880.5"]) {
      expect(isCanonicalDecimal(text)).toBe(true);
      expect(parseDecimal(text)).not.toBeNull();
    }
  });

  it("rejects formatted or ambiguous numbers instead of guessing", () => {
    for (const text of ["13,300.00", "13 300,00", "1e5", "", ".5", "5.", "+5", "EUR 10", "١٢"]) {
      expect(parseDecimal(text)).toBeNull();
    }
  });
});

describe("arithmetic", () => {
  it("is exact where floats are not", () => {
    expect(toCanonical(add(dec("0.1"), dec("0.2")))).toBe("0.3");
  });

  it("matches the KA fixture invoice", () => {
    const lines = [mul(dec("60"), dec("145.00")), mul(dec("40"), dec("115.00"))];
    expect(toFixed(lines[0]!, 2)).toBe("8700.00");
    expect(toFixed(lines[1]!, 2)).toBe("4600.00");
    expect(equals(sum(lines), dec("13300.00"))).toBe(true);
  });

  it("compares independent of scale", () => {
    expect(compare(dec("1.50"), dec("1.5"))).toBe(0);
    expect(compare(dec("-2"), dec("1"))).toBe(-1);
    expect(compare(dec("1880"), dec("1680"))).toBe(1);
  });

  it("checks tolerance", () => {
    expect(within(dec("1880.4"), dec("1880"), dec("0.5"))).toBe(true);
    expect(within(dec("1881"), dec("1880"), dec("0.5"))).toBe(false);
    expect(toCanonical(sub(dec("1880"), dec("1680.25")))).toBe("199.75");
  });
});

describe("formatting", () => {
  it("prints canonical and fixed forms", () => {
    expect(toCanonical(dec("13300.00"))).toBe("13300");
    expect(toCanonical(dec("0.0500"))).toBe("0.05");
    expect(toCanonical(dec("-0.00"))).toBe("0");
    expect(toFixed(dec("13300"), 2)).toBe("13300.00");
    expect(toFixed(dec("2.345"), 2)).toBe("2.35");
    expect(toFixed(dec("-2.345"), 2)).toBe("-2.35");
    expect(toFixed(dec("0.004"), 2)).toBe("0.00");
  });
});
