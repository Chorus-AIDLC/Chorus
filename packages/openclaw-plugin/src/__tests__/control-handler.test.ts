import { describe, it, expect, vi, beforeEach } from "vitest";
import { createControlHandler, type ControlBehaviorHooks, type ControlEvent } from "../control-handler.js";
import { ConnectionState } from "../connection-state.js";

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("createControlHandler", () => {
  let logger: ReturnType<typeof makeLogger>;
  let onInterrupt: ReturnType<typeof vi.fn>;
  let onResume: ReturnType<typeof vi.fn>;
  let onDeliverTurn: ReturnType<typeof vi.fn>;
  let isEntityRunning: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    logger = makeLogger();
    onInterrupt = vi.fn();
    onResume = vi.fn();
    onDeliverTurn = vi.fn();
    isEntityRunning = vi.fn(() => true);
  });

  /** Build a handler whose connection identity is `myUuid`. */
  function build(myUuid: string | null, hooksOver: Partial<ControlBehaviorHooks> = {}) {
    const connectionState = new ConnectionState();
    if (myUuid) connectionState.setConnectionUuid(myUuid);
    const hooks: ControlBehaviorHooks = {
      isEntityRunning,
      onInterrupt,
      onResume,
      onDeliverTurn,
      ...hooksOver,
    };
    const onControl = createControlHandler({ connectionState, hooks, logger });
    return { onControl, connectionState };
  }

  function noHookCalled() {
    expect(onInterrupt).not.toHaveBeenCalled();
    expect(onResume).not.toHaveBeenCalled();
    expect(onDeliverTurn).not.toHaveBeenCalled();
  }

  // --- Command routing to the three hooks (own connection, all checks pass) ---

  it("routes a verified interrupt to onInterrupt", () => {
    const { onControl } = build("conn-1");
    onControl({
      type: "control",
      command: "interrupt",
      targetConnectionUuid: "conn-1",
      entityType: "task",
      entityUuid: "task-9",
    });
    expect(onInterrupt).toHaveBeenCalledWith("task", "task-9");
    expect(onResume).not.toHaveBeenCalled();
    expect(onDeliverTurn).not.toHaveBeenCalled();
  });

  it("routes a verified resume to onResume (no running-entity requirement)", () => {
    // isEntityRunning=false on purpose — resume must NOT depend on a held run.
    const { onControl } = build("conn-1", { isEntityRunning: () => false });
    onControl({
      type: "control",
      command: "resume",
      targetConnectionUuid: "conn-1",
      entityType: "idea",
      entityUuid: "idea-3",
    });
    expect(onResume).toHaveBeenCalledWith("idea", "idea-3");
    expect(onInterrupt).not.toHaveBeenCalled();
  });

  it("routes a verified deliver_turn (with turnUuid) to onDeliverTurn precisely", () => {
    const { onControl } = build("conn-1");
    onControl({
      type: "control",
      command: "deliver_turn",
      targetConnectionUuid: "conn-1",
      turnUuid: "turn-7",
    });
    expect(onDeliverTurn).toHaveBeenCalledWith("turn-7");
    expect(onInterrupt).not.toHaveBeenCalled();
    expect(onResume).not.toHaveBeenCalled();
  });

  it("routes a deliver_turn WITHOUT turnUuid as a full-sweep fallback (undefined)", () => {
    const { onControl } = build("conn-1");
    onControl({
      type: "control",
      command: "deliver_turn",
      targetConnectionUuid: "conn-1",
    });
    expect(onDeliverTurn).toHaveBeenCalledWith(undefined);
  });

  // --- Double-check ignore path 1: wrong connectionUuid (every command) ---

  it("ignores interrupt for a DIFFERENT connection (Check 1 fail) + logs", () => {
    const { onControl } = build("conn-1");
    onControl({
      type: "control",
      command: "interrupt",
      targetConnectionUuid: "conn-OTHER",
      entityType: "task",
      entityUuid: "task-9",
    });
    noHookCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("ignoring interrupt for connection conn-OTHER"));
  });

  it("ignores resume / deliver_turn for a different connection too", () => {
    const { onControl } = build("conn-1");
    onControl({ type: "control", command: "resume", targetConnectionUuid: "conn-X", entityType: "task", entityUuid: "t" });
    onControl({ type: "control", command: "deliver_turn", targetConnectionUuid: "conn-X", turnUuid: "turn-1" });
    noHookCalled();
  });

  it("ignores any command before the handshake (no connectionUuid yet) + logs", () => {
    const { onControl } = build(null);
    onControl({
      type: "control",
      command: "interrupt",
      targetConnectionUuid: "conn-1",
      entityType: "task",
      entityUuid: "task-9",
    });
    noHookCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("<unregistered>"));
  });

  // --- Double-check ignore path 2: interrupt with no running entity held ---

  it("ignores interrupt when the entity is NOT running (Check 2 fail) + logs", () => {
    const { onControl } = build("conn-1", { isEntityRunning: () => false });
    onControl({
      type: "control",
      command: "interrupt",
      targetConnectionUuid: "conn-1",
      entityType: "task",
      entityUuid: "task-9",
    });
    expect(onInterrupt).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("no running embedded-agent run"));
  });

  it("interrupt consults isEntityRunning with the command's entity", () => {
    const probe = vi.fn(() => true);
    const { onControl } = build("conn-1", { isEntityRunning: probe });
    onControl({
      type: "control",
      command: "interrupt",
      targetConnectionUuid: "conn-1",
      entityType: "proposal",
      entityUuid: "prop-2",
    });
    expect(probe).toHaveBeenCalledWith("proposal", "prop-2");
    expect(onInterrupt).toHaveBeenCalledWith("proposal", "prop-2");
  });

  it("defaults isEntityRunning to false (no registry) — interrupt is a safe no-op", () => {
    const connectionState = new ConnectionState();
    connectionState.setConnectionUuid("conn-1");
    // No isEntityRunning provided at all.
    const onControl = createControlHandler({ connectionState, hooks: { onInterrupt }, logger });
    onControl({
      type: "control",
      command: "interrupt",
      targetConnectionUuid: "conn-1",
      entityType: "task",
      entityUuid: "task-9",
    });
    expect(onInterrupt).not.toHaveBeenCalled();
  });

  // --- entity-field validation for interrupt/resume ---

  it("ignores interrupt/resume missing entity fields + warns", () => {
    const { onControl } = build("conn-1");
    onControl({ type: "control", command: "interrupt", targetConnectionUuid: "conn-1" } as ControlEvent);
    expect(onInterrupt).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("missing entityType/entityUuid"));
  });

  // --- forward-compatibility + non-control guards ---

  it("ignores an unknown command + warns (forward-compatible)", () => {
    const { onControl } = build("conn-1");
    onControl({ type: "control", command: "explode", targetConnectionUuid: "conn-1" } as ControlEvent);
    noHookCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('"explode" not supported'));
  });

  it("ignores a non-control event + warns", () => {
    const { onControl } = build("conn-1");
    onControl({ type: "new_notification" } as ControlEvent);
    noHookCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("non-control event"));
  });

  // --- non-throwing backstop: a hook that throws must not escape ---

  it("never throws even when a behavior hook throws (logs instead)", () => {
    const { onControl } = build("conn-1", {
      onInterrupt: () => {
        throw new Error("boom");
      },
    });
    expect(() =>
      onControl({
        type: "control",
        command: "interrupt",
        targetConnectionUuid: "conn-1",
        entityType: "task",
        entityUuid: "task-9",
      }),
    ).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("interrupt hook failed"));
  });

  it("never throws when getConnectionUuid itself throws (error backstop)", () => {
    const throwingState = {
      getConnectionUuid: () => {
        throw new Error("state boom");
      },
    };
    const onControl = createControlHandler({
      connectionState: throwingState,
      hooks: { onInterrupt },
      logger,
    });
    expect(() =>
      onControl({
        type: "control",
        command: "interrupt",
        targetConnectionUuid: "conn-1",
        entityType: "task",
        entityUuid: "task-9",
      }),
    ).not.toThrow();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("control-handler unexpected error"));
    expect(onInterrupt).not.toHaveBeenCalled();
  });
});
