import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readIdeaTeamTurnContext } from "../idea-team-turn-context";
import { parseWakeContext } from "@/services/daemon-wake-context";

describe("Idea Team supplementary turn headers", () => {
  const primary = { "x-chorus-turn-uuid": randomUUID(), "x-chorus-admission-uuid": randomUUID() };
  const proof = { turnUuid: randomUUID(), admissionUuid: randomUUID() };

  it("preserves legacy and primary-only context shapes", () => {
    expect(readIdeaTeamTurnContext(new Headers())).toEqual({});
    expect(readIdeaTeamTurnContext(new Headers(primary))).toEqual({ ideaTeamTurn: { turnUuid: primary["x-chorus-turn-uuid"], admissionUuid: primary["x-chorus-admission-uuid"] } });
  });

  it("accepts bounded supplementary proof pairs", () => {
    const supplementaryTurns = Array.from({ length: 16 }, () => proof);
    expect(readIdeaTeamTurnContext(new Headers({ ...primary, "x-chorus-idea-team-turns": JSON.stringify(supplementaryTurns) }))).toMatchObject({ ideaTeamTurn: { supplementaryTurns } });
  });

  it.each(["invalid", "null", "{}", JSON.stringify([{ turnUuid: "invalid", admissionUuid: proof.admissionUuid }]), JSON.stringify([{ ...proof, ideaUuid: randomUUID() }]), JSON.stringify(Array.from({ length: 17 }, () => proof)), " ".repeat(4097)])("rejects malformed or oversized supplementary proofs: %s", (value) => {
    expect(() => readIdeaTeamTurnContext(new Headers({ ...primary, "x-chorus-idea-team-turns": value }))).toThrow();
  });

  it("requires primary headers even with valid supplementary proofs", () => {
    expect(() => readIdeaTeamTurnContext(new Headers({ "x-chorus-idea-team-turns": JSON.stringify([proof]) }))).toThrow("primary");
  });

  it("preserves complete server snapshots and rejects arrays that omit or contradict the primary", () => {
    const ideaTeam = { ideaUuid: randomUUID(), generation: 1, ownerUuid: randomUUID(), agentUuid: randomUUID(), role: "orchestrator" };
    const secondary = { ...ideaTeam, ideaUuid: randomUUID() };
    const notificationUuid = randomUUID();
    const context = { version: 1, notificationUuid, ideaTeam, ideaTeams: [ideaTeam, secondary], notification: { uuid: notificationUuid, action: "team_lead_handoff", entityType: "proposal", entityUuid: randomUUID(), projectUuid: randomUUID(), recipientType: "agent", recipientUuid: ideaTeam.agentUuid, message: "Review", entityTitle: "Proposal", projectName: "Project", actorType: "user", actorUuid: ideaTeam.ownerUuid, actorName: "Owner" } };
    expect(parseWakeContext(context)).toEqual(context);
    expect(parseWakeContext({ ...context, ideaTeam: undefined })).toBeNull();
    expect(parseWakeContext({ ...context, ideaTeams: [secondary] })).toBeNull();
    expect(parseWakeContext({ ...context, ideaTeam: { ...ideaTeam, generation: 2 } })).toBeNull();
  });
});
