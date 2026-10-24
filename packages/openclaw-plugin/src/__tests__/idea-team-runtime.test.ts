import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it, vi } from "vitest";
import { OpenClawDaemonClient, type WakeRequest, type WakeRunContext } from "../daemon-client.js";
import { createDaemonRestClient, type DaemonPendingTurn } from "../daemon-rest-client.js";
import { ChorusEventRouter } from "../event-router.js";
import { turnHeaders, withRunMcpConfig, type WakeContext } from "../idea-team-context.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function context(): WakeContext {
  const ideaTeam = { ideaUuid: randomUUID(), generation: 3, ownerUuid: randomUUID(), agentUuid: randomUUID(), role: "orchestrator" as const };
  const notification = {
    uuid: randomUUID(), action: "team_lead_handoff", entityType: "proposal", entityUuid: randomUUID(),
    entityTitle: "Ready", projectUuid: randomUUID(), message: "Review the submitted proposal",
  };
  return { version: 1, ideaTeam, ideaTeams: [ideaTeam, { ...ideaTeam, ideaUuid: randomUUID(), generation: 7 }], notificationUuid: notification.uuid, notification };
}

function turn(): DaemonPendingTurn {
  const wakeContext = context();
  return { turnUuid: randomUUID(), sessionId: randomUUID(), directIdeaUuid: wakeContext.ideaTeam!.ideaUuid,
    trigger: "task_assigned", promptText: null, wakeContext };
}

function runtimeConfig() {
  return { mcp: { servers: { chorus: {
    url: "https://chorus.example/api/mcp", transport: "streamable-http",
    headers: { Authorization: "Bearer test", "x-chorus-turn-uuid": "stale", "X-CHORUS-ADMISSION-UUID": "stale", "X-Chorus-Idea-Team-Turns": "stale" },
  }, unrelated: { url: "https://other.example/mcp", headers: { Authorization: "Bearer other" } } } } };
}

type RunParams = Parameters<WakeRunContext["agent"]["runEmbeddedAgent"]>[0];

function harness(options: {
  turns?: DaemonPendingTurn[];
  admission?: "denied" | "missing" | "mismatched";
  acknowledgement?: unknown;
  execute?: (params: RunParams) => Promise<void>;
} = {}) {
  const advances: Record<string, unknown>[] = [];
  const pendingQueries: URL[] = [];
  const config = runtimeConfig();
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("pending-turns")) {
      pendingQueries.push(url);
      return Response.json({ data: { turns: options.turns ?? [] } });
    }
    if (url.pathname.endsWith("turn-advance")) {
      const body = JSON.parse(String(init?.body));
      advances.push(body);
      if (options.admission === "denied") return Response.json({ error: "stale generation" }, { status: 403 });
      return Response.json({ data: options.admission === "missing" ? {} : {
        ideaTeamProtocol: Object.hasOwn(options, "acknowledgement") ? options.acknowledgement : 1,
        turn: { uuid: options.admission === "mismatched" ? randomUUID() : body.turnUuid ?? randomUUID() },
      } });
    }
    return Response.json({ success: true });
  }) as typeof fetch;
  const restClient = createDaemonRestClient({ url: "https://chorus.example", apiKey: "test", getConnectionUuid: () => "connection", fetchImpl });
  const runEmbeddedAgent = vi.fn(async (params: RunParams) => {
    await options.execute?.(params);
    return { meta: {} };
  });
  const runContext: WakeRunContext = {
    config, agent: { runEmbeddedAgent, session: {
      getSessionEntry: () => undefined,
      resolveSessionFilePath: (sessionId: string) => `/sessions/${sessionId}.jsonl`,
    } } as WakeRunContext["agent"],
    sessionKey: "agent:main:main", agentId: "main", workspaceDir: "/workspace", timeoutMs: 1000, modelRef: null,
  };
  const requests: WakeRequest[] = [];
  const client = new OpenClawDaemonClient({ restClient, resolveRunContext: () => runContext,
    redispatch: (request) => { requests.push(request); }, buildTurnPrompt: () => "work", logger });
  return { client, advances, pendingQueries, requests, runEmbeddedAgent, config };
}

