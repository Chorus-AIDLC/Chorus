import { describe, it, expect } from "vitest";
import {
  canStartDevelopment,
  startDevelopmentPreconditionsMet,
  assigneeOwningAgentUuid,
} from "@/lib/start-development";

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
    expect(
      assigneeOwningAgentUuid({ type: "agent_instance", uuid: "i-1" })
    ).toBeNull();
    expect(assigneeOwningAgentUuid(null)).toBeNull();
  });
});

describe("canStartDevelopment — assignee gate", () => {
  it("enabled for an online agent assignee with approved proposal and open task", () => {
    expect(canStartDevelopment(HAPPY)).toBe(true);
  });

  it("enabled for an agent_instance assignee", () => {
    expect(canStartDevelopment({ ...HAPPY, assignee: instanceAssignee })).toBe(true);
  });

  it("disabled for a user assignee or no assignee", () => {
    expect(canStartDevelopment({ ...HAPPY, assignee: userAssignee })).toBe(false);
    expect(canStartDevelopment({ ...HAPPY, assignee: null })).toBe(false);
  });
});

describe("canStartDevelopment — proposal gate", () => {
  it("disabled without any proposal", () => {
    expect(canStartDevelopment({ ...HAPPY, proposals: [] })).toBe(false);
    expect(canStartDevelopment({ ...HAPPY, proposals: null })).toBe(false);
  });

  it("disabled when proposals exist but none is approved", () => {
    expect(
      canStartDevelopment({
        ...HAPPY,
        proposals: [{ status: "pending" }, { status: "rejected" }, { status: "draft" }],
      })
    ).toBe(false);
  });
});

describe("canStartDevelopment — unfinished-task gate", () => {
  it("disabled with no tasks at all", () => {
    expect(canStartDevelopment({ ...HAPPY, tasks: [] })).toBe(false);
    expect(canStartDevelopment({ ...HAPPY, tasks: null })).toBe(false);
  });

  it("disabled when every task is done or closed", () => {
    expect(
      canStartDevelopment({ ...HAPPY, tasks: [{ status: "done" }, { status: "closed" }] })
    ).toBe(false);
  });

  it.each(["open", "assigned", "in_progress", "to_verify"])(
    "enabled when a task is %s (counts as unfinished)",
    (status) => {
      expect(
        canStartDevelopment({ ...HAPPY, tasks: [{ status: "done" }, { status }] })
      ).toBe(true);
    }
  );
});

describe("canStartDevelopment — online gate", () => {
  it("disabled when the agent is offline, even with all stage preconditions met", () => {
    expect(canStartDevelopment({ ...HAPPY, agentOnline: false })).toBe(false);
    // ...but the stage preconditions still hold — the panel renders the button
    // disabled with an offline hint instead of hiding it.
    expect(
      startDevelopmentPreconditionsMet({
        assignee: HAPPY.assignee,
        proposals: HAPPY.proposals,
        tasks: HAPPY.tasks,
      })
    ).toBe(true);
  });
});
