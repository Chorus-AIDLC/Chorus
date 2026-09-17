# Design — converge phantom `running` turns

## Problem shape

A turn is `running` in the database while nothing is running on the daemon. Three
independent gaps let that state persist, and one more makes the daemon mis-detect exit:

| # | Gap | Consequence |
|---|---|---|
| A | terminal turn-advance has no retry | one lost report ⇒ turn `running` forever |
| B | `reconcileOrphanTurns` needs a stale connection (90s) | a live daemon's orphan is never collected |
| C | interrupt control renders off an execution row, not the turn | no control at all for a phantom turn |
| D | no-child interrupt is a local `logger.info` + `return` | the human's explicit request converges nothing |
| E | spawners resolve on `close` | a detached grandchild holding stdio keeps a finished wake "running" |

We fix A, C, D, E. B is left alone deliberately: widening the age-only rule risks
finalizing genuinely live turns (the rule's own comment explains why it is age-only), and
C+D give the human a deterministic manual path, which is what the requester asked for.

## A — bounded retry on the terminal turn-advance edge

`cli/daemon-rest-client.mjs`'s internal `post()` gains an optional retry policy; nothing
else about it changes (same structured `DaemonRestResult`, same no-silent-errors logging,
same "never throws").

```js
// post(op, path, body, successLog, context, readData, retry)
// retry = { attempts: number, delaysMs: number[], sleep?: (ms) => Promise<void> } | null
// (an explicit delay list, not a base × factor — the schedule is two fixed values)
```

Policy:

- **Who retries:** only `turnAdvance` when `status` is `ended` or `interrupted`. The
  `running` edge is not retried — the wake is about to run anyway and a stale retry could
  race the terminal edge. `transcript`, `executionState`, `reportInterrupt`, `heartbeat`
  keep today's single-shot behaviour.
- **What is retryable:** a network-level failure (no response, `status === null`), `429`,
  and any `5xx`. A `4xx` is a server verdict (`invalid_transition`, `not_found`, auth) — it
  will not become true by repeating, so it returns immediately.
- **Budget:** 3 attempts total, delays `500ms` then `2000ms`. Fixed constants, not
  configurable — one more knob buys nothing here.
- **Logging:** a failed attempt logs at `warn` with its attempt ordinal — but only when
  another attempt actually follows, since the ordinal exists to explain a retry. So the log
  reads `turn-advance request failed (attempt 1/3): …` for the attempts that retry, and the
  last failure is logged once, in today's exact wording, so existing log-grep expectations
  still match and no near-duplicate pair is emitted.
- **Injectable `sleep`** so tests do not spend real seconds.

**Why the retry is safe (no double side effects).** The daemon passes the `turnUuid` it
learned from its own `→ running` report on the terminal edge. `advanceTurnForWake` already
handles a correlated repeat: when `turnUuid` is given, the status is terminal, and the row
is *already* in that status, it returns the existing projection **without** calling
`advanceTurn` — so usage rollups, timestamps and SSE publishes happen exactly once. When
`turnUuid` is absent, the FIFO resolution looks for a `running` turn; a successful-but-lost
first attempt leaves no `running` turn, so the retry resolves `not_found` and changes
nothing. Retry is idempotent by construction in both paths.

## D — a no-child interrupt reports the truth

`cli/control-handler.mjs` gains one injected dependency, `advanceTurn` (the same
`createTurnReporter` function the waker already uses — the daemon wires the identical
instance in `cli/daemon.mjs`; no second transport, no new endpoint).

The `interrupt` branch's Check-2 changes from "log and return" to "log, report, return":

```js
const entry = waker?.executions?.get(key);
if (!entry || entry.status !== "running" || !entry.child) {
  logger.info(`[Chorus] control: no running subprocess for ${key} on this daemon; ` +
              `reporting the turn as interrupted(user)`);
  advanceTurn?.({
    sessionId: <session business key>,
    status: "interrupted",
    interruptedReason: "user",
    entityType, entityUuid,
  });
  return;
}
```

`sessionId` (the session business key) is derived exactly as the daemon derives it
everywhere else, and only for the two entity types where the derivation is an identity:
`idea` (the session anchor **is** the direct idea uuid) and `daemon_session` (the session's
own business id). For both, `sessionId = entityUuid`, so no lookup is needed.

`CONTROL_ENTITY_TYPES` (`src/services/daemon-control.service.ts`) also admits `task`,
`proposal` and `document`. Those keep the old pure-log behaviour on purpose: a
task/proposal/document wake's session is anchored on that resource's *direct idea*, which
the daemon cannot resolve without a REST round trip (`/api/entities/{type}/{uuid}/root-idea`
is a different question — the ROOT idea, not the direct one). Guessing `sessionId =
entityUuid` there would address a session that does not exist, or worse, collide with an
unrelated one. Those types are also not reachable from the composer's zombie path (change
C2 only ever emits `idea` / `daemon_session`), so the gap is not user-visible; a live
child for them still kills normally through the unchanged path above.

