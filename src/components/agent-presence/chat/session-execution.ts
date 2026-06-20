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
//    idea (e.g. `task_assigned` → `task:<taskUuid>` with `rootIdeaUuid === directIdeaUuid`).
//    A task wake IS the conversation's work on that idea, so it must surface the
//    conversation's running/interrupt state — matching by `rootIdeaUuid` catches it
//    (the prior `entityType === "idea"`-only predicate showed such a conversation idle).
export function executionMatchesSession(
  exec: Pick<ExecutionView, "entityType" | "entityUuid" | "rootIdeaUuid">,
  session: { sessionId: string; directIdeaUuid: string | null },
): boolean {
  if (session.directIdeaUuid) {
    // Direct wake on the idea itself, OR any wake whose root idea IS this conversation's
    // idea (its child task/proposal/document wakes).
    return (
      (exec.entityType === "idea" && exec.entityUuid === session.directIdeaUuid) ||
      exec.rootIdeaUuid === session.directIdeaUuid
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
