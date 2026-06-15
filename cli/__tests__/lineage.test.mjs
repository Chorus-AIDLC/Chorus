// cli/__tests__/lineage.test.mjs
// Covers cli-daemon spec "Lineage-anchored session continuity" (resolution half),
// including the server-first / client-walk-fallback behavior.
import { describe, it, expect } from "vitest";
import { LineageResolver } from "../lineage.mjs";

const silent = { info() {}, warn() {}, error() {} };

/**
 * Build a fake MCP client from fixture maps. By default the server-side
 * chorus_resolve_root_idea tool is UNAVAILABLE (returns null, like an older
 * server) so the resolver exercises the client-side fallback walk — this keeps
 * the original walk fixtures meaningful. Pass `resolveRootIdea` to make the
 * server tool answer (the server-first path).
 * @param {object} [opts]
 * @param {(args:{entityType:string,entityUuid:string}) => any} [opts.resolveRootIdea]
 *   When provided, chorus_resolve_root_idea returns its result; otherwise null.
 */
function fakeMcp({ tasks = {}, proposals = {}, ideas = {}, resolveRootIdea } = {}) {
  return {
    calls: [],
    async callTool(name, args) {
      this.calls.push([name, args]);
      if (name === "chorus_resolve_root_idea") {
        return resolveRootIdea ? resolveRootIdea(args) : null;
      }
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

describe("LineageResolver server-first resolution", () => {
  it("uses the server resolver's rootIdeaUuid and skips the client walk", async () => {
    const mcp = fakeMcp({
      // Client-walk fixtures intentionally absent — if the walk ran it'd return null.
      resolveRootIdea: () => ({
        rootIdeaUuid: "server-root",
        lineage: [{ type: "task", uuid: "t1", title: "T1" }],
        resolvedVia: "via_proposal",
      }),
    });
    const r = new LineageResolver({ mcpClient: mcp, logger: silent });
    const root = await r.rootIdeaFor({ entityType: "task", entityUuid: "t1" });

    expect(root).toBe("server-root");
    // server-first: the client-walk tools were never called
    expect(mcp.calls.map((c) => c[0])).toEqual(["chorus_resolve_root_idea"]);
  });

  it("treats a well-formed null from the server as authoritative (no fallback)", async () => {
    const mcp = fakeMcp({
      // If the fallback walk ran on this task it would resolve to "would-be-root".
      tasks: { t1: { proposalUuid: "p1" } },
      proposals: { p1: { inputType: "idea", inputUuids: ["would-be-root"] } },
      ideas: { "would-be-root": { parentUuid: null } },
      resolveRootIdea: () => ({ rootIdeaUuid: null, lineage: [], resolvedVia: "no_proposal" }),
    });
    const r = new LineageResolver({ mcpClient: mcp, logger: silent });
    const root = await r.rootIdeaFor({ entityType: "task", entityUuid: "t1" });

    expect(root).toBeNull(); // server's null wins
    expect(mcp.calls.map((c) => c[0])).toEqual(["chorus_resolve_root_idea"]); // no walk
  });

  it("falls back to the client walk when the server tool is unavailable (returns null)", async () => {
    // resolveRootIdea omitted → tool returns null (older server / unknown tool).
    const mcp = fakeMcp({
      tasks: { t1: { proposalUuid: "p1" } },
      proposals: { p1: { inputType: "idea", inputUuids: ["child"] } },
      ideas: { child: { parentUuid: "root" }, root: { parentUuid: null } },
    });
    const r = new LineageResolver({ mcpClient: mcp, logger: silent });
    const root = await r.rootIdeaFor({ entityType: "task", entityUuid: "t1" });

    expect(root).toBe("root"); // resolved via the fallback walk
    const names = mcp.calls.map((c) => c[0]);
    expect(names[0]).toBe("chorus_resolve_root_idea"); // tried server first
    expect(names).toContain("chorus_get_task"); // then walked client-side
  });

  it("falls back when the server tool throws (unknown-tool / persistent error)", async () => {
    const mcp = {
      calls: [],
      async callTool(name, args) {
        this.calls.push([name, args]);
        if (name === "chorus_resolve_root_idea") {
          throw new Error("MCP error -32601: Method not found");
        }
        if (name === "chorus_get_idea") return { a: { parentUuid: null } }[args.ideaUuid] ?? null;
        return null;
      },
    };
    const r = new LineageResolver({ mcpClient: mcp, logger: silent });
    const root = await r.rootIdeaFor({ entityType: "idea", entityUuid: "a" });

    expect(root).toBe("a"); // fallback walk handled it
    expect(mcp.calls.map((c) => c[0])).toContain("chorus_get_idea");
  });

  it("falls back on a non-conforming server shape (missing rootIdeaUuid)", async () => {
    const mcp = fakeMcp({
      ideas: { solo: { parentUuid: null } },
      resolveRootIdea: () => ({ unexpected: "shape" }), // no rootIdeaUuid field
    });
    const r = new LineageResolver({ mcpClient: mcp, logger: silent });
    const root = await r.rootIdeaFor({ entityType: "idea", entityUuid: "solo" });

    expect(root).toBe("solo"); // fell back to the walk
    expect(mcp.calls.map((c) => c[0])).toContain("chorus_get_idea");
  });

  it("single-flights the cache across the server path (one resolve call per key)", async () => {
    let serverCalls = 0;
    const mcp = fakeMcp({
      resolveRootIdea: () => {
        serverCalls++;
        return { rootIdeaUuid: "server-root", lineage: [], resolvedVia: "root_idea" };
      },
    });
    const r = new LineageResolver({ mcpClient: mcp, logger: silent });
    await r.rootIdeaFor({ entityType: "idea", entityUuid: "x" });
    await r.rootIdeaFor({ entityType: "idea", entityUuid: "x" });

    expect(serverCalls).toBe(1); // second call served from cache
  });

  it("logs which path was taken (server vs fallback) — no silent attribution", async () => {
    const infos = [];
    const logger = { ...silent, info: (m) => infos.push(m) };

    const serverMcp = fakeMcp({
      resolveRootIdea: () => ({ rootIdeaUuid: "r", lineage: [], resolvedVia: "root_idea" }),
    });
    await new LineageResolver({ mcpClient: serverMcp, logger }).rootIdeaFor({
      entityType: "idea",
      entityUuid: "x",
    });
    expect(infos.some((m) => /lineage\(server\)/.test(m))).toBe(true);

    infos.length = 0;
    const fallbackMcp = fakeMcp({ ideas: { y: { parentUuid: null } } }); // tool unavailable
    await new LineageResolver({ mcpClient: fallbackMcp, logger }).rootIdeaFor({
      entityType: "idea",
      entityUuid: "y",
    });
    expect(infos.some((m) => /lineage\(fallback\)/.test(m))).toBe(true);
  });
});
