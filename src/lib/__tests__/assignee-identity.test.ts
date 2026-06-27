import { describe, it, expect } from "vitest";
import {
  isAssignedToActor,
  isInstanceAssignee,
  isAgentAssignee,
  type AssigneeLike,
  type ActorIdentity,
} from "../assignee-identity";

const userActor: ActorIdentity = { type: "user", uuid: "user-1" };
const agentActor: ActorIdentity = { type: "agent", uuid: "agent-1" };

describe("isAssignedToActor — the task-detail-panel ownership fix (type AND uuid)", () => {
  it("matches a user assignee only when BOTH type and uuid match the user", () => {
    const assignee: AssigneeLike = { type: "user", uuid: "user-1" };
    expect(isAssignedToActor(assignee, userActor)).toBe(true);
  });

  it("does NOT match when the uuid coincides but the type differs (the old bug)", () => {
    // An agent assignment whose uuid happens to equal the viewing user's uuid must
    // NOT read as "mine" — the old `uuid === currentUserUuid` check would wrongly
    // pass. type-aware comparison rejects it.
    const assignee: AssigneeLike = { type: "agent", uuid: "user-1" };
    expect(isAssignedToActor(assignee, userActor)).toBe(false);
  });

  it("matches an agent assignee only for the same agent actor (type AND uuid)", () => {
    const assignee: AssigneeLike = { type: "agent", uuid: "agent-1" };
    expect(isAssignedToActor(assignee, agentActor)).toBe(true);
    // a user viewer is never an agent assignee
    expect(isAssignedToActor(assignee, userActor)).toBe(false);
  });

  it("treats an agent_instance as mine when its OWNING agent is the actor", () => {
    // assigneeUuid is an INSTANCE uuid; the identity is the owning agentUuid.
    const assignee: AssigneeLike = {
      type: "agent_instance",
      uuid: "instance-xyz",
      agentUuid: "agent-1",
    };
    expect(isAssignedToActor(assignee, agentActor)).toBe(true);
  });

  it("does NOT treat an agent_instance as mine for a DIFFERENT agent", () => {
    const assignee: AssigneeLike = {
      type: "agent_instance",
      uuid: "instance-xyz",
      agentUuid: "agent-2",
    };
    expect(isAssignedToActor(assignee, agentActor)).toBe(false);
  });

  it("never matches an agent_instance against the INSTANCE uuid (only the agent)", () => {
    // The instance uuid must never be compared against an actor uuid — guards the
    // exact hazard the helper exists for.
    const assignee: AssigneeLike = {
      type: "agent_instance",
      uuid: "agent-1", // pretend the instance uuid collides with the agent uuid
      agentUuid: "agent-9",
    };
    expect(isAssignedToActor(assignee, agentActor)).toBe(false);
  });

  it("does NOT match an agent_instance with no owning agentUuid", () => {
    const assignee: AssigneeLike = { type: "agent_instance", uuid: "instance-xyz" };
    expect(isAssignedToActor(assignee, agentActor)).toBe(false);
  });

  it("returns false for a user viewer on any agent_instance (the dashboard case)", () => {
    const assignee: AssigneeLike = {
      type: "agent_instance",
      uuid: "instance-xyz",
      agentUuid: "agent-1",
    };
    expect(isAssignedToActor(assignee, userActor)).toBe(false);
  });

  it("returns false for null assignee or null actor", () => {
    expect(isAssignedToActor(null, userActor)).toBe(false);
    expect(isAssignedToActor({ type: "user", uuid: "user-1" }, null)).toBe(false);
    expect(isAssignedToActor(null, null)).toBe(false);
  });

  it("returns false for an unknown assignee type", () => {
    expect(isAssignedToActor({ type: "robot", uuid: "user-1" }, userActor)).toBe(false);
  });
});

describe("isInstanceAssignee", () => {
  it("is true only for agent_instance", () => {
    expect(isInstanceAssignee({ type: "agent_instance", uuid: "i" })).toBe(true);
    expect(isInstanceAssignee({ type: "agent", uuid: "a" })).toBe(false);
    expect(isInstanceAssignee({ type: "user", uuid: "u" })).toBe(false);
    expect(isInstanceAssignee(null)).toBe(false);
  });
});

describe("isAgentAssignee", () => {
  it("is true for both agent and agent_instance (the Bot-avatar predicate)", () => {
    expect(isAgentAssignee({ type: "agent", uuid: "a" })).toBe(true);
    expect(isAgentAssignee({ type: "agent_instance", uuid: "i" })).toBe(true);
  });
  it("is false for user and null", () => {
    expect(isAgentAssignee({ type: "user", uuid: "u" })).toBe(false);
    expect(isAgentAssignee(null)).toBe(false);
  });
});
