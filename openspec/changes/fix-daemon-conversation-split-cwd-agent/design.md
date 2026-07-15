# Technical Design: Fix daemon conversation split on cwd / agent switch

## Overview

Two edits, one guiding principle — **one thread per idea per agent; re-point, never
fork** — plus a UI heal so interrupt reaches the idea's running turn from any thread.

- **Edit A (server):** turn the cross-cwd fork in `createTurnAndResolveTarget` into a
  re-point of the idea's canonical session.
- **Edit B (UI):** widen the composer's controllable-execution derivation to find the
  idea's running execution across all connection slices, and tolerate the legacy
  residual `X::<conn>` key so historical splits regain a working Interrupt.

## Root cause (verified)

| Side | File / line | Session key used |
|---|---|---|
| Server writes USER turn | `notification-turn.ts:729-746` | `X::<originConnUuid>` (directIdeaUuid=null) on a cross-cwd directed wake |
| Daemon writes AI transcript + turn status | `waker.mjs:380`, `turn-reporter.mjs`, `upload-hooks.mjs` | plain `X` (re-derived from lineage) |

The keys disagree only when the resolved origin ≠ the idea's existing session origin —
exactly what "switch cwd" produces (connection identity is `(agent, clientType, host,
cwd)`). Interrupt matching (`session-execution.ts:38-53`) keys purely on the viewed
session's `directIdeaUuid`/`sessionId` and is pre-filtered to that session's
`originConnectionUuid` slice (`daemon-chat.tsx:558-563`), so a running turn on a different
session row or connection is invisible → no Interrupt button.

The agent-switch case is a separate `@@unique([agentUuid, sessionId])` split — `(A,X)` vs
`(B,X)` — which is *intended* (per-agent threads); only the interrupt reach is the gap.

## Architecture

### Edit A — Re-point the canonical session (server)

Replace the fork block at `notification-turn.ts:731-746`. Today:

```ts
if (directed && directIdeaUuid) {
  const existing = await prisma.daemonSession.findFirst({
    where: { companyUuid, agentUuid: ctx.recipientUuid, sessionId: directIdeaUuid },
    select: { originConnectionUuid: true },
  });
  if (existing && existing.originConnectionUuid !== origin.uuid) {
    sessionId = `${directIdeaUuid}::${origin.uuid}`;  // FORK
    sessionDirectIdeaUuid = null;
  }
}
```

New behavior: keep `sessionId = directIdeaUuid`, `sessionDirectIdeaUuid = directIdeaUuid`,
and when the existing canonical session's origin differs from the resolved online origin,
**re-point it** (UPDATE `originConnectionUuid`) before `resolveOrCreateSession`. This
mirrors `repointSessionOriginAndSend` step 5 (`daemon-instruction.service.ts:969-978`) —
the deliberate, companyUuid-scoped reversal of the write-once invariant. Because
`resolveOrCreateSession` does not touch `originConnectionUuid` on an existing row (it is
write-once there — `daemon-session.service.ts:334-339`), the re-point must be an explicit
`prisma.daemonSession.update` on `(uuid, companyUuid)`, guarded by the same
`existing.originConnectionUuid !== origin.uuid` condition.

**Why re-pointing is safe for `--resume`.** The daemon probes the on-disk transcript
per-cwd (`waker.mjs:386`, `isNewSession(sessionId, cwd)`); a session re-pointed to a new
cwd simply starts fresh (`--session-id X`, a cold start) in that cwd rather than failing
`--resume` — the same outcome `repointSessionOriginAndSend` already relies on. The prior
turns remain as Chorus-visible read-only history on the same row.

**Interaction with `assertContinuable`.** `assertContinuable` pins continuation to the
session's current `originConnectionUuid` and refuses to route elsewhere
(`daemon-session.service.ts:1155+`). That guard is unchanged — it protects the
*human-instruction send* path (`sendInstruction`). Edit A operates in the *wake
chokepoint* before any continuation assertion, and the re-point moves the origin to the
connection the wake is actually delivered to, so the invariant "a turn runs where the
origin points" is preserved, not violated.

**Scope guard.** The re-point fires ONLY when `directed && directIdeaUuid` and the
existing canonical origin differs from the resolved online origin — i.e. exactly the
former fork condition. Un-pinned / online-first / offline_pin / none paths are unchanged.

