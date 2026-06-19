// cli/__tests__/backfill-pending-turns.test.mjs
// Covers the reconnect-backfill re-deriving UNSTARTED (pending) turns from the turn
// table for this connection's origin-pinned sessions (子1 —
// daemon-session-conversation), so a lost delivery ping never loses an instruction.
import { describe, it, expect, vi } from "vitest";
import { createBackfill } from "../backfill.mjs";

const silent = { info() {}, warn() {}, error() {} };

const DIRECT_IDEA = "11111111-1111-4111-8111-111111111111";

function envelope(turns) {
  return { ok: true, status: 200, json: async () => ({ success: true, data: { turns } }) };
}

describe("backfill pending-turns re-derivation", () => {
  it("GETs /api/daemon/pending-turns with Bearer auth + connectionUuid, dispatches each pending turn", async () => {
    const pendingTurns = [
      { turnUuid: "t1", sessionId: DIRECT_IDEA, directIdeaUuid: DIRECT_IDEA, seq: 4, trigger: "human_instruction", promptText: "do X" },
      { turnUuid: "t2", sessionId: DIRECT_IDEA, directIdeaUuid: DIRECT_IDEA, seq: 5, trigger: "human_instruction", promptText: "do Y" },
    ];
    const fetchImpl = vi.fn(async () => envelope(pendingTurns));
    const mcpClient = { callTool: vi.fn(async () => ({ notifications: [] })) };
    const dispatched = [];

    const backfill = createBackfill({
      mcpClient,
      dispatch: () => {},
      logger: silent,
      url: "https://chorus.example.com/",
      apiKey: "cho_secret",
      getConnectionUuid: () => "conn-1",
      dispatchPendingTurn: (t) => dispatched.push(t),
      fetchImpl,
    });

    await backfill();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [endpoint, init] = fetchImpl.mock.calls[0];
    expect(endpoint).toBe("https://chorus.example.com/api/daemon/pending-turns?connectionUuid=conn-1");
    expect(init.headers.Authorization).toBe("Bearer cho_secret");
    expect(dispatched).toEqual(pendingTurns);
  });

  it("skips pending-turn fetch entirely when the connectionUuid is not known yet", async () => {
    const fetchImpl = vi.fn(async () => envelope([]));
    const mcpClient = { callTool: vi.fn(async () => ({ notifications: [] })) };
    const backfill = createBackfill({
      mcpClient,
      dispatch: () => {},
      logger: silent,
      url: "https://c",
      apiKey: "cho_x",
      getConnectionUuid: () => null, // SSE handshake hasn't reported it
      dispatchPendingTurn: vi.fn(),
      fetchImpl,
    });
    await backfill();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("de-dupes pending turns already in the shared seen set (keyed turn:<uuid>), pre-check only", async () => {
    const seen = new Set(["turn:t1"]); // t1 already handled live
    const pendingTurns = [
      { turnUuid: "t1", sessionId: DIRECT_IDEA, directIdeaUuid: DIRECT_IDEA, seq: 1, trigger: "human_instruction", promptText: "a" },
      { turnUuid: "t2", sessionId: DIRECT_IDEA, directIdeaUuid: DIRECT_IDEA, seq: 2, trigger: "human_instruction", promptText: "b" },
    ];
    const fetchImpl = vi.fn(async () => envelope(pendingTurns));
    const dispatched = [];
    const backfill = createBackfill({
      mcpClient: { callTool: vi.fn(async () => ({ notifications: [] })) },
      dispatch: () => {},
      seen,
      logger: silent,
      url: "https://c",
      apiKey: "cho_x",
      getConnectionUuid: () => "conn-1",
      dispatchPendingTurn: (t) => dispatched.push(t),
      fetchImpl,
    });
    await backfill();
    // t1 skipped (already seen), t2 dispatched. Backfill must NOT mark seen itself
    // (the router's dispatchPendingTurn owns marking) — so t2 stays unmarked here.
    expect(dispatched.map((t) => t.turnUuid)).toEqual(["t2"]);
    expect(seen.has("turn:t2")).toBe(false);
  });

  it("does both sources: notification backfill AND pending-turn backfill run", async () => {
    const fetchImpl = vi.fn(async () => envelope([
      { turnUuid: "t1", sessionId: DIRECT_IDEA, directIdeaUuid: DIRECT_IDEA, seq: 1, trigger: "human_instruction", promptText: "a" },
    ]));
    const mcpClient = { callTool: vi.fn(async () => ({ notifications: [{ uuid: "n1" }] })) };
    const dispatchedEvents = [];
    const dispatchedTurns = [];
    const backfill = createBackfill({
      mcpClient,
      dispatch: (e) => dispatchedEvents.push(e),
      logger: silent,
      url: "https://c",
      apiKey: "cho_x",
      getConnectionUuid: () => "conn-1",
      dispatchPendingTurn: (t) => dispatchedTurns.push(t),
      fetchImpl,
    });
    await backfill();
    expect(dispatchedEvents).toEqual([{ type: "new_notification", notificationUuid: "n1" }]);
    expect(dispatchedTurns).toHaveLength(1);
  });

  it("a pending-turns fetch failure does not abort the notification backfill (sources isolated)", async () => {
    const warns = [];
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const dispatchedEvents = [];
    const backfill = createBackfill({
      mcpClient: { callTool: vi.fn(async () => ({ notifications: [{ uuid: "n1" }] })) },
      dispatch: (e) => dispatchedEvents.push(e),
      logger: { ...silent, warn: (m) => warns.push(m) },
      url: "https://c",
      apiKey: "cho_x",
      getConnectionUuid: () => "conn-1",
      dispatchPendingTurn: vi.fn(),
      fetchImpl,
    });
    await expect(backfill()).resolves.toBeUndefined();
    // The notification source still ran and dispatched.
    expect(dispatchedEvents).toEqual([{ type: "new_notification", notificationUuid: "n1" }]);
    expect(warns.join("")).toMatch(/pending-turns backfill request failed/);
  });

  it("when pending-turn wiring is absent, only the notification backfill runs (back-compat)", async () => {
    const mcpClient = { callTool: vi.fn(async () => ({ notifications: [{ uuid: "n1" }] })) };
    const dispatchedEvents = [];
    // No url/apiKey/getConnectionUuid/dispatchPendingTurn — original behavior.
    const backfill = createBackfill({
      mcpClient,
      dispatch: (e) => dispatchedEvents.push(e),
      logger: silent,
    });
    await backfill();
    expect(dispatchedEvents).toEqual([{ type: "new_notification", notificationUuid: "n1" }]);
  });

  it("exposes pendingTurnsOnly — the connection-scoped sweep ALONE — for the live deliver_turn ping (子2)", async () => {
    // The deliver_turn control branch reuses THIS exact sweep (no second sweep) and must NOT
    // re-run the notification source. Calling backfill.pendingTurnsOnly() runs only the
    // pending-turns GET, never chorus_get_notifications.
    const pendingTurns = [
      { turnUuid: "t1", sessionId: DIRECT_IDEA, directIdeaUuid: DIRECT_IDEA, seq: 1, trigger: "human_instruction", promptText: "x" },
    ];
    const fetchImpl = vi.fn(async () => envelope(pendingTurns));
    const callTool = vi.fn(async () => ({ notifications: [{ uuid: "n1" }] }));
    const dispatched = [];

    const backfill = createBackfill({
      mcpClient: { callTool },
      dispatch: () => {},
      logger: silent,
      url: "https://c",
      apiKey: "cho_x",
      getConnectionUuid: () => "conn-1",
      dispatchPendingTurn: (t) => dispatched.push(t),
      fetchImpl,
    });

    expect(typeof backfill.pendingTurnsOnly).toBe("function");
    await backfill.pendingTurnsOnly();

    // Pending-turns GET ran; the notification source did NOT.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(callTool).not.toHaveBeenCalled();
    expect(dispatched.map((t) => t.turnUuid)).toEqual(["t1"]);
  });

  it("pendingTurnsOnly(turnUuid) dispatches ONLY that turn even when several are pending (子2 — precise live delivery)", async () => {
    // The multi-wake bug: a connection-wide sweep dispatched EVERY pending turn. With a
    // precise turnUuid, a fresh deliver_turn ping must run ONLY its own turn — the others
    // (a stale @mention, an older queued instruction) are left for the reconnect sweep.
    const pendingTurns = [
      { turnUuid: "stale-mention", sessionId: DIRECT_IDEA, directIdeaUuid: DIRECT_IDEA, seq: 1, trigger: "mentioned", promptText: null },
      { turnUuid: "older-instr", sessionId: DIRECT_IDEA, directIdeaUuid: DIRECT_IDEA, seq: 2, trigger: "human_instruction", promptText: "old" },
      { turnUuid: "fresh-instr", sessionId: DIRECT_IDEA, directIdeaUuid: DIRECT_IDEA, seq: 3, trigger: "human_instruction", promptText: "你好" },
    ];
    const fetchImpl = vi.fn(async () => envelope(pendingTurns));
    const dispatched = [];
    const backfill = createBackfill({
      mcpClient: { callTool: vi.fn(async () => ({ notifications: [] })) },
      dispatch: () => {},
      logger: silent,
      url: "https://c",
      apiKey: "cho_x",
      getConnectionUuid: () => "conn-1",
      dispatchPendingTurn: (t) => dispatched.push(t),
      fetchImpl,
    });

    // Precise: only the freshly-created turn is dispatched.
    await backfill.pendingTurnsOnly("fresh-instr");
    expect(dispatched.map((t) => t.turnUuid)).toEqual(["fresh-instr"]);

    // Contrast: the arg-less reconnect sweep recovers ALL pending (the lost-ping safety net).
    dispatched.length = 0;
    await backfill.pendingTurnsOnly();
    expect(dispatched.map((t) => t.turnUuid).sort()).toEqual(
      ["fresh-instr", "older-instr", "stale-mention"],
    );
  });

  it("live deliver_turn (pendingTurnsOnly) then reconnect backfill share the seen set → turn handled at most once", async () => {
    // The shared `seen` set is keyed `turn:<uuid>`. dispatchPendingTurn (the real router)
    // is the single owner of marking-seen; here we simulate it by marking on dispatch, then
    // assert the second observation is a pre-check no-op.
    const seen = new Set();
    const pendingTurns = [
      { turnUuid: "t1", sessionId: DIRECT_IDEA, directIdeaUuid: DIRECT_IDEA, seq: 1, trigger: "human_instruction", promptText: "x" },
    ];
    const fetchImpl = vi.fn(async () => envelope(pendingTurns));
    const dispatched = [];
    const dispatchPendingTurn = (t) => {
      // Mirror the router: pre-check seen, then mark.
      if (seen.has(`turn:${t.turnUuid}`)) return;
      seen.add(`turn:${t.turnUuid}`);
      dispatched.push(t);
    };

    const backfill = createBackfill({
      mcpClient: { callTool: vi.fn(async () => ({ notifications: [] })) },
      dispatch: () => {},
      seen,
      logger: silent,
      url: "https://c",
      apiKey: "cho_x",
      getConnectionUuid: () => "conn-1",
      dispatchPendingTurn,
      fetchImpl,
    });

    // Live ping sweep — dispatches t1 and marks it seen.
    await backfill.pendingTurnsOnly();
    // Reconnect backfill later observes the SAME turn — the pre-check skips it.
    await backfill();

    expect(dispatched.map((t) => t.turnUuid)).toEqual(["t1"]); // exactly once
  });

  it("handles a non-2xx pending-turns response (logged, no dispatch)", async () => {
    const warns = [];
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }));
    const dispatchedTurns = [];
    const backfill = createBackfill({
      mcpClient: { callTool: vi.fn(async () => ({ notifications: [] })) },
      dispatch: () => {},
      logger: { ...silent, warn: (m) => warns.push(m) },
      url: "https://c",
      apiKey: "cho_x",
      getConnectionUuid: () => "conn-1",
      dispatchPendingTurn: (t) => dispatchedTurns.push(t),
      fetchImpl,
    });
    await backfill();
    expect(dispatchedTurns).toHaveLength(0);
    expect(warns.join("")).toMatch(/pending-turns backfill returned 404/);
  });
});
