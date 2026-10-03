// Basic synthetic daemon wiring; T4 owns live CLI/Waker acceptance.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { appServerChild } from "./fixtures/codex-app-server-child.mjs";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDaemon } from "../daemon.mjs";
import { ClaudeSpawner } from "../claude-spawner.mjs";
import { CodexSpawner } from "../codex-spawner.mjs";

import {
  codexUsageMapPath,
  getCodexUsageSnapshot,
  setCodexUsageSnapshot,
} from "../codex-usage-map.mjs";
import { Waker } from "../waker.mjs";
import { createTranscriptUploadHooks } from "../upload-hooks.mjs";
import { killProcessTree } from "../process-killer.mjs";

const CREDS = { url: "https://chorus.test", apiKey: "cho_daemonkey" };
const ANCHOR = "11111111-1111-4111-8111-111111111111";
const TID = "019f091a-844e-7b43-8c31-6b04ffa38149";
const silent = { info() {}, warn() {}, error() {} };

// ===== Test hygiene: never write the DEVELOPER's real usage map ===============
// The Codex usage map's default path is ~/.chorus/codex-usage.json. Tests that
// exercise the real capture path (rather than stubbing it) must point it at a temp
// file, and this file asserts at the end that nothing wrote the real one. The
// developer's file may legitimately exist, so the guard compares CONTENT (before vs
// after) instead of asserting absence — only an actual write fails it.
const REAL_USAGE_MAP = codexUsageMapPath();
const readRealUsageMap = () =>
  existsSync(REAL_USAGE_MAP) ? readFileSync(REAL_USAGE_MAP, "utf8") : null;
let realUsageMapBefore = null;
beforeAll(() => {
  realUsageMapBefore = readRealUsageMap();
});
afterAll(() => {
  expect(readRealUsageMap()).toBe(realUsageMapBefore);
});

// Temp usage-map file for tests that keep the real capture/normalize logic.
const USAGE_DIR = mkdtempSync(join(tmpdir(), "chorus-codex-usage-"));
const USAGE_PATH = join(USAGE_DIR, "codex-usage.json");
afterAll(() => {
  rmSync(USAGE_DIR, { recursive: true, force: true });
});

const CODEX_USAGE = {
  method: "thread/tokenUsage/updated",
  params: { threadId: TID, turnId: "turn-1", tokenUsage: { total: {
    inputTokens: 13497, cachedInputTokens: 4096, cacheWriteInputTokens: 512,
    outputTokens: 5, reasoningOutputTokens: 2000,
  } } },
};

describe("daemon-selected Codex App Server wiring", () => {
  it("keeps Claude as the default backend", () => {
    expect(buildDaemon(CREDS, { logger: silent }).spawner).toBeInstanceOf(ClaudeSpawner);
  });

  it.each([false, true])("new/resumed=%s executes RPC with daemon identity and current policy", async (resumed) => {
    const daemon = buildDaemon(CREDS, { logger: silent, permissionMode: "yolo", agentType: "codex" });
    const spawner = daemon.spawner;
    expect(spawner).toBeInstanceOf(CodexSpawner);
    const child = appServerChild({ threadId: TID });
    Object.assign(spawner, {
      codexPath: "/fake/codex", platform: "linux", getThreadIdFn: () => resumed ? TID : null,
      setThreadIdFn: vi.fn(), getUsageSnapshotFn: () => null, setUsageSnapshotFn: () => {},
      hasChorusMcpServerFn: () => true, spawnImpl: vi.fn(() => child),
    });
    const result = await spawner.wake({ prompt: "private prompt", sessionId: ANCHOR, isNew: true });
    expect(result).toMatchObject({ isNew: !resumed, backendSessionId: TID, exitCode: 0 });
    const [command, argv, opts] = spawner.spawnImpl.mock.calls[0];
    expect(command).toBe("/fake/codex");
    expect(argv).toEqual(["app-server", "--listen", "stdio://"]);
    expect(opts).toMatchObject({ detached: true, env: { CHORUS_URL: CREDS.url, CHORUS_API_KEY: CREDS.apiKey, CHORUS_DAEMON_HEADLESS: "1" } });
    expect(child.requests[2].method).toBe(resumed ? "thread/resume" : "thread/start");
    expect(child.requests[3].params.input[0].text).toBe("private prompt");
  });

  it("shared killer invokes the spawner protocol hook for active turns", async () => {
    const child = appServerChild({ threadId: TID, autoComplete: false });
    const spawner = new CodexSpawner({
      codexPath: "/fake/codex", spawnImpl: () => child, logger: silent,
      getThreadIdFn: () => null, setThreadIdFn: () => {}, getUsageSnapshotFn: () => null,
      setUsageSnapshotFn: () => {}, hasChorusMcpServerFn: () => true,
    });
    const running = spawner.wake({ prompt: "x", sessionId: ANCHOR });
    await vi.waitFor(() => expect(child.requests.some((r) => r.method === "turn/start")).toBe(true));
    await killProcessTree(child, { sigintTimeoutMs: 50 });
    expect((await running).exitCode).toBe(130);
    expect(child.requests.filter((r) => r.method === "turn/interrupt")).toHaveLength(1);
  });
});

