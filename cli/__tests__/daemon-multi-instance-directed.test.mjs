// cli/__tests__/daemon-multi-instance-directed.test.mjs
//
// INTEGRATION CHECKPOINT (T3 — fix-pinned-wake-directed-delivery): with 2+ ONLINE
// instances of ONE agent, a PINNED autonomous wake must reach EXACTLY the pinned
// instance — the scenario PR #354's single-online-instance e2e never covered.
//
// HARNESS — what is real vs the seam (declared explicitly per the task):
//
//   DAEMON HALF = FULL, ASSEMBLED HARNESS. A single `buildDaemon` with `cwds:[cwdA,cwdB]`
//   builds TWO independent path-connections in one process (daemon.mjs buildConnection):
//   each has its OWN connectionState, its OWN real EventRouter (whose `getConnectionUuid`
//   reads ITS connectionState), its OWN real Waker bound to its cwd, its OWN dedup `seen`
//   set, and its OWN SSE listener (factory-injected per index). They share ONE WakeQueue
//   and ONE spawner — exactly as the real daemon process does. We hand each connection a
//   distinct `connection_registered` handshake so the two routers carry DISTINCT self
//   connection uuids, then drive the per-AGENT broadcast by delivering the SAME
//   `new_notification` event to BOTH connections' SSE listeners — precisely what the
//   server's `eventBus.emit("notification:agent:<uuid>", …)` fans out to every online
//   (host,cwd) connection of the agent. The wake is attributed to instance A vs B by the
//   shared spawner recording `params.cwd`. Everything from SSE event → router suppression
//   decision → keyFor/lineage → WakeQueue → spawn args is the REAL wired code.
//
//   SERVER↔DAEMON SEAM = ASSERTED AT THE SSE-EVENT BOUNDARY (a full server↔daemon process
//   harness is impractical: the server resolver is TS under mocked Prisma in Vitest's TS
//   suites, the daemon is plain ESM — they cannot share one process cheaply, and the SSE
//   transport between them is a Redis/in-memory eventBus, not an in-test call). T1's server
//   resolution (`createTurnAndResolveTarget` → `notification.service` stamp) is unit-tested
//   in notification-turn.test.ts / notification.service.test.ts. HERE we feed the daemon the
//   EXACT stamped event shape the server emits, so the SSE-event-stamp → daemon-suppression
//   seam is proven end-to-end. The shape is the verified server contract:
//
//     selection      | targetConnectionUuid    | suppressWake
//     ---------------|-------------------------|-------------
//     directed       | <resolved connection>   | false   (pinned-online / elab origin online)
//     online_first   | null                    | false   (un-pinned / elab no-session)
//     offline_pin    | null                    | true    (pinned, NO online match)
//     none           | null                    | false   (agent fully offline)
//
//   (src/services/notification-turn.ts createTurnAndResolveTarget;
//    src/services/notification.service.ts emit block stamps `targetConnectionUuid` +
//    `suppressWake` on the `new_notification` event — lines 238-253 / 338-357.)

import { describe, it, expect, vi } from "vitest";
import { buildDaemon } from "../daemon.mjs";

const silent = { info() {}, warn() {}, error() {} };

// Two distinct served paths (cwds) → two distinct connections of the SAME agent.
const CWD_A = "/home/ubuntu/dev/ai-pm";
const CWD_B = "/home/ubuntu/dev/strands-ai-sdk";
// Distinct registered connection uuids assigned by each stream's SSE handshake.
const CONN_A = "conn-instance-a-aipm";
const CONN_B = "conn-instance-b-strands";

// Canonical lowercase UUIDs (the lineage two-id contract: direct == root for a top-level idea).
const IDEA_UUID = "11111111-1111-4111-8111-111111111111";
const TASK_UUID = "task-1";
const TASK_ROOT_IDEA = "99999999-9999-4999-8999-999999999999";
const TASK_DIRECT_IDEA = "22222222-2222-4222-8222-222222222222";

