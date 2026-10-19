import { describe, expect, it } from "vitest";
import { DISPLAY_NAME_MAX_LENGTH, displayNameLength, displayNameSchema } from "../display-name";

describe("display name validation", () => {
  it("uses a shared 32-code-point limit", () => {
    expect(DISPLAY_NAME_MAX_LENGTH).toBe(32);
    expect(displayNameLength("  😀  ")).toBe(1);
    expect(displayNameLength("e\u0301")).toBe(2);
    expect(displayNameLength("👩‍💻")).toBe(3);
    expect(displayNameLength(" \t\n ")).toBe(0);
  });

  it.each(["a", "中", "😀", "a".repeat(32), "中".repeat(32), "😀".repeat(32), "e\u0301".repeat(16)])("accepts valid code-point boundaries: %s", name => {
    expect(displayNameSchema.parse(name)).toBe(name);
  });

  it("trims outer whitespace, preserves internal spaces and does not normalize", () => {
    expect(displayNameSchema.parse(" \t e\u0301  名 \n")).toBe("e\u0301  名");
  });

  it.each([
    "", " \t\n\u00a0 ", "a".repeat(33), "中".repeat(33), "😀".repeat(33),
    "👩‍💻".repeat(11), `${"e\u0301".repeat(16)}a`, "\uD800", "\uDC00",
    "valid\uD800name", "\uDC00\uD800", "\uD800😀", "😀\uDC00", "a\u0000b",
    null, undefined, 32, {}, [], true,
  ])("rejects invalid name %j", name => {
    expect(displayNameSchema.safeParse(name).success).toBe(false);
  });
});
