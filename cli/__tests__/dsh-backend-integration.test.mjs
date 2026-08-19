import { describe, expect, it, vi } from "vitest";
import { buildDaemon } from "../daemon.mjs";
import { ClaudeSpawner } from "../claude-spawner.mjs";
import { DshSpawner } from "../dsh-spawner.mjs";
import { killProcessTree } from "../process-killer.mjs";
import { createTranscriptUploadHooks } from "../upload-hooks.mjs";
import { Waker } from "../waker.mjs";

const CREDS = { url: "https://chorus.test", apiKey: "cho_test" };
const logger = { info() {}, warn() {}, error() {} };
const DIRECT_IDEA = "33333333-3333-4333-8333-333333333333";
const DSH_SESSION = "chorus-dsh-session";
const NOTIFICATION = {
  uuid: "notif-dsh-1",
  projectUuid: "proj-1",
  entityType: "task",
  entityUuid: "task-dsh-1",
  entityTitle: "Dsh task",
  action: "task_assigned",
  message: "",
  actorType: "user",
  actorUuid: "user-1",
  actorName: "Alice",
};

function dshUser(text) {
  return {
    type: "user/message",
    session_id: DSH_SESSION,
    data: { message: { role: "user", content: [{ type: "text", text }] } },
  };
}

function dshAssistant(text) {
  return {
    type: "assistant/message",
    session_id: DSH_SESSION,
    data: {
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private chain of thought" },
          { type: "text", text },
        ],
      },
    },
  };
}

function dshCompleted(usage) {
  return {
    type: "dsh.turn.completed",
    session_id: DSH_SESSION,
    usage: { ...usage, model: "deepseek-v4-flash", source: "dsh" },
  };
}

function makeComposedWaker(streams) {
  let wakeIndex = 0;
  const spawner = {
    sessionDecision: { probeIsAuthoritative: false },
    wake: vi.fn(async ({ onChild, onMessage }) => {
      onChild?.({ pid: 4321, on() {}, kill() {} });
      for (const frame of streams[wakeIndex++] ?? []) onMessage?.(frame);
      return {
        sessionId: DSH_SESSION,
        backendSessionId: DSH_SESSION,
        exitCode: 0,
        isNew: true,
      };
    }),
  };
  const transcriptPosts = [];
  const hooks = createTranscriptUploadHooks({
    url: CREDS.url,
    apiKey: CREDS.apiKey,
    logger,
    batchDelayMs: 60_000,
    fetchImpl: vi.fn(async (url, init) => {
      transcriptPosts.push({ url: String(url), body: JSON.parse(init.body) });
      return { ok: true, status: 200, async json() { return { success: true, data: {} }; } };
    }),
  });
  const advanceCalls = [];
  const waker = new Waker({
    creds: CREDS,
    lineage: { resolve: async () => ({ rootIdeaUuid: DIRECT_IDEA, directIdeaUuid: DIRECT_IDEA }) },
    spawner,
    cwd: "/work/dir",
    hooks,
    logger,
    writeMcpConfigFn: vi.fn(() => ({ path: "/tmp/m.json", cleanup: vi.fn() })),
    isNewSessionFn: vi.fn(() => true),
    reportInterrupt: vi.fn(async () => {}),
    advanceTurn: vi.fn(async (payload) => advanceCalls.push(payload)),
  });
  return { waker, transcriptPosts, advanceCalls };
}

describe("dsh backend daemon integration", () => {
  it("selects DshSpawner only for dsh and leaves the default unchanged", () => {
    expect(buildDaemon(CREDS, { logger }).spawner).toBeInstanceOf(ClaudeSpawner);
    const prepareManagedDshConfig = vi.fn();
    const daemon = buildDaemon(CREDS, {
      logger,
      agentType: "dsh",
      bundleVersion: "0.16.3",
      prepareManagedDshConfig,
    });
    expect(daemon.spawner).toBeInstanceOf(DshSpawner);
    expect(daemon.spawner.creds).toEqual(CREDS);
    expect(daemon.spawner.bundleVersion).toBe("0.16.3");
    expect(daemon.spawner.prepareManagedConfigFn).toBe(prepareManagedDshConfig);
  });

  it("uses the existing POSIX process-group interrupt path", async () => {
    const child = { pid: 7654 };
    const killImpl = vi.fn();
    await killProcessTree(child, {
      platform: "linux",
      logger,
      killImpl,
      waitForExit: vi.fn(async () => true),
      sigintTimeoutMs: 20,
    });
    expect(killImpl).toHaveBeenCalledWith(-7654, "SIGINT");
  });

  it("uploads canonical dsh text and attributes each wake's usage only to its direct-Idea terminal edge", async () => {
    const firstUsage = {
      inputTokens: 7,
      outputTokens: 10,
      cacheCreationTokens: 11,
      cacheReadTokens: 13,
    };
    const thirdUsage = {
      inputTokens: 2,
      outputTokens: 3,
      cacheCreationTokens: null,
      cacheReadTokens: 5,
    };
    const { waker, transcriptPosts, advanceCalls } = makeComposedWaker([
      [dshUser("hello"), dshAssistant("first answer"), dshCompleted(firstUsage)],
      [dshAssistant("second answer")],
      [dshCompleted(thirdUsage)],
    ]);
    const resolved = await waker.keyFor(NOTIFICATION);

    await waker.wake(NOTIFICATION, resolved.key, resolved);
    await waker.wake(NOTIFICATION, resolved.key, resolved);
    await waker.wake(NOTIFICATION, resolved.key, resolved);

    expect(transcriptPosts).toEqual([
      {
        url: `${CREDS.url}/api/daemon/transcript`,
        body: {
          sessionId: DIRECT_IDEA,
          messages: [
            { role: "user", text: "hello" },
            { role: "assistant", text: "first answer" },
          ],
        },
      },
      {
        url: `${CREDS.url}/api/daemon/transcript`,
        body: {
          sessionId: DIRECT_IDEA,
          messages: [{ role: "assistant", text: "second answer" }],
        },
      },
    ]);

    const runningCalls = advanceCalls.filter((call) => call.status === "running");
    const endedCalls = advanceCalls.filter((call) => call.status === "ended");
    expect(runningCalls).toHaveLength(3);
    expect(endedCalls).toHaveLength(3);
    for (const running of runningCalls) {
      expect(running.sessionId).toBe(DIRECT_IDEA);
      expect(running).not.toHaveProperty("usage");
    }
    expect(endedCalls[0]).toMatchObject({
      sessionId: DIRECT_IDEA,
      backendSessionId: DSH_SESSION,
      usage: { ...firstUsage, model: "deepseek-v4-flash", source: "dsh" },
    });
    expect(endedCalls[1].sessionId).toBe(DIRECT_IDEA);
    expect(endedCalls[1]).not.toHaveProperty("usage");
    expect(endedCalls[2]).toMatchObject({
      sessionId: DIRECT_IDEA,
      backendSessionId: DSH_SESSION,
      usage: { ...thirdUsage, model: "deepseek-v4-flash", source: "dsh" },
    });
  });
});
