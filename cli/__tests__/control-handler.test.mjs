// cli/__tests__/control-handler.test.mjs
// Covers the daemon-side control handler's q1=a DOUBLE-CHECK (子3 —
// daemon-interrupt-resume, spec "The control event SHALL be delivered to the
// targeted connection and verified twice on the daemon"):
//   • acts ONLY when connectionUuid matches AND a running child for the entity exists
//   • connection-uuid mismatch → ignored (no kill)
//   • entity-not-held / queued (no child) → ignored (no kill), logged
//   • on a verified match → marks interrupting, then invokes the killer on the child
//   • never throws into the SSE loop.
import { describe, it, expect, vi } from "vitest";
import { createControlHandler } from "../control-handler.mjs";

const silent = { info() {}, warn() {}, error() {} };

const CONN = "conn-abc";
const ENTITY = { entityType: "task", entityUuid: "task-1" };

/** A waker stub with an executions Map + a spy markInterrupting. */
function makeWaker(entries = []) {
  const executions = new Map(entries);
  return {
    executions,
    markInterrupting: vi.fn(),
  };
}

/** A running registry entry holding a live child. */
function runningEntry(child = { pid: 4242 }) {
  return [
    `${ENTITY.entityType}:${ENTITY.entityUuid}`,
    { entityType: ENTITY.entityType, entityUuid: ENTITY.entityUuid, status: "running", child },
  ];
}

function controlEvent(overrides = {}) {
  return {
    type: "control",
    command: "interrupt",
    targetConnectionUuid: CONN,
    entityType: ENTITY.entityType,
    entityUuid: ENTITY.entityUuid,
    ...overrides,
  };
}