async function callNativeMcp(config: unknown): Promise<Headers[]> {
  const entry = (config as ReturnType<typeof runtimeConfig>).mcp.servers.chorus;
  const toolHeaders: Headers[] = [];
  const transport = new StreamableHTTPClientTransport(new URL(entry.url), {
    requestInit: { headers: entry.headers },
    fetch: async (_input, init) => {
      if (init?.method !== "POST") return new Response(null, { status: 405 });
      const request = JSON.parse(String(init.body));
      if (request.id === undefined) return new Response(null, { status: 202 });
      if (request.method === "tools/call") toolHeaders.push(new Headers(init.headers));
      return Response.json({ jsonrpc: "2.0", id: request.id, result: request.method === "initialize"
        ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "test", version: "1" } }
        : { content: [{ type: "text", text: "ok" }] } });
    },
  });
  const client = new Client({ name: "native-config-test", version: "1" });
  try {
    await client.connect(transport);
    await client.callTool({ name: "chorus_pm_create_proposal", arguments: {} });
    await client.callTool({ name: "chorus_add_comment", arguments: {} });
  } finally {
    await client.close();
  }
  return toolHeaders;
}

describe("Idea Team exact OpenClaw runtime", () => {
  it("preserves every persisted source fence and uses exact admission identity on real MCP transport calls", async () => {
    const pending = turn();
    let headers: Headers[] = [];
    const run = harness({ turns: [pending], execute: async (params) => { headers = await callNativeMcp(params.config); } });
    await run.client.deliverTurn(pending.turnUuid);
    expect(run.requests[0].wakeContext).toEqual(pending.wakeContext);
    expect(run.requests[0].sessionId).toBe(pending.sessionId);
    expect(run.requests[0].prompt).toContain("current active enrolled Idea assignee orchestrator");
    await run.client.runWake(run.requests[0]);
    const [running, ended] = run.advances;
    expect(running).toMatchObject({ sessionId: pending.sessionId, turnUuid: pending.turnUuid,
      turnUuids: [pending.turnUuid], wakeRecoveryProtocol: 1, ideaTeamProtocol: 1, status: "running" });
    expect(ended).toMatchObject({ turnUuid: pending.turnUuid, admissionUuid: running.admissionUuid,
      status: "ended", wakeRecoveryProtocol: 1, ideaTeamProtocol: 1 });
    expect(ended).not.toHaveProperty("turnUuids");
    expect(headers).toHaveLength(2);
    for (const header of headers) {
      expect(header.get("x-chorus-turn-uuid")).toBe(pending.turnUuid);
      expect(header.get("x-chorus-admission-uuid")).toBe(running.admissionUuid);
      expect(header.has("x-chorus-idea-team-turns")).toBe(false);
    }
    expect(run.config).toEqual(runtimeConfig());
    expect(run.pendingQueries[0].searchParams.get("ideaTeamProtocol")).toBe("1");
    expect(run.pendingQueries[0].searchParams.get("wakeRecoveryProtocol")).toBe("1");
  });

  it("isolates overlapping sessions and removes old identity from a later legacy run", async () => {
    const pending = [turn(), turn()];
    let entered = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const observed = new Map<string, Headers[]>();
    const run = harness({ turns: pending, execute: async (params) => {
      entered++;
      if (entered === 2) release();
      if (entered <= 2) await barrier;
      observed.set(params.sessionId, await callNativeMcp(params.config));
    } });
    await run.client.onReconnect();
    await Promise.all(run.requests.map((request) => run.client.runWake(request)));
    for (const item of pending) {
      const running = run.advances.find((advance) => advance.turnUuid === item.turnUuid && advance.status === "running")!;
      expect(observed.get(item.sessionId)!.every((headers) => headers.get("x-chorus-turn-uuid") === item.turnUuid && headers.get("x-chorus-admission-uuid") === running.admissionUuid)).toBe(true);
    }
    const proofs = run.advances.filter((advance) => advance.status === "running").map((advance) => advance.admissionUuid);
    expect(new Set(proofs).size).toBe(2);
    await run.client.runWake({ sessionId: pending[0].sessionId, entityType: "idea", entityUuid: pending[0].directIdeaUuid, prompt: "legacy", contextKey: "legacy" });
    expect(observed.get(pending[0].sessionId)!.every((headers) => !headers.has("x-chorus-turn-uuid") && !headers.has("x-chorus-admission-uuid") && !headers.has("x-chorus-idea-team-turns"))).toBe(true);
    expect(run.config).toEqual(runtimeConfig());
  });

  it.each(["denied", "missing", "mismatched"] as const)("does not execute or downgrade after %s admission, including retries and resume", async (admission) => {
    const pending = turn();
    const run = harness({ turns: [pending], admission });
    await run.client.deliverTurn();
    await run.client.runWake(run.requests[0]);
    await run.client.onReconnect();
    await run.client.runWake(run.requests[1]);
    expect(run.runEmbeddedAgent).not.toHaveBeenCalled();
    expect(run.advances).toHaveLength(2);
    expect(run.advances[0].admissionUuid).toBe(run.advances[1].admissionUuid);
    expect(run.advances.every((advance) => advance.turnUuid === pending.turnUuid && advance.ideaTeamProtocol === 1)).toBe(true);
    const count = run.requests.length;
    run.client.resume("proposal", pending.wakeContext!.notification.entityUuid);
    await vi.waitFor(() => expect(run.requests.length).toBe(count + 1));
    expect(run.requests.at(-1)!.wakeContext).toEqual(pending.wakeContext);
  });

  it("resumes with the stored context and serializes exact turns sharing a session", async () => {
    const first = turn();
    const second = { ...turn(), sessionId: first.sessionId, trigger: "resume", resume: { entityType: "proposal", entityUuid: first.wakeContext!.notification.entityUuid } };
    let active = 0;
    let maximum = 0;
    const run = harness({ turns: [first, second], execute: async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
    } });
    await run.client.deliverTurn();
    expect(run.requests[1].wakeContext).toEqual(second.wakeContext);
    await Promise.all(run.requests.map((request) => run.client.runWake(request)));
    expect(maximum).toBe(1);
    expect(run.advances.map((advance) => advance.status)).toEqual(["running", "ended", "running", "ended"]);
  });

  it.each([undefined, null, 0, 2, "1", true])("rejects a fenced admission with acknowledgement %s even when the exact turn matches", async (acknowledgement) => {
    const pending = turn();
    const run = harness({ turns: [pending], acknowledgement });
    await run.client.deliverTurn();
    await run.client.runWake(run.requests[0]);
    await run.client.onReconnect();
    await run.client.runWake(run.requests[1]);
    expect(run.runEmbeddedAgent).not.toHaveBeenCalled();
    expect(run.advances).toHaveLength(2);
    expect(run.advances.every((advance) => advance.status === "running" && advance.turnUuid === pending.turnUuid && advance.ideaTeamProtocol === 1)).toBe(true);
    expect(run.advances[0].admissionUuid).toBe(run.advances[1].admissionUuid);
  });

  it("allows legacy admission without acknowledgement but never attaches fenced identity", async () => {
    let headers: Headers[] = [];
    const run = harness({ acknowledgement: undefined, execute: async (params) => { headers = await callNativeMcp(params.config); } });
    await run.client.runWake({ entityType: "idea", entityUuid: randomUUID(), prompt: "legacy", contextKey: "legacy" });
    expect(run.runEmbeddedAgent).toHaveBeenCalledOnce();
    expect(run.advances[0]).not.toHaveProperty("admissionUuid");
    expect(headers).toHaveLength(2);
    expect(headers.every((header) => !header.has("x-chorus-turn-uuid") && !header.has("x-chorus-admission-uuid"))).toBe(true);
  });

  it.each(["generation", "primary", "sources", "version", "notification"])("rejects malformed %s context rather than treating it as legacy", async (field) => {
    const pending = turn();
    const wake = pending.wakeContext!;
    if (field === "generation") wake.ideaTeam!.generation = -1;
    if (field === "primary") delete wake.ideaTeam;
    if (field === "sources") wake.ideaTeams = [{ ...wake.ideaTeam!, generation: 100 }];
    if (field === "version") Object.assign(wake, { version: 2 });
    if (field === "notification") wake.notificationUuid = randomUUID();
    const run = harness({ turns: [pending] });
    await run.client.deliverTurn();
    expect(run.requests).toHaveLength(0);
    expect(run.advances).toHaveLength(0);
  });

  it("rejects managed context without an exact turn", async () => {
    const run = harness();
    await run.client.runWake({ entityType: "idea", entityUuid: randomUUID(), prompt: "work", contextKey: "broadcast", wakeContext: context() });
    expect(run.runEmbeddedAgent).not.toHaveBeenCalled();
    expect(run.advances).toHaveLength(0);
  });

  it.each(["crash", "user"])("settles an interrupted managed run with its original admission (%s)", async (reason) => {
    const pending = turn();
    const run = harness({ turns: [pending], execute: async () => {
      if (reason === "user") run.client.interrupt("proposal", pending.wakeContext!.notification.entityUuid);
      throw new Error("stopped");
    } });
    await run.client.deliverTurn();
    await run.client.runWake(run.requests[0]);
    expect(run.advances).toHaveLength(2);
    expect(run.advances[1]).toMatchObject({ turnUuid: pending.turnUuid, admissionUuid: run.advances[0].admissionUuid,
      wakeRecoveryProtocol: 1, ideaTeamProtocol: 1, status: "interrupted", interruptedReason: reason });
  });

  it("routes broadcast and directed events only through persisted recovery, never notification fallback", async () => {
    const deliverTurn = vi.fn(async () => {});
    const wake = vi.fn();
    const callTool = vi.fn();
    const router = new ChorusEventRouter({ deliverTurn, wake, mcpClient: { callTool } as never, logger });
    const turnUuid = randomUUID();
    router.dispatch({ type: "new_notification", notificationUuid: "broadcast" });
    router.dispatch({ type: "new_notification", notificationUuid: "directed", turnUuid, wakeContext: context() });
    router.dispatch({ type: "new_notification", notificationUuid: "suppressed", suppressWake: true });
    expect(deliverTurn.mock.calls).toEqual([[undefined], [turnUuid]]);
    expect(wake).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });
});

