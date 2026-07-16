// Unit tests for the per-conversation execution matching helpers (子3 follow-up).
import { describe, expect, it } from "vitest";
import {
  executionMatchesSession,
  executionsForSession,
  sessionExecStatus,
  sessionExecutionsForComposer,
} from "../chat/session-execution";
import type { ExecutionView } from "../types";

function exec(over: Partial<ExecutionView> = {}): ExecutionView {
  return {
    uuid: "e1",
    agentUuid: "a1",
    connectionUuid: "c1",
    entityType: "daemon_session",
    entityUuid: "sid-1",
    rootIdeaUuid: null,
    directIdeaUuid: null,
    status: "running",
    interruptedReason: null,
    startedAt: null,
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    entityTitle: null,
    projectUuid: null,
    rootIdeaTitle: null,
    ...over,
  };
}

const adHoc = { sessionId: "sid-1", directIdeaUuid: null };
const ideaSession = { sessionId: "idea-9", directIdeaUuid: "idea-9" };

describe("executionMatchesSession", () => {
  it("matches an ad-hoc conversation by daemon_session:<sessionId>", () => {
    expect(executionMatchesSession(exec({ entityType: "daemon_session", entityUuid: "sid-1" }), adHoc)).toBe(true);
    expect(executionMatchesSession(exec({ entityType: "daemon_session", entityUuid: "sid-2" }), adHoc)).toBe(false);
    // A task execution never matches an ad-hoc conversation (the old, dropped shape).
    expect(executionMatchesSession(exec({ entityType: "task", entityUuid: "sid-1" }), adHoc)).toBe(false);
  });

  it("matches an idea-anchored conversation by idea:<directIdeaUuid>", () => {
    expect(executionMatchesSession(exec({ entityType: "idea", entityUuid: "idea-9", rootIdeaUuid: null }), ideaSession)).toBe(true);
    expect(executionMatchesSession(exec({ entityType: "idea", entityUuid: "idea-8", rootIdeaUuid: null }), ideaSession)).toBe(false);
    // A daemon_session execution with neither matching uuid nor rootIdea does not match.
    expect(executionMatchesSession(exec({ entityType: "daemon_session", entityUuid: "idea-9", rootIdeaUuid: null }), ideaSession)).toBe(false);
  });

  it("matches an idea-anchored conversation's AUTONOMOUS child wakes via directIdeaUuid", () => {
    // A task_assigned wake on the idea reports as task:<taskUuid> with directIdeaUuid =
    // the idea (its session anchor). It IS the conversation's work on that idea, so it
    // must match (the old entityType==idea-only predicate showed such a conversation idle).
    expect(
      executionMatchesSession(
        exec({ entityType: "task", entityUuid: "task-77", directIdeaUuid: "idea-9" }),
        ideaSession,
      ),
    ).toBe(true);
    // A task whose direct idea is a DIFFERENT idea does not match.
    expect(
      executionMatchesSession(
        exec({ entityType: "task", entityUuid: "task-88", directIdeaUuid: "idea-OTHER" }),
        ideaSession,
      ),
    ).toBe(false);
  });

  it("a DERIVED (child) idea's child-resource wake matches the CHILD session, NOT the parent", () => {
    // The core fix. A task under a child idea resolves directIdeaUuid = child (session
    // anchor) and rootIdeaUuid = parent. It must surface on the CHILD conversation only.
    const childSession = { sessionId: "child-idea", directIdeaUuid: "child-idea" };
    const parentSession = { sessionId: "parent-idea", directIdeaUuid: "parent-idea" };
    const childTaskExec = exec({
      entityType: "task",
      entityUuid: "task-child",
      directIdeaUuid: "child-idea",
      rootIdeaUuid: "parent-idea",
    });
    // CHILD conversation lights up...
    expect(executionMatchesSession(childTaskExec, childSession)).toBe(true);
    // ...and the PARENT conversation shows nothing about the child's run (the bug).
    expect(executionMatchesSession(childTaskExec, parentSession)).toBe(false);
  });

  it("does NOT match a child-resource wake by rootIdeaUuid (the old, buggy behavior is gone)", () => {
    // An execution whose ROOT idea equals the session's idea but whose DIRECT idea is a
    // child must NOT match this (parent) session — matching by root was the bug.
    expect(
      executionMatchesSession(
        exec({ entityType: "task", entityUuid: "task-99", directIdeaUuid: "child-idea", rootIdeaUuid: "idea-9" }),
        ideaSession, // directIdeaUuid: "idea-9" (the parent)
      ),
    ).toBe(false);
  });

  it("an old row with null directIdeaUuid does not match an idea session via root fallback", () => {
    // Backward-compat: a pre-field daemon reports directIdeaUuid = null. A child-resource
    // row then cannot match an idea conversation (only a direct entityType==='idea' wake can).
    expect(
      executionMatchesSession(
        exec({ entityType: "task", entityUuid: "task-old", directIdeaUuid: null, rootIdeaUuid: "idea-9" }),
        ideaSession,
      ),
    ).toBe(false);
  });

  // fix-daemon-conversation-split-cwd-agent: heal interrupt on a LEGACY residual
  // per-instance session `${ideaUuid}::${connectionUuid}` (directIdeaUuid = null), created
  // by the removed cross-cwd fork. The idea is recovered from the `::`-prefix (fix-forward,
  // UI-only, no row migration).
  const residualSession = { sessionId: "idea-9::conn-xyz", directIdeaUuid: null };

  it("tolerates the legacy residual `::` key: recovers the idea from the prefix and matches its executions", () => {
    // A direct wake on the idea, reported by the daemon as idea:<idea-9>, matches the
    // residual thread even though its directIdeaUuid is null.
    expect(
      executionMatchesSession(exec({ entityType: "idea", entityUuid: "idea-9" }), residualSession),
    ).toBe(true);
    // A child-resource wake whose direct idea is idea-9 also matches.
    expect(
      executionMatchesSession(
        exec({ entityType: "task", entityUuid: "task-77", directIdeaUuid: "idea-9" }),
        residualSession,
      ),
    ).toBe(true);
    // A different idea does NOT match.
    expect(
      executionMatchesSession(exec({ entityType: "idea", entityUuid: "idea-OTHER" }), residualSession),
    ).toBe(false);
  });

  it("a genuinely ad-hoc session (no `::`, null directIdeaUuid) keeps its daemon_session:<sessionId> match unchanged", () => {
    // The `::` heal must not misfire on a real ad-hoc conversation whose sessionId is a
    // random uuid with no separator — it still matches only its own daemon_session row.
    expect(executionMatchesSession(exec({ entityType: "daemon_session", entityUuid: "sid-1" }), adHoc)).toBe(true);
    // And it must NOT be treated as an idea (an idea:<sid-1> wake must not match an ad-hoc).
    expect(executionMatchesSession(exec({ entityType: "idea", entityUuid: "sid-1" }), adHoc)).toBe(false);
  });

  it("matches strictly by the DIRECT idea, never the root idea — a sibling idea's run is not matched (R2)", () => {
    // A running execution on a SIBLING idea (its own directIdeaUuid, unrelated root) must
    // never match this idea's conversation.
    expect(
      executionMatchesSession(
        exec({ entityType: "idea", entityUuid: "idea-SIBLING", directIdeaUuid: "idea-SIBLING", rootIdeaUuid: "idea-SIBLING" }),
        ideaSession,
      ),
    ).toBe(false);
    // Even sharing a root idea does not match if the direct idea differs.
    expect(
      executionMatchesSession(
        exec({ entityType: "task", entityUuid: "task-sib", directIdeaUuid: "idea-SIBLING", rootIdeaUuid: "idea-9" }),
        ideaSession,
      ),
    ).toBe(false);
  });
});

