// Unit tests for resolveMentionSelection — the @mention-selection precedence
// that inherits the direct idea's pin (pin-cwd-before-wake, Part 2b).
//
// The precedence is exported as a pure function so it can be exercised directly,
// without booting a Tiptap editor + suggestion flow. It decides, for a chosen
// candidate, whether to INSERT the mention immediately (optionally pinned) or to
// open the secondary cwd PICKER.
//
// Three branches under test (mirroring the AC):
//   (a) assignee + ideaPin → insert with the inherited pin, NO picker — even
//       when that place is offline / not among the agent's online instances,
//   (b) assignee + no ideaPin + >=2 online → picker,
//   (c) non-assignee agent + >=2 online → picker (existing behavior unchanged),
//   plus the auto-pin / un-pinned / user fall-throughs.

import { describe, it, expect } from "vitest";
import { resolveMentionSelection } from "@/components/mention-editor";
import type { InstanceCandidate } from "@/components/agent-presence/instance-picker";

function onlineInstance(
  connectionUuid: string,
  cwd: string,
  host = "host-1",
): InstanceCandidate {
  return {
    connectionUuid,
    agentInstanceUuid: `inst-${connectionUuid}`,
    host,
    cwd,
    effectiveStatus: "online",
  };
}

function offlineInstance(
  connectionUuid: string,
  cwd: string,
  host = "host-1",
): InstanceCandidate {
  return {
    connectionUuid,
    agentInstanceUuid: `inst-${connectionUuid}`,
    host,
    cwd,
    effectiveStatus: "offline",
  };
}

