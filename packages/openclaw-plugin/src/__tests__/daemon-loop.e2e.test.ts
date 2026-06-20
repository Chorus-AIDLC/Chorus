// packages/openclaw-plugin/src/__tests__/daemon-loop.e2e.test.ts
//
// TIER-2 LIVE INTEGRATION TEST (T5 integration checkpoint).
//
// Drives the REAL plugin daemon modules — `ChorusSseListener`, `ConnectionState`,
// `createControlHandler`, `OpenClawDaemonClient`, `createDaemonRestClient` — wired
// together EXACTLY as `src/index.ts` wires them, against a LIVE local Chorus server
// over real HTTP. The ONLY thing replaced is the OpenClaw SDK
// `runtime.agent.runEmbeddedAgent` call (we cannot run a real LLM in this sandbox);
// everything else is the REAL wire protocol hitting the REAL server + DB:
//   • SSE handshake → real `connection_registered` (our online DaemonConnection)
//   • POST /api/daemon/turn-advance (running→ended) — real DaemonSessionTurn advance
//   • POST /api/daemon/transcript — real DaemonTranscriptMessage append
//   • POST /api/daemon/execution-state — real DaemonExecution reconcile
//   • POST /api/daemon/report-interrupt — real interrupted/reason=user flip
//   • the server's `control:{connectionUuid}` interrupt/resume/deliver_turn events
//   • GET  /api/daemon/pending-turns — real reconnect backfill source
//   • GET  /api/daemon/executions, GET /api/daemon-sessions/{uuid} — read-back verify
//
// GATED on `CHORUS_E2E_BASE_URL` + `CHORUS_E2E_PASSWORD`. When unset the whole suite
// is SKIPPED, so committing this file never breaks CI on a machine with no server.
// It self-provisions its own agent + API key + ad-hoc session via the live server's
// real endpoints, so it is hermetic given only a running server.
//
// The ad-hoc `daemon_session` entity is used as the execution/control target: it is a
// first-class EXECUTION_ENTITY_TYPE / CONTROL_ENTITY_TYPE validated server-side against
// DaemonSession.sessionId, so the whole loop runs without needing a content entity.
//
// AC mapping:
//   AC1  wake → turn-advance(running→ended) + execution row + readable transcript
//   AC2  interrupt stops the in-flight run → execution interrupted reason=user;
//        resume re-dispatches and continues the SAME session
//   AC3  live deliver_turn runs a human_instruction once; a turn created during a
//        disconnect is recovered by pending-turns backfill and runs at most once

import { beforeAll, describe, expect, it } from "vitest";

import { ConnectionState } from "../connection-state.js";
import { createControlHandler, type ControlBehaviorHooks } from "../control-handler.js";
import { createDaemonRestClient, type DaemonPendingTurn } from "../daemon-rest-client.js";
import { OpenClawDaemonClient, type WakeRequest } from "../daemon-client.js";
import { ChorusSseListener, type SseControlEvent } from "../sse-listener.js";
import type {
  OpenClawRuntimeAgent,
  RunEmbeddedAgentParams,
  EmbeddedAgentRunResult,
} from "openclaw/plugin-sdk/plugin-entry";

const BASE_URL = process.env.CHORUS_E2E_BASE_URL;
const ADMIN_EMAIL = process.env.CHORUS_E2E_EMAIL ?? "admin@chorus.local";
const ADMIN_PASSWORD = process.env.CHORUS_E2E_PASSWORD ?? "";
const RUN = !!BASE_URL && !!ADMIN_PASSWORD;

// --- live REST helpers (cookie jar for user session, bearer for agent key) ---

let userCookie = "";

async function adminLogin(): Promise<{ companyUuid: string; userUuid: string }> {
  const res = await fetch(`${BASE_URL}/api/auth/default-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (!res.ok) throw new Error(`default-login failed: ${res.status} ${await res.text()}`);
  const setCookie = res.headers.get("set-cookie") ?? "";
  const m = /user_session=([^;]+)/.exec(setCookie);
  if (!m) throw new Error("no user_session cookie returned");
  userCookie = `user_session=${m[1]}`;
  const body = (await res.json()) as { data: { user: { uuid: string; companyUuid: string } } };
  return { companyUuid: body.data.user.companyUuid, userUuid: body.data.user.uuid };
}

async function userPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: userCookie },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status}: ${text}`);
  return JSON.parse(text).data as T;
}

