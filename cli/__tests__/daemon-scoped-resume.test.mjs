import { describe, expect, it, vi } from "vitest";
import { buildDaemon } from "../daemon.mjs";
import { executionKey } from "../session-anchor.mjs";

const ideaUuid = "11111111-1111-4111-8111-111111111111";
const taskUuid = "22222222-2222-4222-8222-222222222222";
const orchestrator = { type: "agent", uuid: "lead-agent", name: "Lead" };

function interruptDaemon(overrides = {}) {
  const daemon = buildDaemon({ url: "http://chorus.test", apiKey: "cho_test", agentUuid: "agent" }, {
    cwd: process.cwd(), logger: { info() {}, warn() {}, error() {} },
    mcpClient: {}, hooks: {}, spawner: {},
    lineage: { resolve: async () => ({ rootIdeaUuid: ideaUuid, directIdeaUuid: ideaUuid }) },
    makeSseListener: (options) => options,
    ...overrides,
  });
  const connection = daemon.connections[0];
  connection.connectionState.connectionUuid = "connection-1";
  return connection;
}

describe("daemon scoped interrupt facade", () => {
  it("reports scoped termination as user interruption without marking legacy or task siblings", async () => {
    const runs = [];
    const reportInterrupt = vi.fn();
    const advanceTurn = vi.fn(async ({ sessionId }) => ({ ok: true, data: { turnUuid: `turn-${sessionId}` } }));
    const connection = interruptDaemon({ reportInterrupt, advanceTurn,
      spawner: { wake: (params) => new Promise((resolve) => {
        params.onChild({});
        runs.push({ sessionId: params.sessionId, finish: (exitCode) => resolve({ sessionId: params.sessionId, exitCode, isNew: true }) });
      }) },
    });
    const pending = [];
    for (const sessionId of [ideaUuid, `task:${taskUuid}`, `review:task:${taskUuid}`]) {
      const notification = { sessionId, entityType: "task", entityUuid: taskUuid, action: "task_assigned", projectUuid: "project", entityTitle: "Task" };
      const resolved = await connection.waker.keyFor(notification);
      pending.push(connection.waker.wake(notification, resolved.key, resolved));
    }
    await vi.waitFor(() => expect(runs).toHaveLength(3));
    connection.sseListener.onControl({ type: "control", command: "interrupt", targetConnectionUuid: "connection-1",
      entityType: "task", entityUuid: taskUuid, sessionId: `review:task:${taskUuid}` });
    expect(connection.waker.interrupting.has(executionKey("task", taskUuid, `review:task:${taskUuid}`))).toBe(true);
    expect(connection.waker.interrupting.has(executionKey("task", taskUuid, `task:${taskUuid}`))).toBe(false);
    expect(connection.waker.interrupting.has(executionKey("task", taskUuid))).toBe(false);
    runs[2].finish(130);
    await pending[2];
    expect(reportInterrupt).toHaveBeenCalledExactlyOnceWith("task", taskUuid, "user", `review:task:${taskUuid}`);
    expect(advanceTurn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: `review:task:${taskUuid}`, status: "interrupted", interruptedReason: "user" }));
    expect(connection.waker.buildExecutionSnapshot().map((row) => row.sessionId)).toEqual(["", `task:${taskUuid}`]);
    runs[0].finish(0);
    runs[1].finish(0);
    await Promise.all(pending);
    expect(reportInterrupt).toHaveBeenCalledTimes(1);
  });

  it("cancels only the scoped admission across runtime Wakers", () => {
    const connection = interruptDaemon();
    const cancellations = [vi.fn(), vi.fn()];
    const sessionIds = ["", `review:task:${taskUuid}`];
    for (const [index, sessionId] of sessionIds.entries()) {
      const notification = { sessionId, entityType: "task", entityUuid: taskUuid,
        ...(sessionId ? { runtimeCwd: "/review-runtime" } : {}) };
      connection.waker.markQueued(notification, sessionId ? `session:${sessionId}` : `idea:${ideaUuid}`, { rootIdeaUuid: ideaUuid, directIdeaUuid: ideaUuid });
      Object.assign(connection.waker.executions.get(executionKey("task", taskUuid, sessionId)), {
        status: "running", admission: {}, cancelAdmission: cancellations[index],
      });
    }
    connection.sseListener.onControl({ type: "control", command: "interrupt", targetConnectionUuid: "connection-1",
      entityType: "task", entityUuid: taskUuid, sessionId: sessionIds[1] });
    expect(cancellations[1]).toHaveBeenCalledExactlyOnceWith();
    expect(cancellations[0]).not.toHaveBeenCalled();
    expect(connection.waker.interrupting.has(executionKey("task", taskUuid))).toBe(false);
  });
});

describe.each([false, true])("daemon control resume with routing metadata=%s", (withMetadata) => {
  it.each([undefined, "", `task:${taskUuid}`, `review:task:${taskUuid}`, `review:proposal:${taskUuid}`, `review:idea:${ideaUuid}`])(
    "forwards sessionId %s through the real control handler and router", async (sessionId) => {
      const daemon = buildDaemon({ url: "http://chorus.test", apiKey: "cho_test" }, {
        cwd: "/startup",
        logger: { info() {}, warn() {}, error() {} },
        mcpClient: {},
        lineage: { resolve: vi.fn(async () => ({ rootIdeaUuid: ideaUuid, directIdeaUuid: ideaUuid })) },
        spawner: {},
        makeSseListener: (options) => options,
      });
      const connection = daemon.connections[0];
      connection.connectionState.connectionUuid = "connection-1";
      const dispatch = vi.spyOn(connection.router, "dispatchResume");
      const enqueue = vi.spyOn(connection.queue, "enqueue").mockReturnValue(true);
      vi.spyOn(connection.waker, "markQueued").mockImplementation(() => {});

      connection.sseListener.onControl({
        type: "control", command: "resume", targetConnectionUuid: "connection-1",
        entityType: "task", entityUuid: taskUuid, resumeReason: "crash",
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(withMetadata ? { runtimeCwd: "/work/task", orchestrator } : {}),
      });

      expect(dispatch).toHaveBeenCalledExactlyOnceWith({
        entityType: "task", entityUuid: taskUuid, resumeReason: "crash",
        runtimeCwd: withMetadata ? "/work/task" : undefined,
        orchestrator: withMetadata ? orchestrator : sessionId ? null : undefined,
        ...(sessionId ? { sessionId } : {}),
      });
      await expect(dispatch.mock.results[0].value).resolves.toEqual({ status: "accepted" });
      expect(enqueue).toHaveBeenCalledExactlyOnceWith(
        sessionId ? `session:${sessionId}` : `idea:${ideaUuid}`,
        expect.objectContaining({ notification: {
          action: "resource_resumed", entityType: "task", entityUuid: taskUuid, resumedFrom: "crash",
          ...(sessionId ? { sessionId } : {}),
          ...(withMetadata ? { runtimeCwd: "/work/task", orchestrator } : {}),
        } }),
      );
    },
  );
});
