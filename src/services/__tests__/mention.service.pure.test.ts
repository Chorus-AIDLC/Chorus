import { describe, it, expect } from "vitest";
import { parseMentions } from "@/services/mention.service";

// ===== parseMentions =====

describe("parseMentions", () => {
  it("should parse a single user mention", () => {
    const content = "Hello @[Alice](user:12345678-1234-1234-1234-123456789abc)!";
    const result = parseMentions(content);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: "user",
      uuid: "12345678-1234-1234-1234-123456789abc",
      displayName: "Alice",
    });
  });

  it("should parse a single agent mention", () => {
    const content = "Assigned to @[DevBot](agent:abcdef12-3456-7890-abcd-ef1234567890).";
    const result = parseMentions(content);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: "agent",
      uuid: "abcdef12-3456-7890-abcd-ef1234567890",
      displayName: "DevBot",
    });
  });

  it("should parse multiple mentions", () => {
    const content =
      "@[Alice](user:11111111-1111-1111-1111-111111111111) and @[Bob](user:22222222-2222-2222-2222-222222222222) are working on this.";
    const result = parseMentions(content);
    expect(result).toHaveLength(2);
    expect(result[0].displayName).toBe("Alice");
    expect(result[1].displayName).toBe("Bob");
  });

  it("should deduplicate mentions with same type:uuid", () => {
    const uuid = "11111111-1111-1111-1111-111111111111";
    const content = `@[Alice](user:${uuid}) said hello, then @[Alice](user:${uuid}) said goodbye.`;
    const result = parseMentions(content);
    expect(result).toHaveLength(1);
  });

  it("should enforce max 10 mentions limit", () => {
    const mentions = Array.from({ length: 15 }, (_, i) => {
      const hex = i.toString(16).padStart(12, "0");
      return `@[User${i}](user:00000000-0000-0000-0000-${hex})`;
    });
    const content = mentions.join(" ");
    const result = parseMentions(content);
    expect(result).toHaveLength(10);
  });

  it("should return empty array for empty string", () => {
    expect(parseMentions("")).toHaveLength(0);
  });

  it("should return empty array for content with no mentions", () => {
    expect(parseMentions("This is just plain text.")).toHaveLength(0);
  });

  it("should not match malformed mentions (missing brackets)", () => {
    const content = "@Alice(user:11111111-1111-1111-1111-111111111111)";
    expect(parseMentions(content)).toHaveLength(0);
  });

  it("should not match malformed mentions (invalid UUID format)", () => {
    const content = "@[Alice](user:not-a-valid-uuid)";
    expect(parseMentions(content)).toHaveLength(0);
  });

  it("should not match malformed mentions (wrong type)", () => {
    const content = "@[Alice](admin:11111111-1111-1111-1111-111111111111)";
    expect(parseMentions(content)).toHaveLength(0);
  });

  it("should handle mixed user and agent mentions", () => {
    const content =
      "@[Alice](user:11111111-1111-1111-1111-111111111111) cc @[Bot](agent:22222222-2222-2222-2222-222222222222)";
    const result = parseMentions(content);
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe("user");
    expect(result[1].type).toBe("agent");
  });

  it("should be case-insensitive for type and uuid", () => {
    const content = "@[Alice](User:AABBCCDD-1111-2222-3333-444455556666)";
    const result = parseMentions(content);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("user");
    expect(result[0].uuid).toBe("aabbccdd-1111-2222-3333-444455556666");
  });

  it("should handle display names with spaces", () => {
    const content = "@[John Doe](user:11111111-1111-1111-1111-111111111111)";
    const result = parseMentions(content);
    expect(result).toHaveLength(1);
    expect(result[0].displayName).toBe("John Doe");
  });

  it("should handle mentions embedded in markdown", () => {
    const content = "**Bold** @[Alice](user:11111111-1111-1111-1111-111111111111) *italic*";
    const result = parseMentions(content);
    expect(result).toHaveLength(1);
    expect(result[0].displayName).toBe("Alice");
  });

  it("should handle consecutive calls (regex state reset)", () => {
    const content = "@[Alice](user:11111111-1111-1111-1111-111111111111)";
    // Call twice to verify regex lastIndex is reset
    const result1 = parseMentions(content);
    const result2 = parseMentions(content);
    expect(result1).toHaveLength(1);
    expect(result2).toHaveLength(1);
  });
});
