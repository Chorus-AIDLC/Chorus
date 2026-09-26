import { describe, expect, it } from "vitest";
import { referenceUuid, safeReferenceUrl } from "@/lib/reference-citations";

const uuid = "550e8400-e29b-41d4-a716-446655440000";

describe("reference destinations", () => {
  it("normalizes complete UUIDs, including uppercase", () => {
    expect(referenceUuid(`ref:${uuid}`)).toBe(uuid);
    expect(referenceUuid(`REF:${uuid.toUpperCase()}`)).toBe(uuid);
  });

  it.each([undefined, "ref:123", `ref:${uuid}/`, `ref:${uuid}?x=1`,
    `ref:${uuid}#fragment`, `ref:${uuid}\n`, `https://example.com/${uuid}`,
    `ref://${uuid}`, `ref: ${uuid}`, `ref:${uuid.replace("5", "g")}`])(
    "rejects incomplete or ambiguous identity %s",
    (value) => expect(referenceUuid(value)).toBeNull(),
  );

  it.each(["javascript:alert(1)", "data:text/html,test", "file:///tmp/a", "//example.com", "/relative", "ftp://example.com", "not a URL"])(
    "disables unsafe evidence URL %s",
    (value) => expect(safeReferenceUrl(value)).toBeUndefined(),
  );

  it("accepts HTTP(S), including uppercase schemes", () => {
    expect(safeReferenceUrl("https://example.com/a?q=1#x")).toBe("https://example.com/a?q=1#x");
    expect(safeReferenceUrl("HTTP://example.com")).toBe("http://example.com/");
  });
});
