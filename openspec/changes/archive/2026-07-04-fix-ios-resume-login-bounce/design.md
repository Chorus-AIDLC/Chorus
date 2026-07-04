# Technical Design: Fix iOS resume login bounce

## Overview

Two coordinated changes:

1. **Server (middleware):** make the OIDC refresh path in `src/middleware.ts`
   non-destructive on failure. Today five failure sites call `clearAuthAndRedirect()`,
   which expires all six auth cookies and 307-redirects to `/login`. After this change,
   every refresh failure passes the request through unchanged and emits a structured
   diagnostic log line. Session death remains exclusively the client's decision (the
   existing post-prime double-401 path in `auth-context.tsx` `fetchSession`).
2. **Client (resume gate):** stop the resume-time request burst at the source. A small
   shared gate module lets the three SSE contexts defer their `visibilitychange→visible`
   reconnects until the auth-context resume revalidation (prime + session probe) settles,
   so at most one middleware-covered request races to refresh instead of ~5.

## Why lenient failure is correct (the race argument)

With Cognito refresh-token rotation, N concurrent requests that all carry the same expired
access token trigger N independent IdP refresh calls. Exactly one wins; N−1 get
`invalid_grant`. From inside a single middleware invocation, "I lost the race" and "the
refresh token is genuinely revoked" are **indistinguishable** — same status, same error
code. The client probe CAN distinguish them: by the time `fetchSession` primes and retries,
the winner's `Set-Cookie` has landed, so a race loser recovers while a genuinely dead
session still double-401s and redirects. Therefore the middleware must never destroy state
on failure; it lacks the information to do so safely.

An additional hazard makes this urgent: OAuth reuse-detection semantics mean the losers'
replay of the already-consumed refresh token may cause the IdP to revoke the whole token
family — the losers can kill the winner's fresh tokens **at the IdP**, beyond anything
cookie hygiene can repair. This is why the client-side burst reduction (resume gate) is in
scope and not merely nice-to-have: lenient failure repairs the self-inflicted damage;
the gate makes the race itself rare.

## Architecture

### Middleware changes (`src/middleware.ts`)

Failure-site matrix (all become pass-through, no cookie mutation):

| Site (current line) | Condition | New behavior | Log `outcome` |
|---|---|---|---|
| `:233-235` | expired access token, missing refresh/client_id/issuer cookie | `NextResponse.next()` | `skipped_missing_materials` |
| `:240-243` | OIDC discovery failed | `NextResponse.next()` | `failed_discovery` |
| `:257-259` | IdP returned non-OK (incl. `invalid_grant`) | `NextResponse.next()` | `failed_idp` |
| `:265-267` | no `access_token` in response | `NextResponse.next()` | `failed_malformed` |
| `:296-299` | fetch threw (network) | `NextResponse.next()` | `failed_network` |
| success | — | unchanged (cookie write) | `refreshed` |

`clearAuthAndRedirect()` is deleted. No middleware path redirects to `/login` or expires
auth cookies anymore. (The pre-existing "no cookies at all → pass through" behavior at
`:207-211` is unchanged; the asymmetry that punished expired-token-without-materials
harder than no-token-at-all disappears.)

Pass-through on failure means downstream sees the stale/expired cookie and gated APIs
return 401. That is exactly the contract the client hardening rounds already implement:
`fetchSession` primes (a fresh middleware refresh chance) and retries once before
declaring death. Server Components calling `redirect("/login")` when
`getServerAuthContext()` is null only affect full document navigations — and on a full
navigation there is no concurrent burst (single request), so the refresh either succeeds
or the session is genuinely dead.

### Structured refresh diagnostics

One pino log line per refresh attempt via the existing `mwLogger` child logger:

```ts
mwLogger.info({
  event: "oidc_refresh",
  outcome,            // refreshed | failed_idp | failed_network | failed_discovery
                      // | failed_malformed | skipped_missing_materials
  status,             // IdP HTTP status when applicable
  errorCode,          // OAuth `error` field from the IdP body when parseable (e.g. invalid_grant)
  pathname,           // which request triggered the refresh (identifies the burst source)
  expDelta,           // seconds until/since access-token exp at decision time (negative = already expired)
  rotated,            // whether a new refresh_token was returned (success only)
  durationMs,         // token-endpoint round-trip
}, "OIDC refresh attempt");
```

`pathname` + timestamps make a resume burst directly visible in production logs: 4-5
`oidc_refresh` lines within ~1s, one `refreshed`, the rest `failed_idp`/`invalid_grant` —
or, post-fix, a single line. Failure outcomes log at `warn`. No DB/Activity writes.
IdP error body is read defensively (json parse may fail → `errorCode: undefined`).

### Resume gate (`src/lib/resume-gate.ts`, new)

A framework-free module (no React) shared by auth-context and the three SSE contexts:

```ts
armResumeGate(): void        // called synchronously by the gate's own visibility listener
beginResumeRevalidation(): void   // auth-context: revalidation started
settleResumeRevalidation(): void  // auth-context: prime + probe finished (finally block)
waitForResumeGate(): Promise<void> // SSE contexts: resolves when safe to reconnect
```

Semantics:

- The module registers its own `visibilitychange`/`pageshow(persisted)` listener **at
  client module-evaluation time** (guarded `typeof document !== "undefined"`). Module
  evaluation precedes every React effect registration, so the gate's listener always runs
  in the same event dispatch as — and its `armResumeGate()` state write is visible to —
  the SSE contexts' handlers regardless of listener registration order. This closes the
  ordering race where an SSE handler registered earlier would observe "nothing pending"
  and reconnect immediately.
