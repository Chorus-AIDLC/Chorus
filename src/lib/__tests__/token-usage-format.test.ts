import { describe, expect, it } from "vitest";
import { formatCompactTokens, headlineTokenTotal } from "@/lib/token-usage-format";

describe("formatCompactTokens", () => {
  it("shows counts under 1000 verbatim", () => {
    expect(formatCompactTokens(0)).toBe("0");
    expect(formatCompactTokens(312)).toBe("312");
    expect(formatCompactTokens(999)).toBe("999");
  });

  it("compacts thousands with one decimal, trimming a trailing .0", () => {
    expect(formatCompactTokens(1000)).toBe("1k");
    expect(formatCompactTokens(1540)).toBe("1.5k");
    expect(formatCompactTokens(5000)).toBe("5k");
    expect(formatCompactTokens(24701)).toBe("24.7k");
  });

  it("compacts millions", () => {
    expect(formatCompactTokens(1_000_000)).toBe("1M");
    expect(formatCompactTokens(2_350_000)).toBe("2.4M");
  });

  it("never renders NaN/null — a bad input is '0'", () => {
    expect(formatCompactTokens(null)).toBe("0");
    expect(formatCompactTokens(undefined)).toBe("0");
    expect(formatCompactTokens(-5)).toBe("0");
    expect(formatCompactTokens(Number.NaN)).toBe("0");
  });
});

describe("headlineTokenTotal", () => {
  it("sums input + output, treating null as 0", () => {
    expect(headlineTokenTotal(1200, 340)).toBe(1540);
    expect(headlineTokenTotal(1200, null)).toBe(1200);
    expect(headlineTokenTotal(null, null)).toBe(0);
    expect(headlineTokenTotal(undefined, 7)).toBe(7);
  });

  it("does NOT include cache (cache is passed separately, never here)", () => {
    // Only two args by contract — a caller cannot accidentally fold cache in.
    expect(headlineTokenTotal(10, 20)).toBe(30);
  });
});
