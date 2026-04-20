import { describe, it, expect } from "vitest";
import {
  attributeTokenUsage,
  findPrimaryEntity,
  type TurnUsage,
  type TimelineEntry,
} from "@/services/observability.service";

const companyUuid = "company-0000";
const agentUuid = "agent-0000";
const sessionUuid = "session-0000";

const taskA = "task-aaaa";
const taskB = "task-bbbb";
const ideaC = "idea-cccc";
const proposalD = "proposal-dddd";

function turn(ts: string, output: number, input = 0, cacheRead = 0, cacheCreate = 0): TurnUsage {
  return {
    ts,
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreate,
  };
}

function tl(ts: string, entityType: string, entityUuid: string): TimelineEntry {
  return { ts, entity_type: entityType, entity_uuid: entityUuid };
}

describe("findPrimaryEntity", () => {
  it("returns null for empty timeline", () => {
    expect(findPrimaryEntity([])).toBeNull();
  });

  it("picks task over proposal over idea over document", () => {
    const timeline = [
      tl("2026-04-20T01:00:00Z", "idea", ideaC),
      tl("2026-04-20T01:01:00Z", "proposal", proposalD),
      tl("2026-04-20T01:02:00Z", "document", "doc-0000"),
    ];
    const result = findPrimaryEntity(timeline);
    expect(result?.entity_type).toBe("proposal");
    expect(result?.entity_uuid).toBe(proposalD);
  });

  it("picks task when present alongside idea", () => {
    const timeline = [
      tl("2026-04-20T01:00:00Z", "idea", ideaC),
      tl("2026-04-20T01:01:00Z", "task", taskA),
    ];
    const result = findPrimaryEntity(timeline);
    expect(result?.entity_type).toBe("task");
    expect(result?.entity_uuid).toBe(taskA);
  });

  it("returns the first entity with highest priority when tied", () => {
    const timeline = [
      tl("2026-04-20T01:00:00Z", "task", taskA),
      tl("2026-04-20T01:01:00Z", "task", taskB),
    ];
    const result = findPrimaryEntity(timeline);
    expect(result?.entity_uuid).toBe(taskA);
  });
});