async function userGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, { headers: { Cookie: userCookie } });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}: ${text}`);
  return JSON.parse(text).data as T;
}

async function agentGet<T>(path: string, apiKey: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, { headers: { Authorization: `Bearer ${apiKey}` } });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET(agent) ${path} -> ${res.status}: ${text}`);
  return JSON.parse(text).data as T;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor<T>(
  fn: () => Promise<T | null | undefined>,
  timeoutMs = 8000,
  intervalMs = 150,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await sleep(intervalMs);
  }
  return null;
}

type ExecRow = {
  entityType: string;
  entityUuid: string;
  status: string;
  interruptedReason?: string | null;
};

async function findExecution(
  apiKey: string,
  entityUuid: string,
  predicate: (e: ExecRow) => boolean,
): Promise<ExecRow | null> {
  const { executions } = await agentGet<{ executions: ExecRow[] }>(
    `/api/daemon/executions`,
    apiKey,
  );
  return executions.find((e) => e.entityUuid === entityUuid && predicate(e)) ?? null;
}

// --- controllable fake for `runtime.agent` (the ONLY mocked seam) ---

interface FakeRunHandle {
  params: RunEmbeddedAgentParams;
  finish: (visibleText?: string) => void;
}

function makeFakeAgent() {
  const runs: FakeRunHandle[] = [];
  let invocationCount = 0;

  const agent: OpenClawRuntimeAgent = {
    runEmbeddedAgent: (params: RunEmbeddedAgentParams): Promise<EmbeddedAgentRunResult> => {
      invocationCount += 1;
      return new Promise<EmbeddedAgentRunResult>((resolve) => {
        let settled = false;
        const settle = (aborted: boolean, visibleText?: string) => {
          if (settled) return;
          settled = true;
          resolve({
            meta: {
              durationMs: 1,
              aborted,
              ...(visibleText ? { finalAssistantVisibleText: visibleText } : {}),
            },
          });
        };
        // Real abort relay — the daemon client's AbortController.abort() lands here.
        if (params.abortSignal) {
          if (params.abortSignal.aborted) settle(true);
          else params.abortSignal.addEventListener("abort", () => settle(true), { once: true });
        }
        runs.push({
          params,
          finish: (visibleText = "fake-assistant-reply") => {
            void (params.onBlockReply?.({ text: visibleText, isReasoning: false }) as
              | Promise<void>
              | void);
            setTimeout(() => settle(false, visibleText), 60);
          },
        });
      });
    },
    resolveAgentDir: () => "/tmp/fake-agent-dir",
    resolveAgentWorkspaceDir: () => "/tmp/fake-workspace",
    resolveAgentTimeoutMs: () => 60_000,
    session: {
      getSessionEntry: ({ sessionKey }) => ({
        sessionId: `oc-${sessionKey}`,
        sessionFile: `/tmp/sessions/${sessionKey}.jsonl`,
      }),
      resolveSessionFilePath: (sessionId) => `/tmp/sessions/${sessionId}.jsonl`,
    },
  };

  return { agent, runs, invocations: () => invocationCount };
}

function makeLogger() {
  const lines: string[] = [];
  return {
    lines,
    info: (m: string) => lines.push(`INFO  ${m}`),
    warn: (m: string) => lines.push(`WARN  ${m}`),
    error: (m: string) => lines.push(`ERROR ${m}`),
  };
}

// --- harness: wire the plugin exactly like src/index.ts, live, with the fake agent ---

interface Harness {
  connectionState: ConnectionState;
  daemonClient: OpenClawDaemonClient;
  onControl: (e: SseControlEvent) => void;
  sse: ChorusSseListener;
  fake: ReturnType<typeof makeFakeAgent>;
  logger: ReturnType<typeof makeLogger>;
  connectionUuid: () => string | null;
  /** Drop live control events (simulates a lost SSE ping) while true. */
  setControlDeaf: (deaf: boolean) => void;
}

