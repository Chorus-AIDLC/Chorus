// cli/__tests__/lineage.test.mjs
// Covers cli-daemon spec "Lineage-anchored session continuity" (resolution half).
import { describe, it, expect } from "vitest";
import { LineageResolver } from "../lineage.mjs";

const silent = { info() {}, warn() {}, error() {} };

/** Build a fake MCP client from fixture maps. */
function fakeMcp({ tasks = {}, proposals = {}, ideas = {} } = {}) {
  return {
    calls: [],
    async callTool(name, args) {
      this.calls.push([name, args]);
      if (name === "chorus_get_task") return tasks[args.taskUuid] ?? null;
      if (name === "chorus_get_proposal") return proposals[args.proposalUuid] ?? null;
      if (name === "chorus_get_idea") return ideas[args.ideaUuid] ?? null;
      return null;
    },
  };
}

describe("LineageResolver.rootIdeaFor", () => {
  it("resolves a task → proposal → idea → root", async () => {
    const mcp = fakeMcp({
      tasks: { t1: { proposalUuid: "p1" } },
      proposals: { p1: { inputType: "idea", inputUuids: ["child-idea"] } },
      ideas: {
        "child-idea": { parentUuid: "root-idea" },
        "root-idea": { parentUuid: null },
      },
    });
    const r = new LineageResolver({ mcpClient: mcp, logger: silent });
    const root = await r.rootIdeaFor({ entityType: "task", entityUuid: "t1" });
    expect(root).toBe("root-idea");
  });

  it("resolves an idea event by walking parentUuid to the top", async () => {
    const mcp = fakeMcp({
      ideas: {
        a: { parentUuid: "b" },
        b: { parentUuid: "c" },
        c: { parentUuid: null },
      },
    });
    const r = new LineageResolver({ mcpClient: mcp, logger: silent });
    expect(await r.rootIdeaFor({ entityType: "idea", entityUuid: "a" })).toBe("c");
  });

  it("a top-level idea is its own root", async () => {
    const mcp = fakeMcp({ ideas: { solo: { parentUuid: null } } });
    const r = new LineageResolver({ mcpClient: mcp, logger: silent });
    expect(await r.rootIdeaFor({ entityType: "idea", entityUuid: "solo" })).toBe("solo");
  });

  it("returns null for a quick task with no proposal (no idea ancestor)", async () => {
    const mcp = fakeMcp({ tasks: { t: { proposalUuid: null } } });
    const r = new LineageResolver({ mcpClient: mcp, logger: silent });
    expect(await r.rootIdeaFor({ entityType: "task", entityUuid: "t" })).toBeNull();
  });

  it("returns null when proposal is document-typed (no idea input)", async () => {
    const mcp = fakeMcp({
      tasks: { t: { proposalUuid: "p" } },
      proposals: { p: { inputType: "document", inputUuids: ["doc"] } },
    });
    const r = new LineageResolver({ mcpClient: mcp, logger: silent });
    expect(await r.rootIdeaFor({ entityType: "task", entityUuid: "t" })).toBeNull();
  });

  it("stops on a parent cycle without infinite-looping", async () => {
    const warns = [];
    const mcp = fakeMcp({
      ideas: { a: { parentUuid: "b" }, b: { parentUuid: "a" } },
    });
    const r = new LineageResolver({ mcpClient: mcp, logger: { ...silent, warn: (m) => warns.push(m) } });
    const root = await r.rootIdeaFor({ entityType: "idea", entityUuid: "a" });
    expect(["a", "b"]).toContain(root); // returns last-good, doesn't hang
    expect(warns.join("")).toMatch(/cycle/i);
  });

  it("caches resolution within a run (no duplicate MCP calls)", async () => {
    const mcp = fakeMcp({ ideas: { solo: { parentUuid: null } } });
    const r = new LineageResolver({ mcpClient: mcp, logger: silent });
    await r.rootIdeaFor({ entityType: "idea", entityUuid: "solo" });
    await r.rootIdeaFor({ entityType: "idea", entityUuid: "solo" });
    expect(mcp.calls.filter((c) => c[0] === "chorus_get_idea")).toHaveLength(1);
  });

  it("returns null (not throw) on a missing entityUuid", async () => {
    const mcp = fakeMcp({});
    const r = new LineageResolver({ mcpClient: mcp, logger: silent });
    expect(await r.rootIdeaFor({ entityType: "task" })).toBeNull();
  });

  it("returns null (not throw) when an MCP call errors", async () => {
    const mcp = {
      async callTool() {
        throw new Error("network down");
      },
    };
    const r = new LineageResolver({ mcpClient: mcp, logger: silent });
    expect(await r.rootIdeaFor({ entityType: "task", entityUuid: "t" })).toBeNull();
  });
});
