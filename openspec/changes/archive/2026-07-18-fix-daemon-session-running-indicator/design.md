# Design — Fix daemon session running indicator / Interrupt disagreement

## Context

Two independent, small fixes for one reported symptom ("online session I'm
talking to shows no running indicator and no Interrupt button"). They touch
disjoint layers (React client vs. daemon Node CLI) and share no state, so they
are two independent tasks with no ordering dependency.

The root-cause trace and file:line evidence are recorded on the source idea
(044692e0). Prior art:

- PR #428 — threaded `directIdeaUuid` end-to-end so a child-idea wake lights the
  correct chat (the precedent P1 hardens).
- PR #429 — introduced the composer's cross-connection Interrupt fallback
  (`sessionExecutionsForComposer`); the list dot was **not** given the same
  fallback — that gap is P0.

## P0 — Conversation-list status uses the composer's cross-connection match

### Current behavior

`daemon-chat.tsx` builds each list row's `status` from:

```ts
status: sessionExecStatus(
  executionsByConnection[session.originConnectionUuid] ?? [],
  session,
),
```

i.e. only the origin connection's execution slice. The composer, by contrast,
uses:

```ts
const sessionExecutions = sessionExecutionsForComposer(executionsByConnection, s);
```

`sessionExecutionsForComposer` (in `session-execution.ts`) prefers the origin
slice but falls back to searching **all** connection slices for this
conversation's executions when the origin slice yields nothing. After a
cwd/agent switch or a session re-point, the running turn lives on a *different*
connection, so the composer finds it but the row does not → the dot reads idle
while Interrupt works.

### Change

Add a pure helper that derives the row's display status from the SAME
cross-connection execution set the composer resolves, then reduces it with the
existing `sessionExecStatus` logic:

```ts
// session-execution.ts
export function sessionExecStatusForRow(
  executionsByConnection: Record<string, ExecutionView[]>,
  session: { sessionId: string; directIdeaUuid: string | null; originConnectionUuid: string },
): SessionExecStatus {
  const execs = sessionExecutionsForComposer(executionsByConnection, session);
  // sessionExecStatus re-filters by executionMatchesSession; passing the already-
  // matched composer set is safe (idempotent) and keeps the reduce rule in one place.
  return sessionExecStatus(execs, session);
}
```

Call site in `daemon-chat.tsx` becomes:

```ts
status: sessionExecStatusForRow(executionsByConnection, session),
```

`ConversationRow.session` (a `SessionTarget`) already carries
`originConnectionUuid`, `directIdeaUuid`, and `sessionId`, so no new data needs
threading into the row map.

### Why the reduce stays correct

`sessionExecStatus` internally calls `executionsForSession` again, which filters
by `executionMatchesSession`. `sessionExecutionsForComposer` returns executions
already matched to this conversation, so the second filter is a no-op pass-through
— the composed helper is equivalent to "reduce the composer's matched set to one
status", with the match rule and the reduce rule each defined exactly once. No
behavior change for the common case (origin slice has the match); the only
observable change is the re-pointed / agent-switched case now lighting the dot,
which is the whole point.

### Cross-borrowing safety

The fallback matches strictly by this conversation's own idea
(`directIdeaUuid`, or the `::`-prefix heal) or its `daemon_session:<sessionId>`.
A different conversation's execution on another connection cannot satisfy that
predicate, so the row cannot show another conversation's run. This is the same
guarantee the composer already relies on.

### Tests

`session-execution` currently has no `__tests__`; add one covering
`sessionExecStatusForRow`:

- origin slice has a `running` exec → `"running"` (parity with old behavior);
- origin slice empty but ANOTHER connection slice has this idea's `running` exec
  → `"running"` (the fix; old `sessionExecStatus(origin-only)` returned `null`);
- an unrelated idea's exec on another slice → `null` (no cross-borrow);
- user-interrupted on the fallback slice → `"interrupted"`; crash → `"error"`.

## P1 — Visible warning on null directIdeaUuid with non-null root

### Current behavior

`cli/lineage.mjs#resolveViaServer` logs one `info` line on success:

```
[Chorus] lineage: <type>:<uuid> → root <root|none>, direct <direct|none> (<resolvedVia>)
```

Both "legitimately no idea ancestor" (`root=none, direct=none`) and the anomalous
"has a root but no direct idea" (`root=<uuid>, direct=none`) render as ordinary
`info`. The second is the fingerprint of a lineage gap (most often a server
predating the `directIdeaUuid` field on the root-idea endpoint) that permanently
breaks child-wake → idea-conversation matching, but there is no distinct signal.

### Change

Keep the existing success `info` line. Add, immediately before it, a `warn` that
fires **only** when `root` is non-null AND `direct` is null:

```js
if (root !== null && direct === null) {
  this.logger.warn(
    `[Chorus] lineage: ${entityType}:${entityUuid} resolved a root idea (${root}) but NO ` +
    `directIdeaUuid — this wake will anchor on the entity, not the idea conversation, so its ` +
    `run will not show a running indicator / Interrupt on the idea chat. Most likely the Chorus ` +
    `server predates the directIdeaUuid field on /root-idea; upgrade the server to restore ` +
    `child-wake → idea-conversation matching.`
  );
}
```

Placement is after the existing non-string `directIdeaUuid` warn (so a malformed
value is still reported on its own) and before the success `info`. No control
flow changes — resolution still returns `{ rootIdeaUuid: root, directIdeaUuid:
direct }` exactly as before. This is **diagnostic only**: no client-side
root-idea fallback is introduced (owner's explicit "guard + log, not fallback"
choice), so the daemon's behavior when `direct` is null is unchanged — it just
becomes visible.

### Why warn, not fix-forward

A client-side fallback (anchoring on `rootIdeaUuid` when `direct` is null) was
explicitly declined: for a *derived child* idea, root ≠ direct, so falling back
to root would light the PARENT conversation and leave the child (the one that
actually owns the woken session) idle — re-introducing the very bug PR #428
fixed. The correct fix is server-side (return `directIdeaUuid`), and the warning
points the operator straight at it.

### Tests

`cli/__tests__/lineage.test.mjs` uses an injectable `fetchImpl` + a capturing
logger. Add cases:

- server returns `{ rootIdeaUuid: "root-x", directIdeaUuid: null }` → resolves
  `{ rootIdeaUuid: "root-x", directIdeaUuid: null }` AND the logger recorded a
  `warn` mentioning the entity and `directIdeaUuid`;
- server returns both null (`root=null, direct=null`) → NO warn (normal
  no-ancestor case), still an `info`;
- server returns both present → NO warn.

## Risks & alternatives

- **Risk:** the composed P0 helper double-filters. Mitigated — the second filter
  is idempotent over an already-matched set; a unit test pins the equivalence.
- **Alternative considered (P0):** inline the fallback at the row call site
  instead of a named helper. Rejected — a named, tested helper keeps the row and
  the composer provably in sync and documents the intent.
- **Alternative considered (P1):** raise to `error`. Rejected — the daemon still
  functions (it just anchors sub-optimally); `warn` is the right severity for a
  degraded-but-not-broken, operator-actionable condition, consistent with the
  file's other `warn`s.