async function buildHarness(apiKey: string): Promise<Harness> {
  const logger = makeLogger();
  const connectionState = new ConnectionState();
  const fake = makeFakeAgent();

  const restClient = createDaemonRestClient({
    url: BASE_URL!,
    apiKey,
    getConnectionUuid: () => connectionState.getConnectionUuid(),
    logger,
  });

  let daemonClient: OpenClawDaemonClient;
  const redispatch = (req: WakeRequest): void => {
    void daemonClient.runWake(req);
  };
  daemonClient = new OpenClawDaemonClient({
    restClient,
    resolveRunContext: () => ({
      agent: fake.agent,
      sessionKey: "agent:main:main",
      agentId: "main",
      config: {},
      workspaceDir: "/tmp/fake-workspace",
      timeoutMs: 60_000,
      modelRef: null,
    }),
    redispatch,
    buildTurnPrompt: (turn: DaemonPendingTurn) =>
      turn.promptText && turn.promptText.trim()
        ? `[Chorus] instruction:\n\n${turn.promptText}`
        : `[Chorus] new instruction in session ${turn.sessionId}`,
    logger,
  });

  const controlHooks: ControlBehaviorHooks = daemonClient.controlHooks;
  const realOnControl = createControlHandler({ connectionState, hooks: controlHooks, logger });
  // A deaf toggle that drops live control events — the faithful simulation of a LOST
  // deliver_turn SSE ping (the connection stays online server-side; the daemon simply
  // never observed the ping). The persisted pending turn is then recovered by the
  // reconnect-backfill, NOT by the live path.
  let controlDeaf = false;
  const onControl = (e: SseControlEvent): void => {
    if (controlDeaf) {
      logger.info(`[test] dropped live control event (deaf): ${e.command ?? e.type}`);
      return;
    }
    realOnControl(e);
  };

  const sse = new ChorusSseListener({
    chorusUrl: BASE_URL!,
    apiKey,
    logger,
    onEvent: () => {},
    onConnectionId: (uuid) => connectionState.setConnectionUuid(uuid),
    onControl,
    onReconnect: async () => {
      await daemonClient.onReconnect();
    },
  });

  await sse.connect();
  const got = await waitFor(async () => connectionState.getConnectionUuid(), 8000, 100);
  if (!got) throw new Error("never received connection_registered from server");

  return {
    connectionState,
    daemonClient,
    onControl,
    sse,
    fake,
    logger,
    connectionUuid: () => connectionState.getConnectionUuid(),
    setControlDeaf: (deaf: boolean) => {
      controlDeaf = deaf;
    },
  };
}

// Create an ad-hoc daemon session pinned to `connUuid`, returning its ids. The first
// human_instruction turn it creates is consumed by the first runWake's turn-advance.
async function createAdHocSession(
  agentUuid: string,
  connUuid: string,
  instructionText: string,
): Promise<{ sessionUuid: string; sessionId: string }> {
  const { session } = await userPost<{ session: { uuid: string; sessionId: string } }>(
    `/api/daemon-sessions/ad-hoc`,
    { agentUuid, connectionUuid: connUuid, instructionText },
  );
  return { sessionUuid: session.uuid, sessionId: session.sessionId };
}

interface Provisioned {
  companyUuid: string;
  userUuid: string;
  agentUuid: string;
  apiKey: string;
}

let prov: Provisioned;