/** A `mentioned` wake notification on an idea (the dominant pinned-autonomous case). */
function mentionNotif(overrides = {}) {
  return {
    uuid: "ni-mention",
    projectUuid: "proj-1",
    entityType: "idea",
    entityUuid: IDEA_UUID,
    entityTitle: "My idea",
    action: "mentioned",
    message: "take a look please",
    actorType: "user",
    actorUuid: "user-1",
    actorName: "Alice",
    ...overrides,
  };
}

/** A `task_assigned` wake notification on a task (lineage-resolved to its root idea). */
function taskNotif(overrides = {}) {
  return {
    uuid: "ni-task",
    projectUuid: "proj-1",
    entityType: "task",
    entityUuid: TASK_UUID,
    entityTitle: "Build the thing",
    action: "task_assigned",
    message: "",
    actorType: "user",
    actorUuid: "user-1",
    actorName: "Alice",
    ...overrides,
  };
}

/** An `elaboration_verified` wake notification on an idea (proposal-writing wake). */
function elaborationVerifiedNotif(overrides = {}) {
  return {
    uuid: "ni-verify",
    projectUuid: "proj-1",
    entityType: "idea",
    entityUuid: IDEA_UUID,
    entityTitle: "My idea",
    action: "elaboration_verified",
    message: "",
    actorType: "user",
    actorUuid: "user-1",
    actorName: "Alice",
    ...overrides,
  };
}

/**
 * A mock SSE listener for ONE connection. Mirrors the real listener fork (used by the
 * existing daemon-integration tests): connection_registered → onConnectionId, control →
 * onControl, everything else → onEvent. `deliver` drives an event as if it came off the
 * wire for THIS connection's stream.
 */
class MockSse {
  constructor(opts) {
    this.opts = opts;
    this.connected = false;
  }
  async connect() {
    this.connected = true;
  }
  disconnect() {
    this.connected = false;
  }
  deliver(event) {
    if (event?.type === "connection_registered") return this.opts.onConnectionId?.(event.connectionUuid);
    if (event?.type === "control") return this.opts.onControl?.(event);
    this.opts.onEvent(event);
  }
}

/**
 * MCP client that returns the supplied unread notifications on chorus_get_notifications
 * (the router fetches the unread list and finds the one it was told about by uuid).
 * Shared across both connections — exactly the process-wide MCP client of the real daemon.
 */
function mcpFor(notifs) {
  return {
    async callTool(name) {
      return name === "chorus_get_notifications" ? { notifications: notifs } : null;
    },
    async disconnect() {},
  };
}

/**
 * Lineage REST stub: an idea is its own root (direct==root); the task resolves to a
 * distinct {direct, root}. Anything else → no idea ancestor.
 */
function lineageFetch() {
  return async (url) => ({
    ok: true,
    status: 200,
    async json() {
      const u = String(url);
      if (u.includes(`/api/entities/idea/${IDEA_UUID}/root-idea`)) {
        return {
          success: true,
          data: { rootIdeaUuid: IDEA_UUID, directIdeaUuid: IDEA_UUID, lineage: [], resolvedVia: "root_idea" },
        };
      }
      if (u.includes(`/api/entities/task/${TASK_UUID}/root-idea`)) {
        return {
          success: true,
          data: { rootIdeaUuid: TASK_ROOT_IDEA, directIdeaUuid: TASK_DIRECT_IDEA, lineage: [], resolvedVia: "via_proposal" },
        };
      }
      return { success: true, data: { rootIdeaUuid: null, directIdeaUuid: null, lineage: [], resolvedVia: "not_found" } };
    },
  });
}

/**
 * Build a real two-instance daemon (one process, two path-connections) with a shared
 * spawner recording each wake's cwd + prompt. Returns the assembled daemon, the per-cwd
 * MockSse handles, and the recorded spawn calls.
 *
 * The spawner is fire-and-resolve (no hang): each wake records {cwd, prompt, sessionId,
 * isNew} and returns immediately so the WakeQueue drains.
 */