describe("codex token usage end-to-end (daemon-token-usage): real CodexSpawner → real transcript hooks → Waker terminal turn-advance", () => {
  const DIRECT_IDEA = "33333333-3333-4333-8333-333333333333";
  const NOTIF = {
    uuid: "notif-codex-1",
    projectUuid: "proj-1",
    entityType: "task",
    entityUuid: "task-codex-1",
    entityTitle: "Codex task",
    action: "task_assigned",
    message: "",
    actorType: "user",
    actorUuid: "user-1",
    actorName: "Alice",
  };

  /** A no-op fetch so the real transcript hooks' fire-and-forget POSTs never hit the network. */
  function noopFetch() {
    return vi.fn(async () => ({ ok: true, status: 200, async json() { return { success: true, data: {} }; } }));
  }

  /**
   * Build a Waker driven by the REAL CodexSpawner (fake child process) and the REAL
   * transcript upload hooks, capturing every advanceTurn payload. The stream frames the
   * fake codex child emits on stdout are the test's input. This exercises capture →
   * onSessionEnd → waker #advanceTurn (terminal edge) together — no mocked usage, but
   * pointed at an ISOLATED usage file so the developer's real map stays untouched.
   */
  function makeCodexWaker({ streamFrames, exitCode = 0, batchDelayMs = 0 } = {}) {
    const child = appServerChild({ threadId: TID, handler(req, c) {
      if (req.method !== "turn/start") return;
      c.reply(req, { turn: { id: "turn-1" } });
      for (const frame of streamFrames) c.send(frame);
      if (!streamFrames.some((f) => f.method === "turn/completed")) c.exit(exitCode);
      return true;
    } });
    const spawner = new CodexSpawner({
      codexPath: "/usr/bin/codex",
      platform: "linux",
      permissionMode: "yolo",
      creds: CREDS,
      logger: silent,
      getThreadIdFn: () => null,
      setThreadIdFn: () => {},
      getUsageSnapshotFn: (anchor, threadId) =>
        getCodexUsageSnapshot(anchor, threadId, { path: USAGE_PATH, logger: silent }),
      setUsageSnapshotFn: (anchor, threadId, usage) =>
        setCodexUsageSnapshot(anchor, threadId, usage, { path: USAGE_PATH, logger: silent }),
      spawnImpl: () => child,
    });
    const hooks = createTranscriptUploadHooks({
      url: CREDS.url,
      apiKey: CREDS.apiKey,
      logger: silent,
      fetchImpl: noopFetch(),
      batchDelayMs,
    });
    const advanceCalls = [];
    const waker = new Waker({
      creds: CREDS,
      lineage: { resolve: async () => ({ rootIdeaUuid: DIRECT_IDEA, directIdeaUuid: DIRECT_IDEA }) },
      spawner,
      cwd: "/work/dir",
      hooks,
      logger: silent,
      writeMcpConfigFn: vi.fn(() => ({ path: "/tmp/m.json", cleanup: vi.fn() })),
      isNewSessionFn: vi.fn(() => true),
      reportInterrupt: vi.fn(async () => {}),
      advanceTurn: vi.fn(async (payload) => {
        advanceCalls.push(payload);
        return { ok: true, data: { turnUuid: "ordinary-turn" } };
      }),
    });
    return { waker, advanceCalls };
  }

  it("a Codex wake emitting turn.completed produces a terminal turn-advance carrying usage {source:'codex'} with the mapped fields", async () => {
    const { waker, advanceCalls } = makeCodexWaker({
      streamFrames: [


        { method: "item/completed", params: { threadId: TID, turnId: "turn-1", item: { id: "i0", type: "agentMessage", text: "done" } } },
        CODEX_USAGE,
        { method: "turn/completed", params: { threadId: TID, turn: { id: "turn-1", status: "completed" } } },
      ],
    });
    const resolved = await waker.keyFor(NOTIF);
    await waker.wake(NOTIF, resolved.key, resolved);

    const statuses = advanceCalls.map((c) => c.status);
    expect(statuses).toEqual(["running", "ended"]);
    const ended = advanceCalls.find((c) => c.status === "ended");
    expect(ended.usage).toEqual({
      inputTokens: 8889, // input_tokens excludes cache categories in the shared shape
      outputTokens: 5, // output_tokens ALONE — reasoning is a subdivision inside it, not added
      cacheCreationTokens: 512, // cache_write_input_tokens — POPULATED for Codex 0.145.0
      cacheReadTokens: 4096,
      model: null,
      source: "codex",
    });
    // The → running advance must never carry usage.
    const running = advanceCalls.find((c) => c.status === "running");
    expect(running).not.toHaveProperty("usage");
  });

  it("a Codex wake with no usage advances with usage absent (no fabricated zeros)", async () => {
    const { waker, advanceCalls } = makeCodexWaker({
      streamFrames: [

        { method: "item/completed", params: { threadId: TID, turnId: "turn-1", item: { id: "i0", type: "agentMessage", text: "hi" } } },
        { method: "turn/completed", params: { threadId: TID, turn: { id: "turn-1", status: "completed" } } },
      ],
    });
    const resolved = await waker.keyFor(NOTIF);
    await waker.wake(NOTIF, resolved.key, resolved);

    const ended = advanceCalls.find((c) => c.status === "ended");
    expect(ended).toBeDefined();
    expect(ended).not.toHaveProperty("usage");
  });
});
