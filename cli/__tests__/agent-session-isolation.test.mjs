import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { Waker } from "../waker.mjs";
import { ClaudeSpawner } from "../claude-spawner.mjs";
import { backendSessionKey } from "../backend-session-identity.mjs";

const IDEA = "11111111-1111-4111-8111-111111111111";
const ROOT = "22222222-2222-4222-8222-222222222222";
const AGENTS = ["33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"];

function fixture(existing = [], autoComplete = true) {
  const transcripts = new Set(existing);
  const completeTurns = [];
  const spawn = vi.fn((command, args) => {
    const sessionId = args[args.findIndex(arg => arg === "--session-id" || arg === "--resume") + 1];
    const child = new EventEmitter();
    child.pid = 42;
    child.stdin = new EventEmitter();
    child.stdin.write = vi.fn();
    child.stdin.end = vi.fn();
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = vi.fn();
    child.stderr = new EventEmitter();
    child.stderr.setEncoding = vi.fn();
    transcripts.add(sessionId);
    const complete = () => {
      child.stdout.emit("data", JSON.stringify({ type: "assistant", session_id: sessionId, message: { content: [{ type: "text", text: "reply" }] } }) + "\n");
      child.stdout.emit("data", JSON.stringify({ type: "result", subtype: "success", session_id: sessionId }) + "\n");
      child.emit("close", 0);
    };
    completeTurns.push(complete);
    if (autoComplete) queueMicrotask(complete);
    return child;
  });
  const create = agentUuid => {
    const creds = { url: "http://chorus.test", apiKey: "test-key", agentUuid };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const hooks = {
      onSessionStart: vi.fn(async () => {}),
      onTranscriptMessage: vi.fn(async () => {}),
      onSessionEnd: vi.fn(async () => ({})),
      onExecutionChange: vi.fn(() => snapshots.push(waker.buildExecutionSnapshot())),
    };
    const snapshots = [];
    const advanceTurn = vi.fn(async () => ({ ok: true, data: { turnUuid: "turn-1" } }));
    const isNewSessionFn = vi.fn(sessionId => !transcripts.has(sessionId));
    const waker = new Waker({
      creds, logger, hooks, advanceTurn, isNewSessionFn, cwd: "/same/workspace",
      lineage: { resolve: async () => ({ directIdeaUuid: IDEA, rootIdeaUuid: ROOT }) },
      spawner: new ClaudeSpawner({ creds, logger, claudePath: "/bin/claude", spawnImpl: spawn, env: { CLAUDE_CONFIG_DIR: "/same/config" } }),
      writeMcpConfigFn: () => ({ path: "/tmp/fake-mcp.json", cleanup() {} }),
    });
    const run = async () => {
      const notification = { action: "mentioned", entityType: "idea", entityUuid: IDEA, projectUuid: "project", actorType: "agent", actorName: "Sender", actorUuid: "sender" };
      const resolved = await waker.keyFor(notification);
      await waker.wake(notification, resolved.key, resolved);
    };
    return { run, hooks, advanceTurn, logger, isNewSessionFn, waker, snapshots };
  };
  return { create, transcripts, spawn, completeTurns };
}

describe("same daemon/cwd/config agent session isolation", () => {
  it("keeps concurrently active agents on distinct native transcript identities", async () => {
    const { create, spawn, transcripts, completeTurns } = fixture([], false);
    const agents = AGENTS.map(agentUuid => create(agentUuid));
    const pending = agents.map(agent => agent.run());
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    expect(transcripts).toEqual(new Set(AGENTS.map(agentUuid => backendSessionKey(IDEA, agentUuid))));
    for (const agent of agents) expect(agent.hooks.onSessionEnd).not.toHaveBeenCalled();
    for (const complete of completeTurns) complete();
    await Promise.all(pending);
    for (const [index, agent] of agents.entries()) {
      const nativeId = backendSessionKey(IDEA, AGENTS[index]);
      expect(agent.hooks.onTranscriptMessage).toHaveBeenCalled();
      for (const [call] of agent.hooks.onTranscriptMessage.mock.calls) {
        expect(call.message.session_id).toBe(nativeId);
      }
    }
  });

  it("gives Claude agents separate sessions and resumes only their own, including after restart", async () => {
    const { create, spawn } = fixture();
    const first = create(AGENTS[0]);
    const second = create(AGENTS[1]);
    await first.run();
    await second.run();
    await first.run();
    await create(AGENTS[1]).run();
    for (const [index, agentUuid] of [AGENTS[0], AGENTS[1], AGENTS[0], AGENTS[1]].entries()) {
      const args = spawn.mock.calls[index][1];
      expect(args).toContain(index < 2 ? "--session-id" : "--resume");
      expect(args).toContain(backendSessionKey(IDEA, agentUuid));
      expect(args).not.toContain(IDEA);
    }
    expect(first.isNewSessionFn).toHaveBeenCalledWith(backendSessionKey(IDEA, AGENTS[0]), "/same/workspace");
    expect(first.logger.info.mock.calls.flat().join("\n")).toContain(`claude --resume ${backendSessionKey(IDEA, AGENTS[0])}`);
  });

  it("preserves Chorus attribution and transcript upload anchors while reporting the native resume id", async () => {
    const { create } = fixture();
    const agent = create(AGENTS[0]);
    await agent.run();
    expect(agent.hooks.onSessionStart).toHaveBeenCalledWith(expect.objectContaining({ sessionId: IDEA, rootIdeaKey: `idea:${IDEA}` }));
    expect(agent.snapshots.flat()).toContainEqual(expect.objectContaining({ directIdeaUuid: IDEA, rootIdeaUuid: ROOT }));
    for (const [call] of agent.hooks.onTranscriptMessage.mock.calls) {
      expect(call.sessionId).toBe(IDEA);
      expect(call.message.session_id).toBe(backendSessionKey(IDEA, AGENTS[0]));
    }
    expect(agent.hooks.onSessionEnd).toHaveBeenCalledWith(expect.objectContaining({ sessionId: IDEA }));
    expect(agent.advanceTurn).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: IDEA, status: "ended", entityType: "idea", entityUuid: IDEA,
      backendSessionId: backendSessionKey(IDEA, AGENTS[0]),
    }));
  });

  it("keeps ambiguous legacy transcripts intact and warns with explicit manual recovery", async () => {
    const { create, transcripts, spawn } = fixture([IDEA]);
    for (const agentUuid of AGENTS) {
      const agent = create(agentUuid);
      await agent.run();
      expect(agent.logger.warn.mock.calls.flat().join("\n")).toContain(`manual recovery with claude --resume ${IDEA}`);
      expect(agent.logger.warn.mock.calls.flat().join("\n")).toContain("unknown or shared agent ownership");
    }
    expect(transcripts.has(IDEA)).toBe(true);
    expect(transcripts.size).toBe(3);
    expect(spawn.mock.calls.every(([, args]) => args.includes("--session-id") && !args.includes("--resume"))).toBe(true);
  });
});
