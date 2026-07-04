# Fix: iOS resume bounces users to /login (middleware refresh failure is destructive)

## Why

On iOS mobile Safari, a Chorus tab that sits backgrounded long enough for the access token
to expire gets bounced to `/login` when the user returns — with no token refresh apparently
attempted. The contradiction that exposes the real bug: after landing on `/login`, manually
editing the path back to `/projects/...` shows a fully logged-in session. The credentials
were never dead; the session was killed by the app itself.

This has survived several fix rounds (`21e81e0`, `662174c`, `a66a8ab`, PR #369). All of
those hardened the **client probe** side (prime-before-probe, retry-once-on-401, never
redirect on transient errors, coalesce resume signals). The remaining unhardened surface is
the **Edge middleware OIDC refresh path** (`src/middleware.ts`), and the elaboration
confirmed the production environment matches the failure preconditions (Cognito with
refresh-token rotation).

Root-cause analysis (confirmed against code, elaboration Round 1 answers, and the
user-observed "path edit restores the session" behavior):

1. **Concurrent refresh × refresh-token rotation race.** When iOS restores the tab, four
   to five middleware-covered requests fire nearly simultaneously: the auth-context resume
   revalidation's prime (`/api/keepalive`), the frozen keepalive `setTimeout` firing on
   thaw (`/api/keepalive` again), and up to three SSE reconnects (`/api/events`,
   `/api/events/notifications`) from the notification / realtime / agent-presence contexts —
   each of which reconnects on `visibilitychange` independently. Every one of those requests
   carries the SAME expired `oidc_access_token` and the SAME `oidc_refresh_token` cookie
   (no winner's `Set-Cookie` has landed yet), so each middleware invocation independently
   calls the IdP token endpoint. With rotation enabled, only the first succeeds; every
   loser gets `invalid_grant` → `clearAuthAndRedirect()` — which **expires all six auth
   cookies and 307-redirects to /login**, clobbering the winner's freshly rotated cookies.
2. **Transient network error treated as session death.** The `catch` around the refresh
   fetch (`src/middleware.ts:296-299`) also calls `clearAuthAndRedirect()`. iOS frequently
   resumes a tab before the network stack is ready, so a single failed fetch to the IdP
   kills the session.
3. **Why the path edit "restores" the session:** `oidc-client-ts` keeps a token copy in
   localStorage; on the next full page load, auth-context init finds it and re-creates the
   cookies via `POST /api/auth/sync-token`. This resurrection proves the cookies were
   wrongly cleared, not genuinely expired.

## What Changes

Two capability deltas, matching elaboration decisions (Q3=c agent decides tolerance, Q4=a
lenient failure, Q5=a structured diagnostics, Q7=a include SSE resume-timing governance):

- **`oidc-session-refresh` (MODIFIED + ADDED):** The middleware refresh path becomes
  **non-destructive**. A failed refresh (network error, discovery failure, IdP non-OK
  including `invalid_grant`, malformed response) SHALL pass the request through unchanged —
  no cookie clearing, no redirect. Session death is decided exclusively by the existing
  client-side single redirect site (post-prime double-401 in `fetchSession`). Rationale:
  with rotation enabled the middleware **cannot distinguish** "I lost a concurrent-refresh
  race" from "the refresh token is genuinely revoked" — but the client probe can, because
  by the time it retries, the winner's cookie has landed. `clearAuthAndRedirect` and its
  redirect+clear behavior are removed from the refresh path entirely. Additionally, every
  refresh attempt SHALL emit a structured diagnostic log line (trigger path, outcome,
  failure class, token-expiry delta, timing) so the root cause is verifiable on a real
  device rather than inferred.
- **`sse-resume-timing` (new capability, ADDED):** Resume-time client request ordering.
  The three SSE contexts (notification / realtime / agent-presence) SHALL defer their
  entire `visibilitychange→visible` handler work — the EventSource reconnect AND the
  accompanying fetches (`fetchUnreadCount`, `fetchExecutions`, the realtime catch-up
  notify fan-out) — until the auth-context resume revalidation (prime + session probe)
  settles, via a shared resume-gate. This reduces the concurrent-refresh burst from ~5
  simultaneous refresh attempts to 1 (the prime), making the race structurally rare
  instead of merely survivable.

## Capabilities

- `oidc-session-refresh` — modified: lenient middleware refresh failure + structured
  refresh diagnostics; the "redirect only on true post-middleware 401" requirement is
  strengthened to make the middleware never-redirecting.
- `sse-resume-timing` — added: resume-gate ordering contract for SSE reconnects after tab
  restore.

## Impact

- `src/middleware.ts` — refresh failure paths stop clearing cookies / redirecting; add
  structured diagnostics; `clearAuthAndRedirect` removed (or reduced to the
  missing-materials pass-through).
- `src/contexts/auth-context.tsx` — exposes the resume-revalidation settle signal (resume
  gate) consumed by SSE contexts.
- `src/contexts/notification-context.tsx`, `src/contexts/realtime-context.tsx`,
  `src/contexts/agent-presence-context.tsx` — gate their `visibilitychange` reconnects on
  the resume gate.
- `src/__tests__/middleware-oidc-refresh.test.ts` — existing redirect-on-failure
  assertions inverted to pass-through assertions; new cases for each failure class.
- No schema/DB changes. No REST/MCP surface changes. Diagnostics are server-console
  structured logs (pino), not DB/Activity records.

## Acceptance (from elaboration Q6=a)

- Unit tests cover every middleware refresh failure branch (network error, discovery
  failure, IdP non-OK, missing access_token, missing materials) asserting pass-through
  and no cookie mutation.
- Desktop-browser simulation with shortened token validity exercising concurrent resume
  requests.
- Owner observes an iOS real device for several days post-deploy; structured logs confirm
  (or refute) the race hypothesis in production.