- Arming opens a window in which `waitForResumeGate()` returns a pending promise. The
  promise resolves when `settleResumeRevalidation()` is called, **or** after a hard
  timeout (`RESUME_GATE_TIMEOUT_MS = 8000`), whichever comes first. The timeout guarantees
  the gate can never deadlock SSE reconnection — if AuthProvider is absent (login page),
  unmounted, or its revalidation hangs, streams still reconnect within 8s.
- When no resume window is armed (normal foreground operation, initial mount), \
  `waitForResumeGate()` resolves immediately — zero behavior change outside resume.
- Auth-context's existing `revalidate()` wraps its body with
  `beginResumeRevalidation()` / `settleResumeRevalidation()` (in `finally`).
- Repeated arming while a wait is outstanding reuses the same pending promise
  (idempotent, mirrors the existing `revalidateInFlight` coalescing).

### SSE context integration

In each of `notification-context.tsx`, `realtime-context.tsx`,
`agent-presence-context.tsx`: the **entire** `visibilitychange→visible` handler body is
gated — `await waitForResumeGate()` then the existing logic, with a "still visible?"
re-check after the await (the user may have backgrounded again during the wait). The gate
covers not just the EventSource `connect()` but every network-triggering action in the
same handler: notification-context's `fetchUnreadCount()`, agent-presence-context's
`fetchExecutions()`, and realtime-context's catch-up `notify()`/`notifyEntity()` fan-out
(each of which triggers consumer re-fetches through middleware-covered API routes).
Gating only the stream opens would leave 2-3 concurrent refresh racers and defeat the
gate's purpose. Initial-mount connections/fetches are NOT gated — only the
visibility-resume path. The agent-presence 15s poll tick is left alone (it is not
resume-correlated; the gate window plus lenient middleware covers the rare overlap).

The keepalive thaw double-fire (frozen `setTimeout` firing `/api/keepalive` on resume,
duplicating the revalidation prime) is also routed through `waitForResumeGate()` inside
`pingKeepalive`'s scheduling path in auth-context — cheap, and removes one more racer.

## Module Contracts

- `resume-gate.ts` exports the four functions above plus `RESUME_GATE_TIMEOUT_MS`; pure
  TS, no React, unit-testable with fake timers. All consumers import from `@/lib/resume-gate`.
- Middleware log contract: every refresh attempt emits exactly one `event: "oidc_refresh"`
  line with the field set above; tests assert on `outcome` values, so treat them as an enum
  (`src/lib/` type export if useful, but a string union in middleware is acceptable).
- No changes to `authFetch`, `fetchSession`, cookie names, cookie options, or the
  middleware matcher.

## Data Model

None.

## API Design

None (no new endpoints; `/api/keepalive` unchanged).

## Implementation Plan

1. **Task 1 — middleware:** delete `clearAuthAndRedirect`, convert the five failure sites
   to pass-through + diagnostics, update `src/__tests__/middleware-oidc-refresh.test.ts`
   (invert redirect assertions to pass-through + assert no `Set-Cookie` expiry headers,
   add per-outcome log assertions).
2. **Task 2 — resume gate:** add `src/lib/resume-gate.ts` + unit tests (arm/settle/timeout/
   immediate-resolve/coalescing, fake timers); integrate into auth-context and the three
   SSE contexts; component-level tests for "reconnect deferred until settle" and
   "timeout unblocks".
3. **Task 3 — integration checkpoint:** desktop-browser e2e simulating the resume burst
   (shortened token validity; fire visibilitychange with an expired access cookie; assert
   no `/login` navigation, streams reconnect, exactly one `refreshed` log). Real-device
   iOS observation is a post-deploy human step and does not gate task completion.

Tasks 1 and 2 are independent (server vs client); Task 3 depends on both.

## Risks & Mitigations

- **Risk:** lenient middleware lets a genuinely-dead session produce more 401 round-trips
  before redirect (one extra prime+retry). *Mitigation:* this path already exists and is
  bounded (single retry); UX difference is milliseconds on a session that must re-login
  anyway.
- **Risk:** IdP reuse-detection may still revoke the token family if a burst slips through
  the gate (e.g. multiple tabs). *Mitigation:* diagnostics make this visible
  (`failed_idp` after a `refreshed` with `rotated: true`); if logs show it persists,
  follow-up work (e.g. cross-tab BroadcastChannel lock) gets its own idea — explicitly out
  of scope now.
- **Risk:** gating SSE reconnects delays realtime resume by up to the revalidation length
  (typically <1s, worst case 8s timeout). *Mitigation:* acceptable — today those streams
  are what kill the session; a sub-second deferral is strictly better than a bounce.
- **Risk:** deleting the middleware redirect changes behavior for non-iOS flows that
  "relied" on it (e.g. bookmarked page with only stale cookies). *Mitigation:* Server
  Component `redirect("/login")` and the client single redirect site still cover every
  such flow; unit tests pin the new pass-through contract.

## Out of Scope

- Cross-tab refresh locking (BroadcastChannel/Web Locks) — revisit only if diagnostics
  show multi-tab bursts surviving the gate.
- Any change to default-auth (`user_session`) refresh — it is already non-destructive
  (returns `null` on error, page-level handles it).
- localStorage token-copy lifecycle (the "resurrection" behavior) — it is a symptom
  amplifier, not the cause; removing it without the middleware fix would make the bug
  *worse* (no recovery path).