describe("bounded mutation headers", () => {
  const primary = { turnUuid: randomUUID(), admissionUuid: randomUUID() };

  it("accepts at most 16 strict UUID pairs without truncation or global mutation", () => {
    const supplementary = Array.from({ length: 16 }, () => ({ turnUuid: randomUUID(), admissionUuid: randomUUID() }));
    const headers = turnHeaders(primary, supplementary);
    expect(JSON.parse(headers["X-Chorus-Idea-Team-Turns"])).toEqual(supplementary);
    expect(headers["X-Chorus-Idea-Team-Turns"].length).toBeLessThanOrEqual(4096);
    expect(() => turnHeaders(primary, [...supplementary, primary])).toThrow();
    expect(() => turnHeaders(primary, [{ ...primary, extra: true } as never])).toThrow();
    expect(() => turnHeaders(primary, [{ ...primary, turnUuid: "not-a-uuid" }])).toThrow();
    expect(() => turnHeaders({ ...primary, admissionUuid: "" })).toThrow();
    expect(() => withRunMcpConfig(runtimeConfig(), undefined, supplementary)).toThrow("primary turn/admission");
    const config = runtimeConfig();
    const scoped = withRunMcpConfig(config, primary, supplementary) as ReturnType<typeof runtimeConfig>;
    expect(scoped.mcp.servers.chorus.headers).toMatchObject(headers);
    expect(scoped.mcp.servers.unrelated).toEqual(config.mcp.servers.unrelated);
    expect(config).toEqual(runtimeConfig());
  });

  it("fails closed when a native Chorus MCP server is unavailable", () => {
    expect(() => withRunMcpConfig({}, primary)).toThrow("native Chorus");
  });
});
