// @vitest-environment jsdom
//
// Unit tests for the resume gate (src/lib/resume-gate.ts): the shared primitive that
// defers resume-triggered SSE reconnects/fetches until the auth resume revalidation
// settles, bounding the post-resume concurrent-refresh burst to one racer.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  armResumeGate,
  beginResumeRevalidation,
  settleResumeRevalidation,
  waitForResumeGate,
  RESUME_GATE_TIMEOUT_MS,
  __resetResumeGateForTests,
} from "@/lib/resume-gate";

// Track resolution without awaiting (which would deadlock a pending gate).
function trackResolved(p: Promise<void>): { resolved: boolean } {
  const state = { resolved: false };
  p.then(() => {
    state.resolved = true;
  });
  return state;
}

// Let queued microtasks run so `.then` callbacks fire.
const flushMicrotasks = () => Promise.resolve().then(() => Promise.resolve());

beforeEach(() => {
  vi.useFakeTimers();
  __resetResumeGateForTests();
});

afterEach(async () => {
  __resetResumeGateForTests();
  await vi.runAllTimersAsync();
  vi.useRealTimers();
});

describe("resume-gate", () => {
  it("resolves immediately when no resume window is armed", async () => {
    const state = trackResolved(waitForResumeGate());
    await flushMicrotasks();
    expect(state.resolved).toBe(true);
  });

  it("holds waiters while armed and releases them on settle", async () => {
    armResumeGate();
    beginResumeRevalidation();

    const state = trackResolved(waitForResumeGate());
    await flushMicrotasks();
    expect(state.resolved).toBe(false);

    settleResumeRevalidation();
    await flushMicrotasks();
    expect(state.resolved).toBe(true);

    // Gate is closed again: new waits resolve immediately.
    const after = trackResolved(waitForResumeGate());
    await flushMicrotasks();
    expect(after.resolved).toBe(true);
  });

  it("releases waiters via the hard timeout when the revalidation never settles", async () => {
    armResumeGate(); // armed, but no auth context ever begins/settles

    const state = trackResolved(waitForResumeGate());
    await flushMicrotasks();
    expect(state.resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(RESUME_GATE_TIMEOUT_MS - 1);
    expect(state.resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(state.resolved).toBe(true);
  });

  it("coalesces repeated arms onto the same pending promise", async () => {
    armResumeGate();
    const first = waitForResumeGate();

    armResumeGate(); // e.g. pageshow(persisted) + visibilitychange both fire
    armResumeGate();
    const second = waitForResumeGate();

    // Same window → identical promise; settling releases both.
    expect(second).toBe(first);

    const s1 = trackResolved(first);
    const s2 = trackResolved(second);
    settleResumeRevalidation();
    await flushMicrotasks();
    expect(s1.resolved).toBe(true);
    expect(s2.resolved).toBe(true);
  });

  it("beginResumeRevalidation arms a window when none is open (revalidation without a visibility event)", async () => {
    beginResumeRevalidation();

    const state = trackResolved(waitForResumeGate());
    await flushMicrotasks();
    expect(state.resolved).toBe(false);

    settleResumeRevalidation();
    await flushMicrotasks();
    expect(state.resolved).toBe(true);
  });

  it("settle with no window open is a safe no-op", async () => {
    settleResumeRevalidation();
    const state = trackResolved(waitForResumeGate());
    await flushMicrotasks();
    expect(state.resolved).toBe(true);
  });

  it("a new window after settle gets a fresh promise", async () => {
    armResumeGate();
    const first = waitForResumeGate();
    settleResumeRevalidation();

    armResumeGate();
    const second = waitForResumeGate();
    expect(second).not.toBe(first);

    const state = trackResolved(second);
    await flushMicrotasks();
    expect(state.resolved).toBe(false);
    settleResumeRevalidation();
    await flushMicrotasks();
    expect(state.resolved).toBe(true);
  });

  it("arms on visibilitychange→visible via the module-level listener", async () => {
    // jsdom: simulate the document going hidden then visible.
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));

    const state = trackResolved(waitForResumeGate());
    await flushMicrotasks();
    expect(state.resolved).toBe(false); // armed by the module's own listener

    settleResumeRevalidation();
    await flushMicrotasks();
    expect(state.resolved).toBe(true);
  });

  it("arms on pageshow(persisted) via the module-level listener", async () => {
    const evt = new Event("pageshow") as PageTransitionEvent;
    Object.defineProperty(evt, "persisted", { value: true });
    window.dispatchEvent(evt);

    const state = trackResolved(waitForResumeGate());
    await flushMicrotasks();
    expect(state.resolved).toBe(false);

    settleResumeRevalidation();
    await flushMicrotasks();
    expect(state.resolved).toBe(true);
  });

  it("does not arm on a non-persisted pageshow (normal load)", async () => {
    const evt = new Event("pageshow") as PageTransitionEvent;
    Object.defineProperty(evt, "persisted", { value: false });
    window.dispatchEvent(evt);

    const state = trackResolved(waitForResumeGate());
    await flushMicrotasks();
    expect(state.resolved).toBe(true);
  });
});
