// src/lib/resume-gate.ts
//
// Resume gate: bounds the burst of middleware-covered requests fired when a
// backgrounded tab becomes visible again (the iOS resume case).
//
// Problem: on `visibilitychange→visible` / `pageshow(persisted)`, the auth context's
// resume revalidation (cookie prime + session probe) races with the SSE contexts'
// reconnects AND their same-handler fetches. Every racer carries the SAME expired
// `oidc_access_token` cookie, so each middleware invocation independently attempts the
// IdP refresh — and under refresh-token rotation only one can win (the losers get
// `invalid_grant`, and their replay of the consumed refresh token can even trip the
// IdP's reuse detection and revoke the whole token family). The middleware is lenient
// about failures (see src/middleware.ts), but this gate makes the race itself rare:
// resume-triggered work waits until the auth revalidation settles, so at most one
// request races to refresh instead of one per stream/fetch.
//
// Design constraints:
// - Pure TS, no React: consumed by both the auth context (producer) and the SSE
//   contexts (waiters), and unit-testable with fake timers.
// - The module registers its OWN resume listener at client module-evaluation time.
//   Module evaluation precedes every React effect registration, so the gate's
//   `armResumeGate()` state write is visible to any SSE handler that runs in the same
//   event dispatch — regardless of listener registration order. Without this, an SSE
//   handler registered before the auth context's would observe "nothing pending" and
//   reconnect immediately.
// - A hard timeout guarantees the gate can never deadlock stream reconnection: if the
//   AuthProvider is absent (login page), unmounted, or its revalidation hangs, waiters
//   are released after RESUME_GATE_TIMEOUT_MS.
// - Outside an armed resume window, `waitForResumeGate()` resolves immediately — zero
//   behavior change for initial-mount connections or normal foreground operation.

export const RESUME_GATE_TIMEOUT_MS = 8000;

interface GateState {
  pending: Promise<void>;
  resolve: () => void;
  timeoutId: ReturnType<typeof setTimeout>;
  revalidating: boolean;
}

let gate: GateState | null = null;

function openGate(): void {
  if (gate) return; // repeated arms coalesce onto the same pending promise
  let resolve!: () => void;
  const pending = new Promise<void>((r) => {
    resolve = r;
  });
  const timeoutId = setTimeout(releaseGate, RESUME_GATE_TIMEOUT_MS);
  gate = { pending, resolve, timeoutId, revalidating: false };
}

function releaseGate(): void {
  if (!gate) return;
  clearTimeout(gate.timeoutId);
  gate.resolve();
  gate = null;
}

/**
 * Open a resume window. Called by this module's own resume listener; exported so the
 * auth context (or tests) can arm explicitly. Idempotent while a window is open.
 */
export function armResumeGate(): void {
  openGate();
}

/**
 * Mark the auth resume revalidation as started. Keeps the current window open (arms
 * one if none is open — e.g. a revalidation triggered without a visibility event).
 */
export function beginResumeRevalidation(): void {
  openGate();
  gate!.revalidating = true;
}

/**
 * Mark the auth resume revalidation as finished (call in `finally`). Releases every
 * waiter. Safe to call with no window open.
 */
export function settleResumeRevalidation(): void {
  releaseGate();
}

/**
 * Resolves when it is safe to issue resume-triggered requests: immediately when no
 * resume window is armed, otherwise when the revalidation settles or the hard timeout
 * elapses — whichever comes first.
 */
export function waitForResumeGate(): Promise<void> {
  return gate ? gate.pending : Promise.resolve();
}

// Test-only: reset module state between tests.
export function __resetResumeGateForTests(): void {
  if (gate) clearTimeout(gate.timeoutId);
  gate?.resolve();
  gate = null;
}

// Arm the gate the moment a resume signal fires. If the auth context is mounted, its
// own listener begins the revalidation and settles the gate; if it never does, the
// timeout releases the waiters.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") armResumeGate();
  });
  window.addEventListener("pageshow", (e: PageTransitionEvent) => {
    if (e.persisted) armResumeGate();
  });
}
