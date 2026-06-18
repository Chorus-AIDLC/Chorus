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
