import { describe, expect, it, vi } from "vitest";
import { buildDaemon } from "../daemon.mjs";
import { Waker } from "../waker.mjs";

const silent = { info() {}, warn() {}, error() {} };
const creds = { url: "http://chorus.test", apiKey: "cho_test" };

describe("directed runtime cwd isolation", () => {
  it("creates one isolated Waker context per runtime cwd without adding connections", () => {
    const daemon = buildDaemon(creds, {
      cwd: "/startup",
      browseRoots: ["/work"],
      logger: silent,
      mcpClient: {},
      lineage: { resolve: vi.fn() },
      spawner: {},
      sseListener: {},
    });
    const connection = daemon.connections[0];

    connection.waker.markQueued(
      { entityType: "task", entityUuid: "task-a", runtimeCwd: "/work/a" },
      "idea:a",
      {},
    );
    connection.waker.markQueued(
      { entityType: "task", entityUuid: "task-b", runtimeCwd: "/work/b" },
      "idea:b",
      {},
    );

    expect(connection.runtimeWakers.size).toBe(3);
    expect(daemon.connections).toHaveLength(1);
    expect(connection.runtimeWakers.get("/work/a")).not.toBe(
      connection.runtimeWakers.get("/work/b"),
    );
  });

  it("revalidates immediately before probe and spawn and uses the normalized cwd for both", async () => {
    const calls = [];
    const waker = new Waker({
      creds,
      cwd: "/startup",
      logger: silent,
      lineage: { resolve: async () => ({ rootIdeaUuid: null, directIdeaUuid: null }) },
      validateRuntimeCwd: async (cwd) => {
        calls.push(["validate", cwd]);
        return { normalizedPath: "/work/normalized" };
      },
      isNewSessionFn: (sessionId, cwd) => {
        calls.push(["probe", cwd]);
        return true;
      },
      writeMcpConfigFn: () => ({ path: "/tmp/mcp.json", cleanup() {} }),
      spawner: {
        wake: async ({ cwd }) => {
          calls.push(["spawn", cwd]);
          return { sessionId: "11111111-1111-4111-8111-111111111111", exitCode: 0, isNew: true };
        },
      },
    });

    await waker.wake(
      {
        action: "task_assigned",
        entityType: "task",
        entityUuid: "11111111-1111-4111-8111-111111111111",
        runtimeCwd: "/work/raw",
      },
      "entity:task:11111111-1111-4111-8111-111111111111",
      {},
    );

    expect(calls.slice(0, 3)).toEqual([
      ["validate", "/work/raw"],
      ["probe", "/work/normalized"],
      ["spawn", "/work/normalized"],
    ]);
  });

  it("reports an invalid directed cwd as an explicit terminal turn state", async () => {
    const advanceTurn = vi.fn(async () => ({ ok: true }));
    const error = Object.assign(new Error("outside configured roots"), {
      code: "OUTSIDE_ROOT",
    });
    const waker = new Waker({
      creds,
      cwd: "/startup",
      logger: silent,
      lineage: { resolve: async () => ({ rootIdeaUuid: null, directIdeaUuid: null }) },
      validateRuntimeCwd: async () => {
        throw error;
      },
      advanceTurn,
      spawner: { wake: vi.fn() },
    });

    await waker.wake(
      {
        action: "task_assigned",
        entityType: "task",
        entityUuid: "11111111-1111-4111-8111-111111111111",
        runtimeCwd: "/outside",
      },
      "entity:task:11111111-1111-4111-8111-111111111111",
      {},
    );

    expect(advanceTurn).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ status: "running" }),
    );
    expect(advanceTurn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        status: "interrupted",
        interruptedReason: "invalid_path",
        transcriptRelayError: "OUTSIDE_ROOT: outside configured roots",
      }),
    );
  });
});
