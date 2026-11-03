import { describe, expect, it, vi } from "vitest";
import { buildDaemon } from "../daemon.mjs";

const ideaUuid = "11111111-1111-4111-8111-111111111111";
const taskUuid = "22222222-2222-4222-8222-222222222222";
const orchestrator = { type: "agent", uuid: "lead-agent", name: "Lead" };

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