describe.skipIf(!RUN)("OpenClaw daemon loop — live integration against local Chorus", () => {
  beforeAll(async () => {
    const { companyUuid, userUuid } = await adminLogin();
    // admin_agent → carries `task:admin`. The daemon reports its OWN interrupt/resume
    // with its agent key, and the reverse-control authz rule (daemon-control.service
    // `authorizeConnectionControl`) requires `actorUuid === agent.ownerUuid` OR
    // `task:admin`. The agent's owner is the human user (not the agent itself), so a
    // daemon agent MUST hold `task:admin` to record its own interrupt outcome. This is
    // a real protocol requirement surfaced by this integration test.
    const agent = await userPost<{ uuid: string }>("/api/agents", {
      name: `OpenClaw E2E ${Date.now()}`,
      roles: ["admin_agent"],
    });
    const key = await userPost<{ key: string }>("/api/api-keys", {
      agentUuid: agent.uuid,
      name: "e2e",
    });
    prov = { companyUuid, userUuid, agentUuid: agent.uuid, apiKey: key.key };
  }, 30_000);

  // ---- AC1 ----------------------------------------------------------------
  it("AC1: wake reports running→ended, surfaces an execution row, and a readable transcript", async () => {
    const h = await buildHarness(prov.apiKey);
    try {
      const connUuid = h.connectionUuid()!;
      expect(connUuid).toMatch(/[0-9a-f-]{36}/);

      // Real ad-hoc session creation: server creates a DaemonSession (origin = our
      // connection) + a pending human_instruction turn (and fires a deliver_turn ping
      // we ignore for this AC — we drive the wake explicitly for determinism).
      const { sessionUuid, sessionId } = await createAdHocSession(
        prov.agentUuid,
        connUuid,
        "ac1 setup",
      );

      // Drive a real wake. The daemon client POSTs (all to the LIVE server):
      //   turn-advance(running) → advances the pending turn
      //   execution-state → upserts a running DaemonExecution (daemon_session/sessionId)
      //   transcript (onBlockReply) → appends assistant text
      //   turn-advance(ended) on completion
      const runP = h.daemonClient.runWake({
        prompt: "do the thing",
        contextKey: "ac1",
        entityType: "daemon_session",
        entityUuid: sessionId,
        directIdeaUuid: null,
      });

      const running = await waitFor(() =>
        findExecution(prov.apiKey, sessionId, (e) => e.status === "running"),
      );
      expect(running, `running execution row for daemon_session ${sessionId}`).toBeTruthy();

      // Finish the run (emits a finalized assistant block first).
      await waitFor(async () => (h.fake.runs.length > 0 ? true : null));
      h.fake.runs[0].finish("hello from the fake agent");
      await runP;

      // Transcript readable via the REAL server (daemon-session detail read).
      const detail = await waitFor(async () => {
        const d = await userGet<{
          turns: Array<{ messages: Array<{ role: string; text: string }> }>;
        }>(`/api/daemon-sessions/${sessionUuid}`);
        const hit = d.turns.some((t) =>
          t.messages.some((m) => m.role === "assistant" && m.text.includes("hello from the fake")),
        );
        return hit ? d : null;
      });
      expect(detail, "assistant transcript readable via server").toBeTruthy();

      // After completion the active row is gone (ended via reconcile) — verify it is no
      // longer reported as running.
      const stillRunning = await findExecution(
        prov.apiKey,
        sessionId,
        (e) => e.status === "running",
      );
      expect(stillRunning, "execution no longer running after ended").toBeNull();
    } finally {
      h.sse.disconnect();
    }
  }, 45_000);

  // ---- AC2 ----------------------------------------------------------------
  it("AC2: control interrupt stops the in-flight run (interrupted reason=user); resume continues the SAME session", async () => {
    const h = await buildHarness(prov.apiKey);
    try {
      const connUuid = h.connectionUuid()!;
      const { sessionId } = await createAdHocSession(prov.agentUuid, connUuid, "ac2 setup");

      // Start a long-running wake — the fake run only ends on abort.
      const runP = h.daemonClient.runWake({
        prompt: "long task",
        contextKey: "ac2",
        entityType: "daemon_session",
        entityUuid: sessionId,
        directIdeaUuid: null,
      });

      const running = await waitFor(() =>
        findExecution(prov.apiKey, sessionId, (e) => e.status === "running"),
      );
      expect(running, "run is in-flight (server shows running)").toBeTruthy();
      await waitFor(async () => (h.fake.runs.length > 0 ? true : null));
      const firstSessionKey = h.fake.runs[0].params.sessionKey;

      // REAL interrupt via the server (the UI "Stop" path; admin user owns the agent).
      // Server publishes control:{connUuid} → our SSE → control-handler double-check →
      // daemon client aborts the in-flight run → report-interrupt(reason=user).
      await userPost(`/api/daemon/control`, {
        command: "interrupt",
        targetConnectionUuid: connUuid,
        entityType: "daemon_session",
        entityUuid: sessionId,
      });

      // The in-flight run must actually stop (resolves because the abort fired).
      await runP;

      const interrupted = await waitFor(() =>
        findExecution(
          prov.apiKey,
          sessionId,
          (e) => e.status === "interrupted" && e.interruptedReason === "user",
        ),
      );
      expect(interrupted, "execution interrupted with reason=user (server-side)").toBeTruthy();

      // RESUME via the server. resumeExecution requires an interrupted/user row (just
      // verified). It flips the row back to running and emits a resume control event →
      // control-handler → re-dispatch → a NEW run on the SAME session key (continuity).
      const runsBefore = h.fake.runs.length;
      await userPost(`/api/daemon/resume`, {
        connectionUuid: connUuid,
        entityType: "daemon_session",
        entityUuid: sessionId,
      });

      const resumed = await waitFor(
        async () => (h.fake.runs.length > runsBefore ? true : null),
        10_000,
      );
      expect(resumed, "resume re-dispatched a new run").toBeTruthy();
      const resumeRun = h.fake.runs[h.fake.runs.length - 1];
      // Same-session continuity: the resumed run derives the SAME sessionKey as the
      // original (both come from the same business key → deriveSessionKey is stable).
      expect(resumeRun.params.sessionKey).toBe(firstSessionKey);
      resumeRun.finish("resumed-ok");
    } finally {
      h.sse.disconnect();
    }
  }, 60_000);

  // ---- AC3 ----------------------------------------------------------------
  it("AC3: live deliver_turn runs an instruction once; a turn created during disconnect is recovered by backfill at most once", async () => {
    const h = await buildHarness(prov.apiKey);
    try {
      const connUuid = h.connectionUuid()!;
      // Ad-hoc create ALSO fires a deliver_turn ping for its first turn — so creating
      // the session is itself the first live-delivery event. Wait for it to run once.
      const invStart = h.fake.invocations();
      const { sessionUuid } = await createAdHocSession(
        prov.agentUuid,
        connUuid,
        "first live instruction",
      );

      const ranLive = await waitFor(
        async () => (h.fake.invocations() > invStart ? true : null),
        10_000,
      );
      expect(ranLive, "live deliver_turn ran the first instruction").toBeTruthy();
      const invAfterLive = h.fake.invocations();
      for (const r of h.fake.runs) r.finish("ack");
      await sleep(200);

      // At-most-once across a reconnect backfill: the already-run turn is no longer
      // pending server-side AND the daemon's seen-set blocks a re-run. Trigger the
      // reconnect backfill path directly and assert no new invocation.
      await h.daemonClient.onReconnect();
      await sleep(600);
      expect(
        h.fake.invocations(),
        "backfill did not re-run the already-delivered turn",
      ).toBe(invAfterLive);

      // Recovery of a turn whose LIVE deliver_turn ping was LOST:
      //  (1) go "control-deaf" — the SSE stays connected and the connection stays
      //      ONLINE server-side (so the instruction is accepted), but the live
      //      deliver_turn control ping is dropped, exactly as a lost SSE frame would be.
      //  (2) send a new instruction → server persists a pending turn + fires a ping the
      //      deaf listener drops → the turn is NEVER run by the live path.
      //  (3) run the reconnect-backfill (onReconnect) → reads pending-turns (origin-
      //      pinned to our SAME connection) → runs the missed turn.
      //  (4) exactly once.
      h.setControlDeaf(true);
      const invBeforeMissed = h.fake.invocations();
      await userPost(`/api/daemon-sessions/${sessionUuid}/instruction`, {
        instructionText: "instruction whose live ping is lost",
      });
      // Give the (dropped) live ping time to NOT run it.
      await sleep(800);
      expect(
        h.fake.invocations(),
        "lost-ping instruction was NOT run live (ping dropped)",
      ).toBe(invBeforeMissed);

      // Backfill recovery (re-enable control first so a recovered run can settle).
      h.setControlDeaf(false);
      await h.daemonClient.onReconnect();
      const recovered = await waitFor(
        async () => (h.fake.invocations() > invBeforeMissed ? true : null),
        10_000,
      );
      expect(recovered, "reconnect-backfill recovered the missed (lost-ping) turn").toBeTruthy();
      const invAfterRecover = h.fake.invocations();
      for (const r of h.fake.runs) r.finish("ack2");

      // At-most-once: a second backfill sweep must NOT re-run it (shared seen-set +
      // server no longer lists it as pending).
      await h.daemonClient.onReconnect();
      await sleep(600);
      expect(h.fake.invocations(), "backfill is at-most-once on re-sweep").toBe(
        invAfterRecover,
      );
    } finally {
      h.sse.disconnect();
    }
  }, 75_000);
});