describe("resolveMentionSelection — inherit the direct idea's pin", () => {
  it("project-fixed cwd suppresses the picker even with multiple online instances", () => {
    const decision = resolveMentionSelection({
      type: "agent",
      uuid: "agent-G",
      name: "Agent G",
      projectFixedCwd: {
        host: "fixed-host",
        cwd: "/fixed/project",
        availability: "offline",
      },
      instances: [
        onlineInstance("conn-a", "/cwd/a"),
        onlineInstance("conn-b", "/cwd/b"),
      ],
    });
    expect(decision).toEqual({
      kind: "insert",
      pin: { host: "fixed-host", cwd: "/fixed/project", runtimeCwd: true },
    });
  });

  it("project-fixed cwd overrides an inherited Idea pin and keeps runtime routing", () => {
    const decision = resolveMentionSelection({
      type: "agent",
      uuid: "agent-G",
      name: "Agent G",
      isIdeaAssignee: true,
      ideaPin: {
        host: "old-host",
        cwd: "/old/idea",
        agentInstanceUuid: "inst-old",
      },
      projectFixedCwd: {
        host: "fixed-host",
        cwd: "/fixed/project",
        availability: "ready",
      },
      instances: [onlineInstance("conn-a", "/daemon/startup", "fixed-host")],
    });

    expect(decision).toEqual({
      kind: "insert",
      pin: { host: "fixed-host", cwd: "/fixed/project", runtimeCwd: true },
    });
  });

  it("(a) assignee + ideaPin → insert with the inherited pin, NO picker (even when that place is offline)", () => {
    const decision = resolveMentionSelection({
      type: "agent",
      uuid: "agent-G",
      name: "Agent G",
      isIdeaAssignee: true,
      ideaPin: {
        host: "build-box",
        cwd: "/srv/repo",
        agentInstanceUuid: "inst-pinned",
      },
      // The pinned place is NOT among the online instances — it is offline. The
      // HARD inherited pin must still be used, with no picker.
      instances: [
        onlineInstance("conn-a", "/other/cwd/a"),
        onlineInstance("conn-b", "/other/cwd/b"),
      ],
    });
    expect(decision).toEqual({
      kind: "insert",
      pin: { host: "build-box", cwd: "/srv/repo" },
    });
  });

  it("(a) inherited pin wins even when the pinned instance itself is present but offline", () => {
    const decision = resolveMentionSelection({
      type: "agent",
      uuid: "agent-G",
      name: "Agent G",
      isIdeaAssignee: true,
      ideaPin: {
        host: "host-1",
        cwd: "/srv/repo",
        agentInstanceUuid: "inst-pinned",
      },
      instances: [offlineInstance("conn-p", "/srv/repo")],
    });
    expect(decision).toEqual({
      kind: "insert",
      pin: { host: "host-1", cwd: "/srv/repo" },
    });
  });

  it("(a) preserves the unknown-host sentinel (host '') and null cwd of the inherited pin", () => {
    const decision = resolveMentionSelection({
      type: "agent",
      uuid: "agent-G",
      name: "Agent G",
      isIdeaAssignee: true,
      ideaPin: { host: "", cwd: null, agentInstanceUuid: "inst-x" },
      instances: [],
    });
    expect(decision).toEqual({ kind: "insert", pin: { host: "", cwd: null } });
  });

  it("(b) assignee + NO ideaPin + >=2 online → picker over the online set", () => {
    const online = [
      onlineInstance("conn-a", "/cwd/a"),
      onlineInstance("conn-b", "/cwd/b"),
    ];
    const decision = resolveMentionSelection({
      type: "agent",
      uuid: "agent-G",
      name: "Agent G",
      isIdeaAssignee: true, // unpinned idea → still prompt on ambiguity
      instances: online,
    });
    expect(decision).toEqual({ kind: "pick", onlineInstances: online });
  });

  it("(c) non-assignee agent + >=2 online → picker (existing behavior unchanged)", () => {
    const online = [
      onlineInstance("conn-a", "/cwd/a"),
      onlineInstance("conn-b", "/cwd/b"),
    ];
    const decision = resolveMentionSelection({
      type: "agent",
      uuid: "agent-H",
      name: "Agent H",
      isIdeaAssignee: false,
      instances: online,
    });
    expect(decision).toEqual({ kind: "pick", onlineInstances: online });
  });

  it("(c) non-assignee agent with no annotation at all + >=2 online → picker", () => {
    // No entity context was supplied, so isIdeaAssignee/ideaPin are absent.
    const online = [
      onlineInstance("conn-a", "/cwd/a"),
      onlineInstance("conn-b", "/cwd/b"),
    ];
    const decision = resolveMentionSelection({
      type: "agent",
      uuid: "agent-H",
      name: "Agent H",
      instances: online,
    });
    expect(decision).toEqual({ kind: "pick", onlineInstances: online });
  });

  it("filters offline instances out of the picker set (only online is a wake target)", () => {
    const decision = resolveMentionSelection({
      type: "agent",
      uuid: "agent-H",
      name: "Agent H",
      instances: [
        onlineInstance("conn-a", "/cwd/a"),
        offlineInstance("conn-off", "/cwd/off"),
        onlineInstance("conn-b", "/cwd/b"),
      ],
    });
    expect(decision.kind).toBe("pick");
    if (decision.kind === "pick") {
      expect(decision.onlineInstances.map((i) => i.connectionUuid)).toEqual([
        "conn-a",
        "conn-b",
      ]);
    }
  });

  it("exactly one online instance → insert auto-pinned to it, no picker", () => {
    const sole = onlineInstance("conn-a", "/cwd/a");
    const decision = resolveMentionSelection({
      type: "agent",
      uuid: "agent-H",
      name: "Agent H",
      instances: [sole, offlineInstance("conn-off", "/cwd/off")],
    });
    expect(decision).toEqual({ kind: "insert", pin: sole });
  });

  it("zero online instances → insert un-pinned", () => {
    const decision = resolveMentionSelection({
      type: "agent",
      uuid: "agent-H",
      name: "Agent H",
      instances: [offlineInstance("conn-off", "/cwd/off")],
    });
    expect(decision).toEqual({ kind: "insert", pin: null });
  });

  it("a user candidate → insert un-pinned (never a picker, never a pin)", () => {
    const decision = resolveMentionSelection({
      type: "user",
      uuid: "user-1",
      name: "Alice",
    });
    expect(decision).toEqual({ kind: "insert", pin: null });
  });

  it("an assignee agent that is unpinned with a single online instance → auto-pin (not the inherited-pin path)", () => {
    const sole = onlineInstance("conn-a", "/cwd/a");
    const decision = resolveMentionSelection({
      type: "agent",
      uuid: "agent-G",
      name: "Agent G",
      isIdeaAssignee: true, // assignee but no ideaPin
      instances: [sole],
    });
    expect(decision).toEqual({ kind: "insert", pin: sole });
  });
});