describe("control-handler double-check (q1=a)", () => {
  it("acts ONLY when connection matches AND a running child exists: marks interrupting + kills the child", () => {
    const child = { pid: 9001 };
    const waker = makeWaker([runningEntry(child)]);
    const killer = vi.fn(async () => ({ killed: true, escalated: false }));
    const onControl = createControlHandler({
      waker,
      getConnectionUuid: () => CONN,
      killer,
      sigintTimeoutMs: 1234,
      logger: silent,
    });

    onControl(controlEvent());

    expect(waker.markInterrupting).toHaveBeenCalledWith("task", "task-1");
    expect(killer).toHaveBeenCalledTimes(1);
    expect(killer.mock.calls[0][0]).toBe(child); // the live child handle
    expect(killer.mock.calls[0][1]).toMatchObject({ sigintTimeoutMs: 1234 });
  });

  it("connection-uuid mismatch → ignored, no kill, no markInterrupting", () => {
    const waker = makeWaker([runningEntry()]);
    const killer = vi.fn(async () => {});
    const onControl = createControlHandler({
      waker,
      getConnectionUuid: () => CONN,
      killer,
      logger: silent,
    });

    onControl(controlEvent({ targetConnectionUuid: "some-other-connection" }));

    expect(killer).not.toHaveBeenCalled();
    expect(waker.markInterrupting).not.toHaveBeenCalled();
  });

  it("entity not held (no registry entry) → ignored, logged, no kill", () => {
    const infos = [];
    const waker = makeWaker([]); // empty registry
    const killer = vi.fn(async () => {});
    const onControl = createControlHandler({
      waker,
      getConnectionUuid: () => CONN,
      killer,
      logger: { ...silent, info: (m) => infos.push(m) },
    });

    onControl(controlEvent());

    expect(killer).not.toHaveBeenCalled();
    expect(waker.markInterrupting).not.toHaveBeenCalled();
    expect(infos.join("")).toMatch(/no running subprocess/i);
  });

  it("entity present but only QUEUED (no child) → ignored, no kill", () => {
    const waker = makeWaker([
      [`${ENTITY.entityType}:${ENTITY.entityUuid}`, { ...ENTITY, status: "queued", child: null }],
    ]);
    const killer = vi.fn(async () => {});
    const onControl = createControlHandler({ waker, getConnectionUuid: () => CONN, killer, logger: silent });

    onControl(controlEvent());

    expect(killer).not.toHaveBeenCalled();
  });

  it("ignores the command while the daemon has not yet registered a connectionUuid", () => {
    const waker = makeWaker([runningEntry()]);
    const killer = vi.fn(async () => {});
    const onControl = createControlHandler({ waker, getConnectionUuid: () => null, killer, logger: silent });

    onControl(controlEvent());
    expect(killer).not.toHaveBeenCalled();
  });

  it("ignores a genuinely unsupported command (forward-compatible), logs it", () => {
    const warns = [];
    const waker = makeWaker([runningEntry()]);
    const killer = vi.fn(async () => {});
    const redispatchResume = vi.fn();
    const onControl = createControlHandler({
      waker,
      getConnectionUuid: () => CONN,
      killer,
      redispatchResume,
      logger: { ...silent, warn: (m) => warns.push(m) },
    });

    onControl(controlEvent({ command: "pause" }));
    expect(killer).not.toHaveBeenCalled();
    expect(redispatchResume).not.toHaveBeenCalled();
    expect(warns.join("")).toMatch(/not supported/);
  });

  it("resume: re-dispatches the wake for the entity (no kill), only when the connection matches", () => {
    const waker = makeWaker([]); // no running child needed for resume
    const killer = vi.fn(async () => {});
    const redispatchResume = vi.fn();
    const onControl = createControlHandler({
      waker,
      getConnectionUuid: () => CONN,
      killer,
      redispatchResume,
      logger: silent,
    });

    onControl(controlEvent({ command: "resume" }));
    expect(redispatchResume).toHaveBeenCalledWith(ENTITY.entityType, ENTITY.entityUuid);
    expect(killer).not.toHaveBeenCalled();
  });

  it("resume: a connection-uuid mismatch does NOT re-dispatch", () => {
    const waker = makeWaker([]);
    const redispatchResume = vi.fn();
    const onControl = createControlHandler({
      waker,
      getConnectionUuid: () => CONN,
      redispatchResume,
      logger: silent,
    });

    onControl(controlEvent({ command: "resume", targetConnectionUuid: "someone-else" }));
    expect(redispatchResume).not.toHaveBeenCalled();
  });

  it("never throws even if the killer rejects (fire-and-forget)", async () => {
    const waker = makeWaker([runningEntry()]);
    const killer = vi.fn(async () => { throw new Error("kill blew up"); });
    const warns = [];
    const onControl = createControlHandler({
      waker,
      getConnectionUuid: () => CONN,
      killer,
      logger: { ...silent, warn: (m) => warns.push(m) },
    });

    expect(() => onControl(controlEvent())).not.toThrow();
    // Let the rejected promise settle.
    await new Promise((r) => setTimeout(r, 0));
    expect(warns.join("")).toMatch(/killProcessTree rejected/);
  });

  it("never throws on a malformed event (missing entity fields)", () => {
    const waker = makeWaker([runningEntry()]);
    const killer = vi.fn(async () => {});
    const onControl = createControlHandler({ waker, getConnectionUuid: () => CONN, killer, logger: silent });
    expect(() => onControl({ type: "control", command: "interrupt", targetConnectionUuid: CONN })).not.toThrow();
    expect(killer).not.toHaveBeenCalled();
  });
});