describe("executionsForSession", () => {
  it("filters a connection's slice to only this conversation's executions", () => {
    const slice = [
      exec({ uuid: "mine", entityUuid: "sid-1" }),
      exec({ uuid: "other", entityUuid: "sid-2" }),
      exec({ uuid: "task", entityType: "task", entityUuid: "sid-1" }),
    ];
    expect(executionsForSession(slice, adHoc).map((e) => e.uuid)).toEqual(["mine"]);
  });
});

// fix-daemon-conversation-split-cwd-agent: the composer's controllable-execution source
// must reach the idea's running turn from ANY thread, so Interrupt works after a cwd or
// agent switch.
describe("sessionExecutionsForComposer", () => {
  const ideaComposerSession = {
    sessionId: "idea-9",
    directIdeaUuid: "idea-9",
    originConnectionUuid: "conn-origin",
  };

  it("prefers the viewed session's own origin-connection slice when it has a match", () => {
    const byConn = {
      "conn-origin": [exec({ uuid: "own", entityType: "idea", entityUuid: "idea-9", connectionUuid: "conn-origin" })],
      "conn-other": [exec({ uuid: "other", entityType: "idea", entityUuid: "idea-9", connectionUuid: "conn-other" })],
    };
    // Only the origin slice's match is returned (scoped), not the other connection's.
    expect(sessionExecutionsForComposer(byConn, ideaComposerSession).map((e) => e.uuid)).toEqual(["own"]);
  });

  it("falls back across ALL slices when the origin slice has no match (cwd-switch case)", () => {
    // The idea's running turn lives on a DIFFERENT connection than the viewed session's
    // origin — the origin slice is empty/unrelated, so the fallback finds it elsewhere.
    const byConn = {
      "conn-origin": [exec({ uuid: "unrelated", entityType: "idea", entityUuid: "idea-OTHER", connectionUuid: "conn-origin" })],
      "conn-running": [
        exec({ uuid: "running", entityType: "idea", entityUuid: "idea-9", status: "running", connectionUuid: "conn-running" }),
      ],
    };
    const result = sessionExecutionsForComposer(byConn, ideaComposerSession);
    expect(result.map((e) => e.uuid)).toEqual(["running"]);
    // The matched execution carries its OWN connectionUuid so Interrupt targets it correctly.
    expect(result[0]?.connectionUuid).toBe("conn-running");
  });

  it("falls back for the agent-switch case: the running turn is on another agent's row/connection", () => {
    // Agent B's conversation for idea-9 is viewed (origin conn-b, no live exec), while agent
    // A's still-running turn for the same idea is on conn-a. The composer must find it.
    const byConn = {
      "conn-b": [],
      "conn-a": [
        exec({ uuid: "agentA-run", agentUuid: "agent-A", entityType: "idea", entityUuid: "idea-9", status: "running", connectionUuid: "conn-a" }),
      ],
    };
    const viewedOnB = { sessionId: "idea-9", directIdeaUuid: "idea-9", originConnectionUuid: "conn-b" };
    expect(sessionExecutionsForComposer(byConn, viewedOnB).map((e) => e.uuid)).toEqual(["agentA-run"]);
  });

  it("heals a legacy residual `::` session by recovering the idea and matching across slices", () => {
    const residual = { sessionId: "idea-9::conn-xyz", directIdeaUuid: null, originConnectionUuid: "conn-xyz" };
    const byConn = {
      "conn-xyz": [],
      "conn-running": [exec({ uuid: "run", entityType: "idea", entityUuid: "idea-9", status: "running", connectionUuid: "conn-running" })],
    };
    expect(sessionExecutionsForComposer(byConn, residual).map((e) => e.uuid)).toEqual(["run"]);
  });

  it("returns nothing when no slice has the idea's execution (idle from every thread)", () => {
    const byConn = {
      "conn-origin": [exec({ entityType: "idea", entityUuid: "idea-OTHER" })],
    };
    expect(sessionExecutionsForComposer(byConn, ideaComposerSession)).toEqual([]);
  });
});

describe("sessionExecStatus", () => {
  it("running wins over everything", () => {
    const slice = [
      exec({ status: "interrupted", interruptedReason: "user" }),
      exec({ uuid: "e2", status: "running" }),
    ];
    expect(sessionExecStatus(slice, adHoc)).toBe("running");
  });

  it("user-interrupt → interrupted (resumable)", () => {
    expect(sessionExecStatus([exec({ status: "interrupted", interruptedReason: "user" })], adHoc)).toBe("interrupted");
  });

  it("crash-interrupt → error", () => {
    expect(sessionExecStatus([exec({ status: "interrupted", interruptedReason: "crash" })], adHoc)).toBe("error");
  });

  it("no matching execution → null (idle)", () => {
    expect(sessionExecStatus([exec({ entityUuid: "sid-OTHER" })], adHoc)).toBeNull();
    expect(sessionExecStatus([], adHoc)).toBeNull();
  });
});
