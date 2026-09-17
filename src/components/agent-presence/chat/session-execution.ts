// Per-conversation execution matching for the chat-style daemon UI (子3 follow-up).
//
// A daemon execution row is reported against the wake's resource: an idea-anchored
// conversation runs as `idea:<directIdeaUuid>`, an ad-hoc conversation as
// `daemon_session:<sessionId>` (the conversation's own business id — the same value
// the daemon uses as its Claude `--resume` anchor). These pure helpers let the chat
// surface (a) show a per-CONVERSATION status indicator (running / interrupted / error)
// instead of a connection-wide "is the agent busy" flag, and (b) scope the footer's
// Interrupt/Resume card to THIS conversation's in-flight work rather than every
// execution on the connection.
//
// Pure + dependency-free so they are trivially unit-testable.

import type { ExecutionView } from "../types";

// The per-conversation display status, derived from its matching live executions.
//   running     → a turn is executing now
//   interrupted → user-interrupted (resumable)
//   error       → crash-interrupted (auto-recovers; shown as an error state)
//   null        → idle (no live execution for this conversation)
export type SessionExecStatus = "running" | "interrupted" | "error" | null;

// Does this execution belong to the given conversation?
//  - Ad-hoc conversation → matches its own `daemon_session:<sessionId>` execution.
//  - Idea-anchored conversation → matches BOTH (a) a direct wake ON the idea
//    (`idea:<directIdeaUuid>`), AND (b) an autonomous wake on a child resource of that
//    idea (e.g. `task_assigned` → `task:<taskUuid>`), matched by the execution's
//    `directIdeaUuid` (the entity's directly-attached idea — the daemon's session anchor).
//    A task/proposal wake IS the conversation's work on that idea, so it must surface the
//    conversation's running/interrupt state.
//
//    We match on `directIdeaUuid`, NOT `rootIdeaUuid`: for a DERIVED (child) idea a
//    child-resource wake resolves `directIdeaUuid = child` (this conversation) but
//    `rootIdeaUuid = parent`. Matching by root would light up the PARENT conversation and
//    leave the child (which actually owns the woken session) idle — the exact bug this
//    fixes. Matching by the direct idea anchors the run on the child only; the parent
//    shows nothing about the child's run.
export function executionMatchesSession(
  exec: Pick<ExecutionView, "entityType" | "entityUuid" | "directIdeaUuid">,
  session: { sessionId: string; directIdeaUuid: string | null },
): boolean {
  // The key this conversation's work is addressed by — the SINGLE derivation shared with
  // the composer's stuck-turn control (see `sessionControlTarget`), so the entity the UI
  // sends and the entity the matcher accepts can never drift.
  const target = sessionControlTarget(session);

  if (target.entityType === "idea") {
    // Direct wake on the idea itself, OR any wake whose DIRECT idea IS this conversation's
    // idea (its child task/proposal/document wakes). Matched strictly by the DIRECT idea,
    // never the root idea.
    return (
      (exec.entityType === "idea" && exec.entityUuid === target.entityUuid) ||
      exec.directIdeaUuid === target.entityUuid
    );
  }
  return (
    exec.entityType === "daemon_session" && exec.entityUuid === target.entityUuid
  );
}

// The control-entity key a conversation's own work is addressed by:
//   idea-anchored → `idea:<directIdeaUuid>`
//   ad-hoc        → `daemon_session:<sessionId>`
//
// This is the ONE place the rule lives. `executionMatchesSession` reads it to decide which
// live execution rows belong to a conversation, and the composer reads it to target an
// interrupt at a conversation whose execution row is MISSING (a phantom `running` turn —
// nothing left to match against, so the control must be derived from the session itself).
// Keeping both on one function is what stops the sent entity and the matched entity from
// drifting apart.
//
// The idea is normally the session's own `directIdeaUuid`; for a LEGACY residual
// per-instance session (fix-daemon-conversation-split-cwd-agent: the old
// `${ideaUuid}::${connectionUuid}` fork, which carried directIdeaUuid = null) we recover it
// from the `::`-prefix — the same split the daemon router uses for notification matching
// (cli/event-router.mjs). This is a UI-only fix-forward heal so a pre-existing residual
// thread regains a working Interrupt; no DaemonSession row is migrated. A genuinely ad-hoc
// session (random sessionId, no `::`, null directIdeaUuid) resolves no idea and keeps its
// `daemon_session:<sessionId>` key.
export function sessionControlTarget(session: {
  sessionId: string;
  directIdeaUuid: string | null;
}): { entityType: "idea" | "daemon_session"; entityUuid: string } {
  const ideaUuid =
    session.directIdeaUuid ??
    (session.sessionId.includes("::") ? session.sessionId.split("::")[0] : null);
  return ideaUuid
    ? { entityType: "idea", entityUuid: ideaUuid }
    : { entityType: "daemon_session", entityUuid: session.sessionId };
}

