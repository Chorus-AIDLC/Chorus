import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ideaTeamHeaders, ideaTeamProofFromEnv, ideaTeamRunEnv, validIdeaTeamContext } from "../idea-team-transport.mjs";
import { ideaTeamRuntimeConfig } from "../idea-team-runtime-config.mjs";
import { buildMcpConfig } from "../mcp-config.mjs";
import { createDaemonRestClient } from "../daemon-rest-client.mjs";
import { Waker } from "../waker.mjs";
import { EventRouter } from "../event-router.mjs";
import { WAKE_ACTIONS } from "../prompts.mjs";

const turnUuid = "11111111-1111-4111-8111-111111111111";
const admissionUuid = "22222222-2222-4222-8222-222222222222";
const otherUuid = "33333333-3333-4333-8333-333333333333";
const proof = { turnUuid, admissionUuid };
const fence = { ideaUuid: turnUuid, agentUuid: admissionUuid, ownerUuid: otherUuid, generation: 2, role: "orchestrator" };
const creds = { url: "https://isolated.invalid", apiKey: "synthetic" };
const cleanups = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

describe("Idea Team run-scoped transport", () => {
  it("round-trips bounded strict proofs and strips inherited runs, including Windows casing", () => {
    const batch = { ...proof, supplementaryTurns: [{ turnUuid: otherUuid, admissionUuid }] };
    const env = ideaTeamRunEnv({ CHORUS_TURN_UUID: "stale", chorus_admission_uuid: "stale", KEEP: "yes" }, batch);
    expect(ideaTeamProofFromEnv(env)).toEqual(batch);
    expect(ideaTeamRunEnv(env)).toEqual({ KEEP: "yes" });
    expect(buildMcpConfig({ ...creds, ideaTeamTurn: batch }).mcpServers.chorus.headers).toMatchObject(ideaTeamHeaders(batch));
    expect(() => ideaTeamHeaders({ ...proof, admissionUuid: "bad" })).toThrow();
    expect(() => ideaTeamHeaders({ ...proof, supplementaryTurns: Array(17).fill(proof) })).toThrow();
    expect(() => ideaTeamHeaders({ ...proof, supplementaryTurns: [{ ...proof, extra: true }] })).toThrow();
    expect(() => ideaTeamProofFromEnv({ CHORUS_IDEA_TEAM_TURNS: "[]" })).toThrow();
    expect(() => ideaTeamProofFromEnv({ CHORUS_IDEA_TEAM_TURNS: "{" })).toThrow();
  });

  it("preserves all source fences and rejects malformed/partial arrays", () => {
    expect(validIdeaTeamContext({ ideaTeam: fence, ideaTeams: [fence, { ...fence, ideaUuid: otherUuid }] })).toBe(true);
    for (const context of [{ ideaTeams: [fence] }, { ideaTeam: fence, ideaTeams: [] }, { ideaTeam: { ...fence, generation: -1 } }, { ideaTeam: fence, ideaTeams: [{ ...fence, role: "product" }] }]) {
      expect(validIdeaTeamContext(context)).toBe(false);
    }
  });

  it.each(["pi", "kiro"])("isolates %s MCP config without changing shared config and cleans up", (runtime) => {
    const home = mkdtempSync(join(tmpdir(), "chorus-team-test-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const key = runtime === "pi" ? "PI_CODING_AGENT_DIR" : "HOME";
    const source = runtime === "pi" ? home : join(home, ".kiro");
    const relative = runtime === "pi" ? "mcp.json" : "settings/mcp.json";
    mkdirSync(join(source, "settings"), { recursive: true });
    if (runtime === "kiro") {
      mkdirSync(join(source, "agents"));
      writeFileSync(join(source, "agents", "chorus.json"), JSON.stringify({ name: "chorus", includeMcpJson: true }));
    }
    writeFileSync(join(source, relative), JSON.stringify({ mcpServers: { other: { url: "https://other.invalid" } } }));
    const before = readFileSync(join(source, relative), "utf8");
    const config = ideaTeamRuntimeConfig({ runtime, env: { [key]: home }, cwd: home, creds, ideaTeamTurn: proof });
    cleanups.push(config.cleanup);
    const generatedPath = runtime === "pi" ? join(config.env[key], relative) : join(source, "agents", `${config.agentName}.json`);
    const generated = JSON.parse(readFileSync(generatedPath, "utf8"));
    expect(generated.mcpServers.chorus.headers).toMatchObject(ideaTeamHeaders(proof));
    expect(generated.mcpServers.other.url).toBe("https://other.invalid");
    expect(readFileSync(join(source, relative), "utf8")).toBe(before);
    config.cleanup();
    expect(existsSync(generatedPath)).toBe(false);
  });

  it.each([true, false])("requires upgraded server acknowledgement for fenced admission: %s", async (supported) => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ success: true, data: { turn: { uuid: turnUuid }, ...(supported ? { ideaTeamProtocol: 1 } : {}) } }), { status: 200 }));
    const client = createDaemonRestClient({ ...creds, fetchImpl, getConnectionUuid: () => otherUuid });
    const result = await client.turnAdvance({ ...proof, sessionId: turnUuid, turnUuids: [turnUuid], wakeRecoveryProtocol: 1, ideaTeamProtocol: 1, status: "running" });
    expect(result.ok).toBe(supported);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({ ideaTeamProtocol: 1, wakeRecoveryProtocol: 1 });
    if (!supported) expect(result.retryable).toBe(false);
  });

  it.each(["fenced", "ordinary-first", "ordinary-last"])("routes all source fences and supplies only actual batch admission to config/spawner: %s", async (mode) => {
    const notification = { uuid: "notification", action: "mentioned", entityType: "idea", entityUuid: turnUuid, message: "review" };
    const context = { version: 1, notificationUuid: "notification", notification, ideaTeam: fence, ideaTeams: [fence, { ...fence, ideaUuid: otherUuid }] };
    const attribution = { key: `idea:${turnUuid}`, directIdeaUuid: turnUuid, rootIdeaUuid: turnUuid };
    const enqueued = [];
    const queue = { enqueue: (...args) => { enqueued.push(args); } };
    const routingWaker = { keyFor: async () => attribution, markQueued() {} };
    const router = new EventRouter({ waker: routingWaker, queue, wakeActions: WAKE_ACTIONS });
    expect((await router.dispatchPendingTurn({ turnUuid, sessionId: turnUuid, wakeContext: context })).status).toBe("accepted");
    const routed = enqueued[0][1].notification;
    expect(routed.wakeContext).toEqual(context);
    const spawner = { wake: vi.fn(async () => ({ sessionId: turnUuid, exitCode: 0 })) };
    const advanceTurn = vi.fn(async (report) => ({ ok: true, data: { turnUuid: report.turnUuid } }));
    const writeMcpConfigFn = vi.fn(() => ({ path: "/fake/config", cleanup() {} }));
    const waker = new Waker({ creds, lineage: { resolve: async () => attribution }, spawner, advanceTurn, writeMcpConfigFn, isNewSessionFn: () => true });
    const batch = [routed, { ...routed, turnUuid: otherUuid }];
    if (mode !== "fenced") {
      const index = mode === "ordinary-first" ? 0 : 1;
      batch[index] = { ...batch[index], wakeContext: { version: 1, notificationUuid: "notification", notification } };
    }
    await waker.wakeBatch(batch, attribution.key, attribution);
    expect(advanceTurn.mock.calls[0][0]).toMatchObject({ ideaTeamProtocol: 1 });
    const admitted = advanceTurn.mock.calls[0][0].admissionUuid;
    const expected = { turnUuid, admissionUuid: admitted };
    expect(spawner.wake.mock.calls[0][0].ideaTeamTurn).toEqual(expected);
    expect(writeMcpConfigFn.mock.calls[0][0].ideaTeamTurn).toEqual(expected);
    await waker.wake({ ...notification, turnUuid: undefined }, attribution.key, attribution);
    expect(spawner.wake.mock.calls[1][0].ideaTeamTurn).toBeUndefined();
  });

  it("keeps portable runtime validators byte-identical", () => {
    const canonical = readFileSync(new URL("../idea-team-transport.mjs", import.meta.url), "utf8");
    for (const runtime of ["pi", "dsh"]) expect(readFileSync(new URL(`../../packages/chorus-${runtime}/bin/idea-team-transport.mjs`, import.meta.url), "utf8")).toBe(canonical);
  });

  it("keeps shell transports identical, bounded, and fail-closed before delegation", () => {
    const paths = ["public/chorus-plugin/bin/chorus-api.sh", "public/kiro-plugin/bin/chorus-api.sh", "plugins/chorus/hooks/chorus-mcp-call.sh", "packages/chorus-pi/bin/chorus-mcp-call.sh"];
    const snippets = paths.map((path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8").match(/CHORUS_TURN_HEADERS=\(\)[\s\S]+?\nfi\n/)[0]);
    expect(new Set(snippets).size).toBe(1);
    const run = (env) => spawnSync("bash", ["-c", `${snippets[0]}\nprintf '%s\\n' "\${CHORUS_TURN_HEADERS[@]}"`], { encoding: "utf8", env: { PATH: process.env.PATH, CHORUS_MCP_NO_CLI: "1", ...env } });
    const valid = run({ CHORUS_TURN_UUID: turnUuid, CHORUS_ADMISSION_UUID: admissionUuid, CHORUS_IDEA_TEAM_TURNS: JSON.stringify([proof]) });
    expect(valid.status).toBe(0);
    expect(valid.stdout).toContain(`X-Chorus-Turn-Uuid: ${turnUuid}`);
    expect(valid.stdout).toContain("X-Chorus-Idea-Team-Turns:");
    for (const env of [{ CHORUS_TURN_UUID: turnUuid }, { CHORUS_TURN_UUID: turnUuid, CHORUS_ADMISSION_UUID: admissionUuid, CHORUS_IDEA_TEAM_TURNS: JSON.stringify(Array(17).fill(proof)) }]) {
      const result = run(env);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
    }
  });
});