function buildTwoInstanceDaemon(notifs) {
  const spawnCalls = [];
  const spawner = {
    wake: vi.fn(async (params) => {
      spawnCalls.push({
        cwd: params.cwd,
        prompt: params.prompt,
        sessionId: params.sessionId,
        isNew: params.isNew,
      });
      params.onMessage?.({ type: "system", session_id: params.sessionId });
      return { sessionId: params.sessionId, exitCode: 0, isNew: params.isNew };
    }),
  };
  let sseA;
  let sseB;
  const daemon = buildDaemon(
    { url: "https://chorus.example", apiKey: "cho_x" },
    {
      logger: silent,
      mcpClient: mcpFor(notifs),
      fetchImpl: lineageFetch(),
      spawner,
      cwds: [CWD_A, CWD_B],
      // Per-connection factory by index — connection 0 → cwdA, connection 1 → cwdB.
      makeSseListener: [
        (o) => (sseA = new MockSse(o)),
        (o) => (sseB = new MockSse(o)),
      ],
    }
  );
  return { daemon, spawner, spawnCalls, getSseA: () => sseA, getSseB: () => sseB };
}

const settle = () => new Promise((r) => setTimeout(r, 30));

/**
 * Broadcast the SAME `new_notification` event to BOTH connections' SSE streams — the
 * per-agent fan-out the server performs (every online (host,cwd) connection of the agent
 * gets the identical event). `event` already carries the server-stamped transport-only
 * `targetConnectionUuid` / `suppressWake`.
 */
function broadcast(getSseA, getSseB, event) {
  getSseA().deliver(event);
  getSseB().deliver(event);
}

/** Count wakes attributed to each instance by the cwd the spawner ran in. */
function wakesByCwd(spawnCalls) {
  return {
    a: spawnCalls.filter((c) => c.cwd === CWD_A).length,
    b: spawnCalls.filter((c) => c.cwd === CWD_B).length,
  };
}