// The executions (from the conversation's origin connection slice) that belong to it.
export function executionsForSession(
  execs: ExecutionView[],
  session: { sessionId: string; directIdeaUuid: string | null },
): ExecutionView[] {
  return execs.filter((e) => executionMatchesSession(e, session));
}

// Resolve the executions that drive a conversation's composer (its running/interruptible
// state + Interrupt control), hardened so the control reaches the idea's running turn from
// ANY thread (fix-daemon-conversation-split-cwd-agent).
//
// `executionsByConnection` maps connectionUuid → its executions. We PREFER the viewed
// session's own origin-connection slice (so the common case stays scoped and shows only
// this conversation's work). But when the origin slice has NO matching execution — the
// idea's running turn lives on a DIFFERENT connection after a cwd switch (a re-pointed or
// legacy-residual session) or an agent switch (another agent's `(agentUuid, idea)` row) —
// we fall back to searching EVERY slice for this conversation's idea. Because the
// InterruptButton targets each matched execution's own connectionUuid/entityType/entityUuid,
// a cross-connection match still stops the correct subprocess.
export function sessionExecutionsForComposer(
  executionsByConnection: Record<string, ExecutionView[]>,
  session: { sessionId: string; directIdeaUuid: string | null; originConnectionUuid: string },
): ExecutionView[] {
  const ownSlice = executionsByConnection[session.originConnectionUuid] ?? [];
  const matched = executionsForSession(ownSlice, session);
  if (matched.length > 0) return matched;
  const allExecutions = Object.values(executionsByConnection).flat();
  return executionsForSession(allExecutions, session);
}

// Reduce a conversation's matching executions to ONE display status. Running wins over
// interrupted; a user-interrupt is "interrupted" (resumable) while a crash is "error".
export function sessionExecStatus(
  execs: ExecutionView[],
  session: { sessionId: string; directIdeaUuid: string | null },
): SessionExecStatus {
  const matched = executionsForSession(execs, session);
  if (matched.some((e) => e.status === "running")) return "running";
  const interrupted = matched.find((e) => e.status === "interrupted");
  if (interrupted) {
    return interrupted.interruptedReason === "user" ? "interrupted" : "error";
  }
  return null;
}

// The conversation-LIST row's display status, resolved from the SAME cross-connection
// execution set the composer's Interrupt control uses (`sessionExecutionsForComposer`),
// then reduced by `sessionExecStatus`. This is what keeps the list-row running dot and
// the composer's Interrupt button in agreement: previously the row read ONLY the origin
// connection's slice, so after a cwd/agent switch or a session re-point (the running turn
// living on a DIFFERENT connection) the composer could still offer Interrupt while the
// row showed idle. Composing the two helpers means both derive from the exact same matched
// set — with the same origin-preferred, all-slice-fallback rule and the same strict
// direct-idea / session-id match (never the root idea, so it can't borrow another
// conversation's run).
//
// The second filter inside `sessionExecStatus` (via `executionsForSession`) is idempotent
// over an already-matched set, so this is exactly "reduce the composer's matched
// executions to one status" — the match rule and the reduce rule each live in one place.
export function sessionExecStatusForRow(
  executionsByConnection: Record<string, ExecutionView[]>,
  session: { sessionId: string; directIdeaUuid: string | null; originConnectionUuid: string },
): SessionExecStatus {
  const execs = sessionExecutionsForComposer(executionsByConnection, session);
  return sessionExecStatus(execs, session);
}
