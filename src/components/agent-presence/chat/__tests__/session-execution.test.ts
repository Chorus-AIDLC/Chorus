// Unit tests for the per-conversation execution matching helpers, focused on
// `sessionExecStatusForRow` — the conversation-LIST row status that must agree with
// the composer's Interrupt control (origin slice preferred, all-slice fallback,
// strict per-conversation match, no cross-borrow).

import { describe, it, expect } from "vitest";
import type { ExecutionView } from "@/services/daemon-execution.service";
import {
  sessionExecStatus,
  sessionExecStatusForRow,
  sessionExecutionsForComposer,
} from "../session-execution";

// Minimal ExecutionView factory — only the fields the matchers read matter; the rest
// are filled with inert defaults so the object satisfies the type.
function exec(over: Partial<ExecutionView> & { connectionUuid: string }): ExecutionView {
  return {
    uuid: `exec-${Math.random().toString(36).slice(2)}`,
    agentUuid: "agent-1",
    entityType: "idea",
    entityUuid: "idea-A",
    rootIdeaUuid: null,
    directIdeaUuid: "idea-A",
    status: "running",
    interruptedReason: null,
    startedAt: null,
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z",
    entityTitle: null,
    projectUuid: null,
    rootIdeaTitle: null,
    ...over,
  };
}

const ideaSession = {
  sessionId: "idea-A",
  directIdeaUuid: "idea-A",
  originConnectionUuid: "conn-origin",
};

describe("sessionExecStatusForRow", () => {
  it("reads a running execution on the conversation's own origin connection (parity with the old behavior)", () => {
    const byConn: Record<string, ExecutionView[]> = {
      "conn-origin": [exec({ connectionUuid: "conn-origin", entityType: "idea", entityUuid: "idea-A", status: "running" })],
    };
    expect(sessionExecStatusForRow(byConn, ideaSession)).toBe("running");
  });

  it("lights the row when the running execution lives on a NON-origin connection (the fix)", () => {
    // Origin slice has nothing; the idea's running turn is on another connection
    // (a re-point / agent switch). The OLD row logic (origin-only) returned null here.
    const byConn: Record<string, ExecutionView[]> = {
      "conn-origin": [],
      "conn-other": [exec({ connectionUuid: "conn-other", entityType: "idea", entityUuid: "idea-A", status: "running" })],
    };
    expect(sessionExecStatusForRow(byConn, ideaSession)).toBe("running");
    // Prove the divergence the fix removes: the old origin-only read is idle.
    expect(sessionExecStatus(byConn["conn-origin"], ideaSession)).toBeNull();
  });

  it("never borrows an unrelated conversation's execution on another connection", () => {
    const byConn: Record<string, ExecutionView[]> = {
      "conn-origin": [],
      "conn-other": [exec({ connectionUuid: "conn-other", entityType: "idea", entityUuid: "idea-OTHER", directIdeaUuid: "idea-OTHER", status: "running" })],
    };
    expect(sessionExecStatusForRow(byConn, ideaSession)).toBeNull();
  });

  it("reflects a user-interrupt found on the fallback connection as 'interrupted' (resumable)", () => {
    const byConn: Record<string, ExecutionView[]> = {
      "conn-origin": [],
      "conn-other": [
        exec({
          connectionUuid: "conn-other",
          entityType: "idea",
          entityUuid: "idea-A",
          status: "interrupted",
          interruptedReason: "user",
        }),
      ],
    };
    expect(sessionExecStatusForRow(byConn, ideaSession)).toBe("interrupted");
  });

  it("reflects a crash-interrupt on the fallback connection as 'error'", () => {
    const byConn: Record<string, ExecutionView[]> = {
      "conn-origin": [],
      "conn-other": [
        exec({
          connectionUuid: "conn-other",
          entityType: "idea",
          entityUuid: "idea-A",
          status: "interrupted",
          interruptedReason: "crash",
        }),
      ],
    };
    expect(sessionExecStatusForRow(byConn, ideaSession)).toBe("error");
  });

  it("is idle (null) when no connection has any matching execution", () => {
    const byConn: Record<string, ExecutionView[]> = { "conn-origin": [], "conn-other": [] };
    expect(sessionExecStatusForRow(byConn, ideaSession)).toBeNull();
  });

  it("matches an ad-hoc conversation by its daemon_session id across slices", () => {
    const adhoc = { sessionId: "sess-xyz", directIdeaUuid: null, originConnectionUuid: "conn-origin" };
    const byConn: Record<string, ExecutionView[]> = {
      "conn-origin": [],
      "conn-other": [
        exec({
          connectionUuid: "conn-other",
          entityType: "daemon_session",
          entityUuid: "sess-xyz",
          directIdeaUuid: null,
          status: "running",
        }),
      ],
    };
    expect(sessionExecStatusForRow(byConn, adhoc)).toBe("running");
  });

  it("composes exactly the composer's matched set reduced to one status", () => {
    // Guard the composition contract: sessionExecStatusForRow === sessionExecStatus(composer set).
    const byConn: Record<string, ExecutionView[]> = {
      "conn-origin": [],
      "conn-other": [exec({ connectionUuid: "conn-other", entityType: "idea", entityUuid: "idea-A", status: "running" })],
    };
    const composerSet = sessionExecutionsForComposer(byConn, ideaSession);
    expect(sessionExecStatusForRow(byConn, ideaSession)).toBe(sessionExecStatus(composerSet, ideaSession));
  });
});