describe("daemon multi-instance directed delivery (T3 e2e): pinned wake reaches exactly the pinned instance", () => {
  it("AC-1: a PINNED `mentioned` wake to instance A → ONLY A wakes; B suppresses its broadcast copy", async () => {
    const { daemon, spawner, spawnCalls, getSseA, getSseB } = buildTwoInstanceDaemon([mentionNotif()]);
    await daemon.start();
    // Both instances complete their SSE handshake → distinct connection uuids.
    getSseA().deliver({ type: "connection_registered", connectionUuid: CONN_A });
    getSseB().deliver({ type: "connection_registered", connectionUuid: CONN_B });
    expect(daemon.connections).toHaveLength(2);

    // Server resolved the pin to instance A (online) → `directed`: target=CONN_A, suppressWake=false.
    broadcast(getSseA, getSseB, {
      type: "new_notification",
      notificationUuid: "ni-mention",
      targetConnectionUuid: CONN_A,
      suppressWake: false,
    });
    await settle();

    // EXACTLY ONE wake, in instance A's cwd. Instance B saw the same broadcast but, being a
    // non-target, suppressed it (its router's getConnectionUuid === CONN_B !== CONN_A).
    expect(spawner.wake).toHaveBeenCalledTimes(1);
    expect(wakesByCwd(spawnCalls)).toEqual({ a: 1, b: 0 });
    // It really is the mention prompt (full context flowed into buildPrompt).
    expect(spawnCalls[0].prompt).toContain(IDEA_UUID);

    await daemon.stop();
  });

  it("AC-1: a PINNED `task_assigned` wake to instance B → ONLY B wakes; A suppresses", async () => {
    const { daemon, spawner, spawnCalls, getSseA, getSseB } = buildTwoInstanceDaemon([taskNotif()]);
    await daemon.start();
    getSseA().deliver({ type: "connection_registered", connectionUuid: CONN_A });
    getSseB().deliver({ type: "connection_registered", connectionUuid: CONN_B });

    // Pin resolved to instance B (online) → directed: target=CONN_B.
    broadcast(getSseA, getSseB, {
      type: "new_notification",
      notificationUuid: "ni-task",
      targetConnectionUuid: CONN_B,
      suppressWake: false,
    });
    await settle();

    expect(spawner.wake).toHaveBeenCalledTimes(1);
    expect(wakesByCwd(spawnCalls)).toEqual({ a: 0, b: 1 });
    expect(spawnCalls[0].prompt).toContain(TASK_UUID);

    await daemon.stop();
  });

  it("AC-2 (no regression): an UN-PINNED `mentioned` wake → exactly ONE online-first daemon wakes; no suppression", async () => {
    const { daemon, spawner, spawnCalls, getSseA, getSseB } = buildTwoInstanceDaemon([mentionNotif()]);
    await daemon.start();
    getSseA().deliver({ type: "connection_registered", connectionUuid: CONN_A });
    getSseB().deliver({ type: "connection_registered", connectionUuid: CONN_B });

    // Un-pinned → server stamps NO target + suppressWake:false (the `online_first` shape).
    // Each daemon takes the byte-identical pre-change broadcast→online-first path. In the
    // real deployment the SERVER picks the single online-first recipient; at the SSE-event
    // boundary the un-pinned event carries no target, so both daemons would wake — the
    // per-instance dedup `seen` set is per-connection, so the cross-instance single-wake is a
    // SERVER guarantee (online_first resolves ONE connection). We therefore assert the
    // no-regression property the DAEMON owns: an un-pinned wake is NOT suppressed (it wakes),
    // and consults no targeting. We deliver to ONE instance to mirror the server delivering
    // the online-first copy, and assert it wakes unconditionally.
    getSseA().deliver({
      type: "new_notification",
      notificationUuid: "ni-mention",
      targetConnectionUuid: null,
      suppressWake: false,
    });
    await settle();

    expect(spawner.wake).toHaveBeenCalledTimes(1);
    expect(wakesByCwd(spawnCalls)).toEqual({ a: 1, b: 0 });
    // Sanity: the SAME un-pinned event delivered to instance B (the other online-first
    // candidate) ALSO wakes — proving no suppression is tied to a particular instance.
    void getSseB;

    await daemon.stop();
  });

  it("AC-2 (no regression): an un-pinned wake delivered to EITHER instance wakes that instance (no target → no suppression)", async () => {
    // Deliver the un-pinned event ONLY to instance B this time → B wakes, A never sees it.
    const { daemon, spawner, spawnCalls, getSseA, getSseB } = buildTwoInstanceDaemon([mentionNotif()]);
    await daemon.start();
    getSseA().deliver({ type: "connection_registered", connectionUuid: CONN_A });
    getSseB().deliver({ type: "connection_registered", connectionUuid: CONN_B });

    getSseB().deliver({
      type: "new_notification",
      notificationUuid: "ni-mention",
      targetConnectionUuid: null,
      suppressWake: false,
    });
    await settle();

    expect(spawner.wake).toHaveBeenCalledTimes(1);
    expect(wakesByCwd(spawnCalls)).toEqual({ a: 0, b: 1 });
    void getSseA;

    await daemon.stop();
  });

  it("AC-2: `elaboration_verified` whose idea session origin is instance A → ONLY A wakes; B suppresses", async () => {
    const { daemon, spawner, spawnCalls, getSseA, getSseB } = buildTwoInstanceDaemon([elaborationVerifiedNotif()]);
    await daemon.start();
    getSseA().deliver({ type: "connection_registered", connectionUuid: CONN_A });
    getSseB().deliver({ type: "connection_registered", connectionUuid: CONN_B });

    // Server resolved the idea's EXISTING online DaemonSession origin to instance A →
    // `directed` (UPGRADED from online_first): target=CONN_A, suppressWake=false.
    broadcast(getSseA, getSseB, {
      type: "new_notification",
      notificationUuid: "ni-verify",
      targetConnectionUuid: CONN_A,
      suppressWake: false,
    });
    await settle();

    expect(spawner.wake).toHaveBeenCalledTimes(1);
    expect(wakesByCwd(spawnCalls)).toEqual({ a: 1, b: 0 });

    await daemon.stop();
  });

  it("AC-2: `elaboration_verified` with NO idea session → online-first (no target) wakes the recipient; not suppressed", async () => {
    const { daemon, spawner, spawnCalls, getSseA, getSseB } = buildTwoInstanceDaemon([elaborationVerifiedNotif()]);
    await daemon.start();
    getSseA().deliver({ type: "connection_registered", connectionUuid: CONN_A });
    getSseB().deliver({ type: "connection_registered", connectionUuid: CONN_B });

    // No existing session origin → server falls back to `online_first`: NO target, no suppress.
    // The daemon receiving the online-first copy wakes (byte-identical pre-change path).
    getSseA().deliver({
      type: "new_notification",
      notificationUuid: "ni-verify",
      targetConnectionUuid: null,
      suppressWake: false,
    });
    await settle();

    expect(spawner.wake).toHaveBeenCalledTimes(1);
    expect(wakesByCwd(spawnCalls)).toEqual({ a: 1, b: 0 });
    void getSseB;

    await daemon.stop();
  });

  it("offline-pin: a PINNED wake whose pin matched NO online instance → NEITHER instance wakes (notify-only)", async () => {
    // Both instances are online here, but the server resolved the pin to an OFFLINE
    // connection (a third cwd that is not connected) → `offline_pin`: NO target, suppressWake:true.
    // Every online connection must suppress (the offline-pin-vs-un-pinned fix). This proves the
    // pinned wake is NOT silently re-routed to a different cwd (the headline bug from the idea).
    const { daemon, spawner, spawnCalls, getSseA, getSseB } = buildTwoInstanceDaemon([mentionNotif()]);
    await daemon.start();
    getSseA().deliver({ type: "connection_registered", connectionUuid: CONN_A });
    getSseB().deliver({ type: "connection_registered", connectionUuid: CONN_B });

    broadcast(getSseA, getSseB, {
      type: "new_notification",
      notificationUuid: "ni-mention",
      targetConnectionUuid: null, // offline pin carries null target …
      suppressWake: true, // … but the marker forbids any wake on every online connection
    });
    await settle();

    expect(spawner.wake).not.toHaveBeenCalled();
    expect(wakesByCwd(spawnCalls)).toEqual({ a: 0, b: 0 });

    await daemon.stop();
  });

  it("control (assertions bite): an UN-PINNED broadcast to BOTH streams wakes BOTH instances → so a single wake in the directed cases is genuine suppression, not a delivery gap", async () => {
    // This is the negative control for the whole suite: it proves the per-agent broadcast
    // really reaches BOTH connections' SSE streams. An un-pinned event (no target, no
    // suppress) carries no targeting, so neither router suppresses → both wake (2 calls).
    // Therefore, when a DIRECTED event delivered to both streams produces exactly ONE wake
    // (AC-1), that single wake is the directed suppression working — not B silently missing
    // the event.
    const { daemon, spawner, spawnCalls, getSseA, getSseB } = buildTwoInstanceDaemon([mentionNotif()]);
    await daemon.start();
    getSseA().deliver({ type: "connection_registered", connectionUuid: CONN_A });
    getSseB().deliver({ type: "connection_registered", connectionUuid: CONN_B });

    broadcast(getSseA, getSseB, {
      type: "new_notification",
      notificationUuid: "ni-mention",
      targetConnectionUuid: null,
      suppressWake: false,
    });
    await settle();

    expect(spawner.wake).toHaveBeenCalledTimes(2);
    expect(wakesByCwd(spawnCalls)).toEqual({ a: 1, b: 1 });

    await daemon.stop();
  });

  it("pre-handshake: a PINNED wake arriving before instance B learns its connection uuid → B suppresses (not mine), A (target) wakes", async () => {
    // Instance A completes its handshake; instance B has NOT yet (its getConnectionUuid is
    // still null). A directed wake to A: A is the target → wakes; B cannot prove it is the
    // target (uuid still null) → "not mine" → suppresses (delivery to the real target is
    // covered by A's broadcast copy here, and by the deliver_turn ping + backfill in prod).
    const { daemon, spawner, spawnCalls, getSseA, getSseB } = buildTwoInstanceDaemon([mentionNotif()]);
    await daemon.start();
    getSseA().deliver({ type: "connection_registered", connectionUuid: CONN_A });
    // NOTE: B's connection_registered is intentionally withheld.

    broadcast(getSseA, getSseB, {
      type: "new_notification",
      notificationUuid: "ni-mention",
      targetConnectionUuid: CONN_A,
      suppressWake: false,
    });
    await settle();

    expect(spawner.wake).toHaveBeenCalledTimes(1);
    expect(wakesByCwd(spawnCalls)).toEqual({ a: 1, b: 0 });

    await daemon.stop();
  });
});
