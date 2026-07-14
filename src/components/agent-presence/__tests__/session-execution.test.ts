// Unit tests for the per-conversation execution matching helpers (子3 follow-up).
import { describe, expect, it } from "vitest";
import {
  executionMatchesSession,
  executionsForSession,
  sessionExecStatus,
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