describe("attributeTokenUsage", () => {
  it("returns empty array for empty turns", () => {
    const result = attributeTokenUsage([], [], sessionUuid, agentUuid, companyUuid);
    expect(result).toEqual([]);
  });

  // --- Sub-agent (sessionUuid set): all turns → primary entity ---

  it("sub-agent: all turns attributed to primary entity", () => {
    const turns = [
      turn("2026-04-20T01:00:10Z", 500, 10000, 5000, 200),
      turn("2026-04-20T01:01:00Z", 300, 8000, 4000, 100),
    ];
    const timeline = [
      tl("2026-04-20T01:00:05Z", "task", taskA),
    ];

    const result = attributeTokenUsage(turns, timeline, sessionUuid, agentUuid, companyUuid);

    expect(result).toHaveLength(2);
    expect(result[0].entityType).toBe("task");
    expect(result[0].entityUuid).toBe(taskA);
    expect(result[0].inputTokens).toBe(10000);
    expect(result[0].outputTokens).toBe(500);
    expect(result[1].entityType).toBe("task");
    expect(result[1].entityUuid).toBe(taskA);
    expect(result[1].inputTokens).toBe(8000);
  });

  it("sub-agent: turns before first timeline entry also get primary entity", () => {
    const turns = [
      turn("2026-04-20T01:00:00Z", 100, 15000),
      turn("2026-04-20T01:05:00Z", 200),
    ];
    const timeline = [
      tl("2026-04-20T01:03:00Z", "task", taskA),
    ];

    const result = attributeTokenUsage(turns, timeline, sessionUuid, agentUuid, companyUuid);

    expect(result).toHaveLength(2);
    expect(result[0].entityType).toBe("task");
    expect(result[0].entityUuid).toBe(taskA);
    expect(result[0].inputTokens).toBe(15000);
    expect(result[1].entityType).toBe("task");
    expect(result[1].entityUuid).toBe(taskA);
  });

  it("sub-agent reviewer: proposal is primary even when idea is read first", () => {
    const turns = [
      turn("2026-04-20T01:00:00Z", 100, 20000),
      turn("2026-04-20T01:01:00Z", 200, 15000),
      turn("2026-04-20T01:02:00Z", 300, 10000),
    ];
    const timeline = [
      tl("2026-04-20T01:00:30Z", "idea", ideaC),
      tl("2026-04-20T01:01:30Z", "proposal", proposalD),
    ];

    const result = attributeTokenUsage(turns, timeline, sessionUuid, agentUuid, companyUuid);

    expect(result).toHaveLength(3);
    for (const r of result) {
      expect(r.entityType).toBe("proposal");
      expect(r.entityUuid).toBe(proposalD);
    }
    expect(result[0].inputTokens).toBe(20000);
    expect(result[1].inputTokens).toBe(15000);
    expect(result[2].inputTokens).toBe(10000);
  });

  it("sub-agent: empty timeline → null entity for all turns", () => {
    const turns = [
      turn("2026-04-20T01:00:10Z", 500, 10000),
    ];

    const result = attributeTokenUsage(turns, [], sessionUuid, agentUuid, companyUuid);

    expect(result).toHaveLength(1);
    expect(result[0].entityType).toBeNull();
    expect(result[0].entityUuid).toBeNull();
    expect(result[0].inputTokens).toBe(10000);
  });

  // --- Main agent (sessionUuid=null): carry-forward per turn ---

  it("main agent: carry-forward across timeline entries", () => {
    const turns = [
      turn("2026-04-20T01:00:10Z", 100),
      turn("2026-04-20T01:00:30Z", 200),
      turn("2026-04-20T01:01:30Z", 300),
    ];
    const timeline = [
      tl("2026-04-20T01:00:05Z", "task", taskA),
      tl("2026-04-20T01:01:00Z", "idea", ideaC),
    ];

    const result = attributeTokenUsage(turns, timeline, null, agentUuid, companyUuid);

    expect(result).toHaveLength(3);
    expect(result[0].entityUuid).toBe(taskA);
    expect(result[1].entityUuid).toBe(taskA);
    expect(result[2].entityUuid).toBe(ideaC);
  });

  it("main agent: turns before first timeline entry get null entity", () => {
    const turns = [
      turn("2026-04-20T01:00:00Z", 100, 15000),
      turn("2026-04-20T01:05:00Z", 200),
    ];
    const timeline = [
      tl("2026-04-20T01:03:00Z", "task", taskA),
    ];

    const result = attributeTokenUsage(turns, timeline, null, agentUuid, companyUuid);

    expect(result).toHaveLength(2);
    expect(result[0].entityType).toBeNull();
    expect(result[0].entityUuid).toBeNull();
    expect(result[1].entityType).toBe("task");
    expect(result[1].entityUuid).toBe(taskA);
  });

  it("main agent: splits turns across multiple entities by timeline", () => {
    const turns = [
      turn("2026-04-20T01:00:10Z", 400),
      turn("2026-04-20T01:02:10Z", 600),
    ];
    const timeline = [
      tl("2026-04-20T01:00:05Z", "task", taskA),
      tl("2026-04-20T01:01:00Z", "task", taskB),
    ];

    const result = attributeTokenUsage(turns, timeline, null, agentUuid, companyUuid);

    expect(result).toHaveLength(2);
    expect(result[0].entityUuid).toBe(taskA);
    expect(result[1].entityUuid).toBe(taskB);
  });

  // --- Common behaviors ---

  it("includes zero output_tokens turns (they still have input)", () => {
    const turns = [
      turn("2026-04-20T01:00:10Z", 0, 5000),
    ];
    const timeline = [
      tl("2026-04-20T01:00:05Z", "task", taskA),
    ];

    const result = attributeTokenUsage(turns, timeline, sessionUuid, agentUuid, companyUuid);

    expect(result).toHaveLength(1);
    expect(result[0].entityType).toBe("task");
    expect(result[0].inputTokens).toBe(5000);
    expect(result[0].outputTokens).toBe(0);
  });

  it("preserves sessionUuid on all records, projectUuid null (resolved server-side)", () => {
    const turns = [turn("2026-04-20T01:00:10Z", 100, 200)];
    const timeline = [tl("2026-04-20T01:00:05Z", "task", taskA)];

    const result = attributeTokenUsage(turns, timeline, sessionUuid, agentUuid, companyUuid);

    for (const r of result) {
      expect(r.companyUuid).toBe(companyUuid);
      expect(r.agentUuid).toBe(agentUuid);
      expect(r.sessionUuid).toBe(sessionUuid);
      expect(r.projectUuid).toBeNull();
    }
  });

  it("sets sourceSessionId and turnTimestamp for dedup", () => {
    const turns = [turn("2026-04-20T01:00:10Z", 100, 200)];

    const result = attributeTokenUsage(turns, [], null, agentUuid, companyUuid, "cc-session-123");

    expect(result).toHaveLength(1);
    expect(result[0].sourceSessionId).toBe("cc-session-123");
    expect(result[0].turnTimestamp).toEqual(new Date("2026-04-20T01:00:10Z"));
  });

  it("main agent: no timeline and no entity → null", () => {
    const turns = [
      turn("2026-04-20T01:00:00Z", 100, 5000),
    ];
    const result = attributeTokenUsage(turns, [], null, agentUuid, companyUuid);

    expect(result).toHaveLength(1);
    expect(result[0].inputTokens).toBe(5000);
    expect(result[0].outputTokens).toBe(100);
    expect(result[0].entityType).toBeNull();
  });
});
