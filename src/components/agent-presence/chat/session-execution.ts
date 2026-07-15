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
  // The idea this conversation is anchored on. Normally the session's own directIdeaUuid;
  // for a LEGACY residual per-instance session (fix-daemon-conversation-split-cwd-agent:
  // the old `${ideaUuid}::${connectionUuid}` fork, which carried directIdeaUuid = null) we
  // recover the idea from the `::`-prefix — the same split the daemon router uses for
  // notification matching (cli/event-router.mjs). This is a UI-only fix-forward heal so a
  // pre-existing residual thread regains a working Interrupt; no DaemonSession row is
  // migrated. A genuinely ad-hoc session (random sessionId, no `::`, null directIdeaUuid)
  // has ideaUuid = null and keeps its unchanged daemon_session:<sessionId> match below.
  const ideaUuid =
    session.directIdeaUuid ??
    (session.sessionId.includes("::") ? session.sessionId.split("::")[0] : null);

  if (ideaUuid) {
    // Direct wake on the idea itself, OR any wake whose DIRECT idea IS this conversation's
    // idea (its child task/proposal/document wakes). Matched strictly by the DIRECT idea,
    // never the root idea.
    return (
      (exec.entityType === "idea" && exec.entityUuid === ideaUuid) ||
      exec.directIdeaUuid === ideaUuid
    );
  }
  return (
    exec.entityType === "daemon_session" && exec.entityUuid === session.sessionId
  );
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
