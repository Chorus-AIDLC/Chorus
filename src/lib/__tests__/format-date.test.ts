import { describe, it, expect } from "vitest";
import { formatDateTime } from "../format-date";

describe("formatDateTime", () => {
  it("formats a Date in YYYY-MM-DD HH:mm local-time format", () => {
    const d = new Date(2026, 3, 5, 9, 7);
    expect(formatDateTime(d)).toBe("2026-04-05 09:07");
  });

  it("accepts ISO string input", () => {
    const result = formatDateTime("2026-04-21T10:00:00.000Z");
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it("pads single-digit month, day, hour, minute with zero", () => {
    const d = new Date(2026, 0, 1, 0, 0);
    expect(formatDateTime(d)).toBe("2026-01-01 00:00");
  });

  it("uses 24-hour clock", () => {
    const d = new Date(2026, 3, 5, 23, 45);
    expect(formatDateTime(d)).toBe("2026-04-05 23:45");
  });
});