Fire-and-forget, exactly like the waker's use: `createTurnReporter` never throws and logs
its own failures, and the handler must stay synchronous and non-throwing for the SSE loop.
If no turn is `running` server-side, `advanceTurnForWake` answers `not_found` and nothing
happens — a harmless no-op, already the established shape for a losing race.

`interruptedReason: "user"` is the requester's decision (elaboration round 1): the human
did press interrupt, and reusing `user` needs zero schema/enum/i18n change. `crash` was
rejected because crash carries sticky, resumable execution-row semantics.

## C — a `running` turn always offers an interrupt control

### C1. `InterruptButton` takes a target, not an `ExecutionView`

The button only ever reads four fields (`connectionUuid`, `entityType`, `entityUuid`,
`entityTitle`). Its prop type narrows to that shape:

```ts
export type InterruptTarget = {
  connectionUuid: string;
  entityType: string;
  entityUuid: string;
  entityTitle?: string | null;
};
export function InterruptButton({ target }: { target: InterruptTarget })
```

`ExecutionView` structurally satisfies `InterruptTarget`, so every existing call site
passes its `exec` through unchanged. No fabricated execution row is introduced anywhere —
that was rejected as a source of downstream lies (a fake row would leak into status
rollups and the elapsed-time header).

### C2. The composer derives the control from the turn as well as the execution

`transcript-view.tsx` already has both `turns` and `composerExecution`. It computes a
fallback target used **only** when a `running` turn exists and no execution matched:

```ts
const hasRunningTurn = turns.some((t) => t.status === "running");
const zombieTarget =
  !composerExecution && hasRunningTurn && session
    ? {
        connectionUuid: session.originConnectionUuid,
        entityType: session.directIdeaUuid ? "idea" : "daemon_session",
        entityUuid: session.directIdeaUuid ?? session.sessionId,
        entityTitle: title,          // the pane's existing `title` prop
      }
    : null;
```

The entity derivation mirrors `executionMatchesSession` in
`chat/session-execution.ts` — idea-anchored conversations address `idea:<directIdeaUuid>`,
ad-hoc ones `daemon_session:<sessionId>` — so the target the UI sends is the same key the
daemon registers. Legacy `::`-suffixed residual sessions reuse the same
`sessionId.split("::")[0]` recovery that helper already performs; the derivation is
extracted into one exported pure function so the two cannot drift.

`send-instruction-box.tsx` renders the control when either an execution or a zombie target
is present. The control already lives in the action group and is **not** gated by the
composer's `disabled` (origin-offline) flag, so no gating change is needed — the zombie
button is reachable exactly when it is most needed.

Two copy changes keep the surface honest:

- The zombie variant is visually the same button but with its own confirm copy ("clear a
  stuck turn"), so a human is not told the daemon was asked to kill something that is
  demonstrably already gone.
- The origin-offline banner currently reads as a flat "read-only, the daemon is offline".
  When a zombie target is present that is misleading — one action *is* available. With a
  zombie target the banner gains a clause saying the stuck turn can still be cleared here.
  Without one, the banner is unchanged.

### C3. The server settles the turn when the origin daemon is not online

`POST /api/daemon/control` keeps publishing the control event unconditionally (unchanged
authz, unchanged 404 non-disclosure). After dispatch, for `command === "interrupt"` only, it
additionally settles the turn when the server has its **own** evidence that no live
subprocess can act on the command:

```ts
const noLiveRun =
  !(await isConnectionLive(auth.companyUuid, targetConnectionUuid)) ||
  !(await hasRunningExecution(auth.companyUuid, targetConnectionUuid, body.entityType, body.entityUuid));

if (body.command === "interrupt" && noLiveRun) {
  await advanceTurnForWake({
    companyUuid: auth.companyUuid,
    agentUuid: target.agentUuid,
    connectionUuid: targetConnectionUuid,
    sessionId: body.entityUuid,       // = the session business key for both entity types
    status: "interrupted",
    interruptedReason: "user",
    entityType: body.entityType,
    entityUuid: body.entityUuid,
  });
}
```

**Why two conditions, not just offline.** Gating on offline alone leaves a real hole: a
*zombie SSE* — the reverse channel silently dead while the REST heartbeat keeps
`lastSeenAt` fresh — reads as online, so the control event is published into a channel
nobody is listening on and nothing ever converges. (An SSE that *aborts* is not the problem:
`markDisconnected` flips `status` to `offline` immediately, so the first condition already
covers it.) The second condition is the direct evidence: the daemon uploads its **full**
execution snapshot on *every* lifecycle transition, captured synchronously at emit time
(`cli/upload-hooks.mjs` `onExecutionChange`), so "this connection reports no `running`
execution for this entity" is timely server-side fact, not a client assertion.

**Why a stale second condition is still safe.** The only false-positive path is a lost
`running` execution-state upload while a subprocess really is running. In that case the
connection is online, so the control event *is* delivered, the daemon kills the real child,
and its exit reports `interrupted(user)` — the same terminal state the server just wrote,
absorbed by `advanceTurnForWake`'s idempotent terminal short-circuit. The human asked for an
interrupt; both paths land on interrupted. There is no input for which the server settles a
turn the human did not ask to stop.

**Entity types.** As in change D, `sessionId = body.entityUuid` is an identity only for
`idea` and `daemon_session`. The route does not need a type guard for correctness — a
`task` / `proposal` / `document` entity resolves no session and `advanceTurnForWake` answers
`not_found`, changing nothing — but the route MUST carry an inline comment saying so, so a
future reader does not mistake the identity for a general rule.

**Why we still do not settle unconditionally.** With a live execution row on an online
connection, the daemon is the authority and its SIGINT escalation window is up to 10s;
writing the terminal state first would tell the UI "interrupted" while the child is still
winding down. The two-condition gate keeps the live path exactly as it is today.

The online predicate is the **already exported** `isConnectionLive(companyUuid,
connectionUuid)` in `src/services/daemon-execution.service.ts` (`status === "online"` AND
`lastSeenAt` within `STALE_THRESHOLD_MS`, company-scoped) — reused as-is, no new predicate.
The execution-evidence predicate is one new thin export beside it,
`hasRunningExecution(companyUuid, connectionUuid, entityType, entityUuid)`, a company-scoped
existence query for a `running` row on that connection + entity; it introduces no new rule,
only a narrower read of the table `reconcileSnapshot` already maintains. The settle runs
through
`advanceTurnForWake`, so legality checking, the `interrupted(user)` write and the SSE
publish all come free, and a turn that is not `running` yields `not_found` and no change.
The response body gains `settled: boolean` so the client can tell "asked the daemon" from
"cleared it here", and the failure of a settle never fails the dispatch (it is reported in
the body, and logged).

## E — spawners become exit-authoritative

New shared module `cli/child-exit.mjs`:

```js
/**
 * Resolve once with the child's exit code as soon as the process is KNOWN to be gone.
 *  • `close` first  → resolve immediately (today's behaviour, no regression).
 *  • `exit` first   → wait up to `stdioGraceMs` for `close` (so a last stdout chunk is
 *                     still parsed), then resolve with the exit code anyway.
 * Never rejects. The grace timer is `unref`'d so it cannot hold the daemon's event loop.
 */
export function awaitChildSettled(child, { stdioGraceMs = 2000, logger, label } = {})
```

When the grace expires with `close` still pending, it logs once at `warn`
(`[Chorus] <label> exited (code N) but stdio stayed open for 2000ms; settling on exit`) —
that line is the diagnostic that a detached descendant inherited the pipes, which is
exactly the condition we were previously blind to.

Each of the five spawners replaces

```js
child.on("close", (code) => { …spawner-specific post-exit logic… });
```

with

```js
awaitChildSettled(child, { logger: this.logger, label: "pi" }).then((code) => { …same body… });
```

The per-spawner bodies (claude's `SESSION_CONFLICT_FAILURE` classification, kiro's session
snapshot diff, codex's thread id, dsh's fail path) are untouched — only the trigger
changes. The existing `child.on("error", …)` handlers stay; the outer promise resolves once,
first-wins, as today.

`stdioGraceMs = 2000` is not a wake timeout and does not bound how long an agent may run —
it bounds only how long we wait for a **already-exited** process's pipes to drain. That
distinction is why it does not violate the "no timeouts" decision.

## Testing

Unit (vitest, existing mock style; no real processes, no real network):

- `daemon-rest-client`: terminal edge retries on network error / 429 / 503 and succeeds on
  attempt 2; does **not** retry on 400/404/401; `running` edge never retries; attempt count
  is capped at 3; the injected `sleep` receives 500 then 2000.
- `control-handler`: no-child interrupt calls `advanceTurn` with
  `{status:"interrupted", interruptedReason:"user", sessionId: entityUuid}`; a live child
  still kills and does **not** report (the waker does); a non-`idea`/`daemon_session`
  entity type reports nothing; a throwing/rejecting `advanceTurn` cannot escape.
- `child-exit`: resolves on `close`-first; resolves after the grace on `exit`-first with
  `close` never arriving; resolves once when both fire; logs the grace warning exactly once.
- Zombie-target derivation: idea-anchored, ad-hoc, and legacy `::` sessions each derive the
  expected `entityType`/`entityUuid`; no target when an execution matched; no target when
  no turn is `running`.
- `POST /api/daemon/control`: offline connection ⇒ `advanceTurnForWake` called with
  `interrupted`/`user` and `settled: true`; online connection **with** a `running` execution
  row ⇒ not called and `settled: false`; online connection with **no** `running` execution
  row (the zombie-SSE case) ⇒ called and `settled: true`; no `running` turn ⇒ success with
  `settled: false`; a `resume` command never settles, online or offline; authz behaviour
  unchanged.

Component (existing `send-instruction-box` / `transcript-view` test style): a running turn
with no matching execution renders the interrupt control; an idle conversation renders none;
the offline banner gains its "can still be cleared" clause only when a zombie target exists.

Integration (the human-gated task): with a real local server + daemon, cover each of the
four changes end to end — a dropped terminal report recovering on retry, an interrupt with
no child converging the turn, a zombie turn cleared from the UI in both themes, and a wake
whose child leaves a backgrounded descendant still settling on exit.

## Risks

| Risk | Mitigation |
|---|---|
| Retry double-settles a turn | Idempotent by construction — see A. Terminal-status repeat with a `turnUuid` short-circuits; without one, FIFO finds no `running` turn. |
| Server settle races a live daemon | Gated on "offline **or** no `running` execution row"; with a live row on an online connection the daemon keeps sole authority (change D covers that window). A stale-evidence false positive still lands on `interrupted` — the state the human asked for — absorbed by `advanceTurnForWake`'s idempotent terminal short-circuit. |
| Zombie SSE (channel silently dead, heartbeat fresh) | Covered by the execution-evidence half of the gate; an *aborted* SSE is already covered by the offline half (`markDisconnected` flips status immediately). |
| `exit`-first settle truncates trailing transcript | 2s stdio grace, and the waker's existing `onSessionEnd` flush already awaits the transcript hook before the terminal advance. |
| A human clears a turn whose daemon is merely mid-reconnect | The connection must be offline *by the same predicate the read gate uses*; the action is explicit, human-initiated, and the turn is resumable afterwards (`interrupted(user)` → Resume). |
