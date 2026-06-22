import { describe, it, expect } from "vitest";
import {
  parseMentions,
  compareMentionables,
  type Mentionable,
} from "@/services/mention.service";

// ===== Test helpers =====

function onlineAgent(name: string, activeCount: number): Mentionable {
  return { type: "agent", uuid: `${name}-uuid`, name, online: true, activeCount };
}
function offlineAgent(name: string): Mentionable {
  return { type: "agent", uuid: `${name}-uuid`, name, online: false, activeCount: 0 };
}
function user(name: string): Mentionable {
  return { type: "user", uuid: `${name}-uuid`, name };
}

// ===== compareMentionables (pure comparator) =====

describe("compareMentionables", () => {
  it("ranks an online agent before a user", () => {
    expect(compareMentionables(onlineAgent("Bot", 0), user("Alice"))).toBeLessThan(0);
    expect(compareMentionables(user("Alice"), onlineAgent("Bot", 0))).toBeGreaterThan(0);
  });

  it("ranks an online agent before an offline agent", () => {
    expect(compareMentionables(onlineAgent("Bot", 0), offlineAgent("Idle"))).toBeLessThan(0);
    expect(compareMentionables(offlineAgent("Idle"), onlineAgent("Bot", 0))).toBeGreaterThan(0);
  });

  it("ranks an offline agent before a user", () => {
    expect(compareMentionables(offlineAgent("Idle"), user("Alice"))).toBeLessThan(0);
    expect(compareMentionables(user("Alice"), offlineAgent("Idle"))).toBeGreaterThan(0);
  });

  it("orders two online agents by activeCount ascending (idle first)", () => {
    expect(compareMentionables(onlineAgent("Busy", 2), onlineAgent("Free", 0))).toBeGreaterThan(0);
    expect(compareMentionables(onlineAgent("Free", 0), onlineAgent("Busy", 2))).toBeLessThan(0);
  });

  it("tie-breaks two online agents with equal activeCount by name (localeCompare asc)", () => {
    expect(compareMentionables(onlineAgent("Bravo", 1), onlineAgent("Alpha", 1))).toBeGreaterThan(0);
    expect(compareMentionables(onlineAgent("Alpha", 1), onlineAgent("Bravo", 1))).toBeLessThan(0);
  });

  it("treats missing activeCount on an online agent as 0", () => {
    const noCount: Mentionable = { type: "agent", uuid: "x", name: "X", online: true };
    // noCount (0) should precede an agent with activeCount 1
    expect(compareMentionables(noCount, onlineAgent("Y", 1))).toBeLessThan(0);
  });

  it("returns 0 for two offline agents (same rank → stable order preserved)", () => {
    expect(compareMentionables(offlineAgent("A"), offlineAgent("B"))).toBe(0);
  });

  it("returns 0 for two users (same rank → stable order preserved)", () => {
    expect(compareMentionables(user("A"), user("B"))).toBe(0);
  });

  it("sorts a mixed list online-first, then offline agents, then users", () => {
    const list: Mentionable[] = [
      user("Zoe"),
      offlineAgent("OffBot"),
      onlineAgent("BusyBot", 3),
      user("Amy"),
      onlineAgent("IdleBot", 0),
    ];
    const sorted = [...list].sort(compareMentionables);
    expect(sorted.map((m) => m.name)).toEqual([
      "IdleBot", // online, activeCount 0
      "BusyBot", // online, activeCount 3
      "OffBot", // offline agent
      "Zoe", // user (stable: came before Amy)
      "Amy",
    ]);
  });
});

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