// ===== deliver_turn (子2 — origin-only live delivery, precise turn) =====
// The deliver_turn branch is connection-targeted + turn-precise: after Check 1 (connection
// match) it dispatches ONLY the announced turn (event.turnUuid) — never a connection-wide
// sweep. No entity on the wire, no running-child requirement (mirrors resume), non-throwing
// into the SSE loop. A deliver_turn missing turnUuid (older server) falls back to a full sweep.
const TURN_UUID = "turn-0000-0000-0000-00000000dead";
describe("control-handler deliver_turn (子2 — origin-only live delivery)", () => {
  function deliverEvent(overrides = {}) {
    // NOTE: connection-targeted + turn-precise — carries turnUuid, NO entityType/entityUuid
    // (the daemon reads the turn, and its text, by uuid from the persisted turn).
    return {
      type: "control",
      command: "deliver_turn",
      targetConnectionUuid: CONN,
      turnUuid: TURN_UUID,
      ...overrides,
    };
  }

  it("connection MATCH → dispatches ONLY the announced turn (by turnUuid), once, no kill/entity", () => {
    const waker = makeWaker([]); // no running child needed (mirrors resume)
    const killer = vi.fn(async () => {});
    const deliverTurn = vi.fn();
    const onControl = createControlHandler({
      waker,
      getConnectionUuid: () => CONN,
      killer,
      deliverTurn,
      logger: silent,
    });

    onControl(deliverEvent());

    expect(deliverTurn).toHaveBeenCalledTimes(1);
    // The PRECISE turnUuid is forwarded so ONLY that turn runs — not a connection-wide
    // sweep that would drag every other still-pending turn along (the multi-wake bug).
    expect(deliverTurn.mock.calls[0]).toEqual([TURN_UUID]);
    expect(killer).not.toHaveBeenCalled();
    expect(waker.markInterrupting).not.toHaveBeenCalled();
  });

  it("a deliver_turn WITHOUT turnUuid (older server) falls back to a full sweep (deliverTurn(undefined))", () => {
    const deliverTurn = vi.fn();
    const onControl = createControlHandler({
      waker: makeWaker([]),
      getConnectionUuid: () => CONN,
      deliverTurn,
      logger: silent,
    });

    onControl(deliverEvent({ turnUuid: undefined }));

    expect(deliverTurn).toHaveBeenCalledTimes(1);
    // No precise turn → arg-less sweep (recovers all pending — the lost-ping safety net).
    expect(deliverTurn.mock.calls[0]).toEqual([undefined]);
  });

  it("connection MISMATCH (Check 1) → logged no-op, does NOT sweep", () => {
    const infos = [];
    const deliverTurn = vi.fn();
    const onControl = createControlHandler({
      waker: makeWaker([]),
      getConnectionUuid: () => CONN,
      deliverTurn,
      logger: { ...silent, info: (m) => infos.push(m) },
    });

    onControl(deliverEvent({ targetConnectionUuid: "some-other-connection" }));

    expect(deliverTurn).not.toHaveBeenCalled();
    expect(infos.join("")).toMatch(/ignoring deliver_turn/i);
  });

  it("ignores deliver_turn before the daemon has registered a connectionUuid (no sweep)", () => {
    const deliverTurn = vi.fn();
    const onControl = createControlHandler({
      waker: makeWaker([]),
      getConnectionUuid: () => null, // handshake not complete
      deliverTurn,
      logger: silent,
    });

    onControl(deliverEvent());
    expect(deliverTurn).not.toHaveBeenCalled();
  });

  it("never throws if the injected sweep throws (non-throwing into the SSE loop), logs it", () => {
    const warns = [];
    const deliverTurn = vi.fn(() => {
      throw new Error("sweep blew up");
    });
    const onControl = createControlHandler({
      waker: makeWaker([]),
      getConnectionUuid: () => CONN,
      deliverTurn,
      logger: { ...silent, warn: (m) => warns.push(m) },
    });

    expect(() => onControl(deliverEvent())).not.toThrow();
    expect(deliverTurn).toHaveBeenCalledTimes(1);
    expect(warns.join("")).toMatch(/deliver_turn failed/i);
  });

  it("tolerates a missing deliverTurn dep (no sweep wired) without throwing", () => {
    const onControl = createControlHandler({
      waker: makeWaker([]),
      getConnectionUuid: () => CONN,
      logger: silent,
    });
    expect(() => onControl(deliverEvent())).not.toThrow();
  });
});
