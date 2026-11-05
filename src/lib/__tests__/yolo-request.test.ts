import { describe, it, expect } from "vitest";
import {
  canRequestYolo,
  yoloPreconditionsMet,
  assigneeOwningAgentUuid,
} from "@/lib/yolo-request";

const agentAssignee = { type: "agent", uuid: "agent-1" };
const instanceAssignee = {
  type: "agent_instance",
  uuid: "instance-1",
  instance: { agentUuid: "agent-1" },
};
const userAssignee = { type: "user", uuid: "user-1" };

const approvedProposal = [{ status: "approved" }];
const openTask = [{ status: "open" }];

const HAPPY = {
  assignee: agentAssignee,
  proposals: approvedProposal,
  tasks: openTask,
  agentOnline: true,
};

describe("assigneeOwningAgentUuid", () => {
  it("returns the agent uuid for an agent assignee", () => {
    expect(assigneeOwningAgentUuid(agentAssignee)).toBe("agent-1");
  });

  it("resolves an agent_instance assignee to its owning agent", () => {
    expect(assigneeOwningAgentUuid(instanceAssignee)).toBe("agent-1");
  });

  it("returns null for a user assignee, a missing instance link, or no assignee", () => {
    expect(assigneeOwningAgentUuid(userAssignee)).toBeNull();
    expect(assigneeOwningAgentUuid({ type: "agent_instance", uuid: "i-1" })).toBeNull();
    expect(assigneeOwningAgentUuid(null)).toBeNull();
  });
});

describe("canRequestYolo — assignee gate", () => {
  it("enabled for an online agent assignee that is not done", () => {
    expect(canRequestYolo(HAPPY)).toBe(true);
  });

  it("enabled for an agent_instance assignee", () => {
    expect(canRequestYolo({ ...HAPPY, assignee: instanceAssignee })).toBe(true);
  });

  it("disabled for a user assignee or no assignee", () => {
    expect(canRequestYolo({ ...HAPPY, assignee: userAssignee })).toBe(false);
    expect(canRequestYolo({ ...HAPPY, assignee: null })).toBe(false);
  });
});

describe("canRequestYolo — any-incomplete-stage gate (the divergence from start_development)", () => {
  it("ENABLED with no proposal at all (open/elaborating idea) — unlike start_development", () => {
    expect(canRequestYolo({ ...HAPPY, proposals: [], tasks: [] })).toBe(true);
    expect(canRequestYolo({ ...HAPPY, proposals: null, tasks: null })).toBe(true);
  });

  it("ENABLED with a pending/rejected proposal but no approved one", () => {
    expect(
      canRequestYolo({
        ...HAPPY,
        proposals: [{ status: "pending" }, { status: "rejected" }],
        tasks: [],
      })
    ).toBe(true);
  });

  it("ENABLED with an approved proposal that still has unfinished tasks (building stage)", () => {
    expect(
      canRequestYolo({
        ...HAPPY,
        proposals: approvedProposal,
        tasks: [{ status: "done" }, { status: "in_progress" }],
      })
    ).toBe(true);
  });

  it("DISABLED only when the idea is fully done: approved proposal AND every task done/closed", () => {
    expect(
      canRequestYolo({
        ...HAPPY,
        proposals: approvedProposal,
        tasks: [{ status: "done" }, { status: "closed" }],
      })
    ).toBe(false);
  });

  it("an approved proposal with ZERO tasks is not 'done' (still enabled)", () => {
    // No tasks yet means the work isn't finished — the button must still show.
    expect(canRequestYolo({ ...HAPPY, proposals: approvedProposal, tasks: [] })).toBe(true);
  });
});

describe("canRequestYolo — online gate", () => {
  it("disabled when the agent is offline, but the stage preconditions still hold (render disabled + hint)", () => {
    expect(canRequestYolo({ ...HAPPY, agentOnline: false })).toBe(false);
    expect(
      yoloPreconditionsMet({
        assignee: HAPPY.assignee,
        proposals: HAPPY.proposals,
        tasks: HAPPY.tasks,
      })
    ).toBe(true);
  });

  it("preconditions are false for a done idea regardless of online state (button hidden, not just disabled)", () => {
    expect(
      yoloPreconditionsMet({
        assignee: agentAssignee,
        proposals: approvedProposal,
        tasks: [{ status: "done" }],
      })
    ).toBe(false);
  });
});

describe("yolo-request — directly linked Quick Tasks (design D4 / #650)", () => {
  const base = { assignee: agentAssignee, agentOnline: true };

  it("treats a proposal-less idea whose linked tasks are all done/closed as done", () => {
    const input = { ...base, proposals: [], tasks: [], linkedTasks: [{ status: "done" }, { status: "closed" }] };
    expect(yoloPreconditionsMet(input)).toBe(false);
    expect(canRequestYolo(input)).toBe(false);
  });

  it("is not done while any linked task is unfinished", () => {
    for (const status of ["open", "assigned", "in_progress", "to_verify"]) {
      expect(canRequestYolo({ ...base, proposals: null, tasks: null, linkedTasks: [{ status: "done" }, { status }] })).toBe(true);
    }
  });

  it("unions linked tasks with the approved proposal's tasks", () => {
    expect(canRequestYolo({
      ...base, proposals: approvedProposal, tasks: [{ status: "done" }], linkedTasks: [{ status: "in_progress" }],
    })).toBe(true);
    expect(canRequestYolo({
      ...base, proposals: approvedProposal, tasks: [{ status: "done" }], linkedTasks: [{ status: "done" }],
    })).toBe(false);
  });

  it("a pending proposal keeps the idea not-done even when every linked task is done", () => {
    expect(canRequestYolo({
      ...base, proposals: [{ status: "pending" }], tasks: [], linkedTasks: [{ status: "done" }],
    })).toBe(true);
  });

  it("empty or omitted linkedTasks keeps the proposal-only rule", () => {
    expect(canRequestYolo({ ...base, proposals: [], tasks: [{ status: "done" }], linkedTasks: [] })).toBe(true);
    expect(canRequestYolo({ ...base, proposals: approvedProposal, tasks: [{ status: "done" }], linkedTasks: null })).toBe(false);
  });
});
