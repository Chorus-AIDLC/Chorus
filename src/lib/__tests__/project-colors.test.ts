import { describe, it, expect } from "vitest";
import { getProjectInitials, getProjectIconColor } from "../project-colors";

describe("getProjectInitials", () => {
  it("returns first letters of two words", () => {
    expect(getProjectInitials("Chorus App")).toBe("CA");
  });

  it("returns first two chars for single word", () => {
    expect(getProjectInitials("Chorus")).toBe("CH");
  });

  it("handles extra whitespace", () => {
    expect(getProjectInitials("  Hello   World  ")).toBe("HW");
  });
});

describe("getProjectIconColor", () => {
  it("returns bg and text colors", () => {
    const color = getProjectIconColor("Test Project");
    expect(color).toHaveProperty("bg");
    expect(color).toHaveProperty("text");
    expect(color.bg).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(color.text).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  it("returns consistent color for same name", () => {
    const a = getProjectIconColor("My Project");
    const b = getProjectIconColor("My Project");
    expect(a).toEqual(b);
  });

  it("returns different colors for different names", () => {
    const a = getProjectIconColor("Alpha");
    const b = getProjectIconColor("Beta");
    // Not guaranteed but highly likely with different names
    expect(a.bg !== b.bg || a.text !== b.text).toBe(true);
  });
});