**Which triggers reach the re-point (important — do NOT exclude the headline path).**
The re-point branch is trigger-agnostic: any wake that resolves to `directed &&
directIdeaUuid` reaches it, and that set INCLUDES the two triggers this bug is chiefly
about — a directed cross-cwd `human_instruction` (the user typed an instruction after
switching cwd) and a pinned cross-cwd `mentioned`. These MUST re-point, not be excluded;
excluding them would leave the primary reported defect unfixed. The exclusion of
`mentioned` / `human_instruction` in `IDEA_SESSION_ORIGIN_UPGRADE_TRIGGERS`
(`notification-turn.ts:167-185`) is a DIFFERENT, earlier step — the step-4 upgrade of an
*online-first* selection to the idea's existing session origin — and does not govern the
step-5 fork/re-point at all. Concretely: `resolvePinnedTarget` returns a HARD pin for
`mentioned` (`notification-turn.ts:326-329`), and the `human_instruction` send path
resolves its own directed target; both then flow through the same step-5 key derivation,
so removing the fork there is what makes their turns land on the idea's one canonical
session.

### Edit B — Harden interrupt matching (UI)

Two sub-changes, both in the chat surface, no server change:

1. **Search across all connection slices for the composer's controllable execution.**
   `daemon-chat.tsx:558-563` currently narrows to
   `executionsByConnection[session.originConnectionUuid]` before matching. Add a
   fallback: when the origin-connection slice yields no matching execution for the idea,
   search across ALL slices in `executionsByConnection` for the idea's running/interrupted
   execution (`exec.entityType === "idea" && exec.entityUuid === ideaUuid`, OR
   `exec.directIdeaUuid === ideaUuid`). The InterruptButton already targets
   `exec.connectionUuid` + `exec.entityType` + `exec.entityUuid`
   (`execution-row.tsx:80-89`), so a cross-connection / cross-agent-row match interrupts
   the correct running child with no server change.

2. **Tolerate the legacy residual `X::<conn>` key.** In `executionMatchesSession`
   (`session-execution.ts:38-53`), when a session has `directIdeaUuid === null` but its
   `sessionId` contains `::`, derive the idea prefix (`sessionId.split("::")[0]`) and
   match executions on that idea — the same `::`-split the daemon router already uses for
   notification matching (`event-router.mjs:444-445`). This heals interrupt on
   pre-existing residual rows (fix-forward, no migration).

The idea uuid the UI matches on is the viewed session's `directIdeaUuid` when present,
else the `::`-prefix of its `sessionId`. Keep the ad-hoc branch
(`daemon_session:<sessionId>`) unchanged for genuinely ad-hoc sessions (no `::`, no idea).

## Module Contracts

- **Re-point signal (Edit A → session row):** after the wake chokepoint, the idea's
  canonical `DaemonSession` row satisfies `sessionId === directIdeaUuid` AND
  `originConnectionUuid === <resolved online origin>`. No `X::conn` row is ever created by
  the wake path. `directIdeaUuid` stays non-null.
- **Interrupt match key (Edit B):** the idea uuid = `session.directIdeaUuid ??
  session.sessionId.split("::")[0]` (only when `sessionId` contains `::`); an execution
  matches iff `exec.entityType === "idea" && exec.entityUuid === ideaUuid` OR
  `exec.directIdeaUuid === ideaUuid`. The interrupt POST fields come verbatim from the
  matched `exec` (`connectionUuid`, `entityType`, `entityUuid`).

## Risks & Mitigations

- **R1 — Re-point races a live origin.** If the idea's canonical session origin is
  *currently online and running* a turn while a directed wake resolves to a different
  online origin, re-pointing would move the origin out from under a live run. Mitigation:
  the former fork condition already only triggers on a *directed* wake to a *different*
  resolved origin; scope the re-point to when the existing origin is NOT the resolved one
  and rely on the wake being the authoritative new target. If the existing origin is live,
  prefer NOT re-pointing away from it unless the resolved target is the delivery origin
  for this turn (document the chosen rule in code + AC). Verify with a test where the old
  origin is online.
- **R2 — Widened interrupt match interrupts the wrong idea.** Mitigation: match strictly
  on the idea uuid (entity idea OR directIdeaUuid), never on root idea; unit-test that a
  sibling idea's running execution is NOT matched.
- **R3 — `::`-split misfires on a genuinely ad-hoc session.** Ad-hoc sessions use a random
  UUID with no `::`; guard the split on `sessionId.includes("::")` AND
  `directIdeaUuid === null` so only legacy residuals take the branch.
- **R4 — Spec reversal drift.** The `daemon-cwd-instance-addressing` "per-instance session"
  requirement + its scenario are MODIFIED (whole-block overwrite). Ensure the delta
  restates the full requirement, not a patch.

## Implementation Plan

1. Edit A: server re-point + unit tests (`notification-turn` re-point branch, including
   the R1 live-origin case).
2. Edit B: UI interrupt hardening + unit tests (`session-execution` `::` tolerance;
   cross-slice composer execution) .
3. Integration checkpoint: drive cwd-switch and agent-switch end-to-end against a live
   local daemon; confirm one thread + working interrupt; confirm a legacy residual heals.
