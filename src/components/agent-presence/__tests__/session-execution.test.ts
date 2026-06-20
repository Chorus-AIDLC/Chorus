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

  it("matches an idea-anchored conversation's AUTONOMOUS child wakes via rootIdeaUuid", () => {
    // A task_assigned wake on the idea reports as task:<taskUuid> with rootIdeaUuid =
    // the idea. It IS the conversation's work on that idea, so it must match (the old
    // entityType==idea-only predicate showed such a conversation idle).
    expect(
      executionMatchesSession(
        exec({ entityType: "task", entityUuid: "task-77", rootIdeaUuid: "idea-9" }),
        ideaSession,
      ),
    ).toBe(true);
    // A task whose root idea is a DIFFERENT idea does not match.
    expect(
      executionMatchesSession(
        exec({ entityType: "task", entityUuid: "task-88", rootIdeaUuid: "idea-OTHER" }),
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
