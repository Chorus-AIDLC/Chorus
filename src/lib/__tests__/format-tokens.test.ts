import { describe, it, expect } from "vitest";
import { formatTokens } from "../format-tokens";

describe("formatTokens", () => {
  describe("values under 1000", () => {
    it("returns '0' for 0", () => {
      expect(formatTokens(0)).toBe("0");
    });

    it("returns the number as-is for small values", () => {
      expect(formatTokens(1)).toBe("1");
      expect(formatTokens(42)).toBe("42");
      expect(formatTokens(742)).toBe("742");
    });

    it("returns '999' at the boundary", () => {
      expect(formatTokens(999)).toBe("999");
    });
  });

  describe("k range (1000 to 999999)", () => {
    it("formats 1000 as '1k'", () => {
      expect(formatTokens(1000)).toBe("1k");
    });

    it("formats 1234 as '1.2k'", () => {
      expect(formatTokens(1234)).toBe("1.2k");
    });

    it("formats 3800 as '3.8k'", () => {
      expect(formatTokens(3800)).toBe("3.8k");
    });

    it("strips trailing zero: 5000 -> '5k' not '5.0k'", () => {
      expect(formatTokens(5000)).toBe("5k");
    });

    it("formats 999999 at the upper boundary", () => {
      expect(formatTokens(999999)).toBe("1000k");
    });

    it("formats 10500 as '10.5k'", () => {
      expect(formatTokens(10500)).toBe("10.5k");
    });

    it("formats 100000 as '100k'", () => {
      expect(formatTokens(100000)).toBe("100k");
    });
  });

  describe("M range (1000000+)", () => {
    it("formats 1000000 as '1M'", () => {
      expect(formatTokens(1000000)).toBe("1M");
    });

    it("formats 1234567 as '1.2M'", () => {
      expect(formatTokens(1234567)).toBe("1.2M");
    });

    it("formats 1500000 as '1.5M'", () => {
      expect(formatTokens(1500000)).toBe("1.5M");
    });

    it("strips trailing zero: 2000000 -> '2M' not '2.0M'", () => {
      expect(formatTokens(2000000)).toBe("2M");
    });

    it("formats large values like 150000000 as '150M'", () => {
      expect(formatTokens(150000000)).toBe("150M");
    });
  });

  describe("negative values", () => {
    it("preserves negative prefix for small values", () => {
      expect(formatTokens(-42)).toBe("-42");
    });

    it("formats -1234 as '-1.2k'", () => {
      expect(formatTokens(-1234)).toBe("-1.2k");
    });

    it("formats -1234567 as '-1.2M'", () => {
      expect(formatTokens(-1234567)).toBe("-1.2M");
    });

    it("formats -999 as '-999'", () => {
      expect(formatTokens(-999)).toBe("-999");
    });
  });

  describe("non-finite and null/undefined values", () => {
    it("returns '0' for NaN", () => {
      expect(formatTokens(NaN)).toBe("0");
    });

    it("returns '0' for Infinity", () => {
      expect(formatTokens(Infinity)).toBe("0");
    });

    it("returns '0' for -Infinity", () => {
      expect(formatTokens(-Infinity)).toBe("0");
    });

    it("returns '0' for null", () => {
      expect(formatTokens(null)).toBe("0");
    });

    it("returns '0' for undefined", () => {
      expect(formatTokens(undefined)).toBe("0");
    });
  });

  describe("rounding", () => {
    it("rounds fractional input to nearest integer before formatting", () => {
      expect(formatTokens(999.4)).toBe("999");
      expect(formatTokens(999.5)).toBe("1k");
    });
  });
});
