import { describe, expect, it } from "vitest";
import { resolveConnectionConfig } from "../src/index.js";
import { ideaTeamHeaders, ideaTeamProofFromEnv } from "../bin/idea-team-transport.mjs";

describe("Idea Team admission transport", () => {
  it("uses only process-run proof, never persisted config or .env proof", () => {
    const turnUuid = "11111111-1111-4111-8111-111111111111";
    const admissionUuid = "22222222-2222-4222-8222-222222222222";
    const proof = { turnUuid, admissionUuid, supplementaryTurns: [{ turnUuid: admissionUuid, admissionUuid }] };
    const env = { CHORUS_TURN_UUID: turnUuid, CHORUS_ADMISSION_UUID: admissionUuid,
      CHORUS_IDEA_TEAM_TURNS: JSON.stringify(proof.supplementaryTurns) };
    const connection = { url: "https://isolated.invalid", apiKey: "synthetic" };
    const fenced = resolveConnectionConfig(connection, env);
    expect(fenced.turnHeaders).toEqual(ideaTeamHeaders(proof));
    env.CHORUS_TURN_UUID = "stale";
    expect(fenced.turnHeaders?.["X-Chorus-Turn-Uuid"]).toBe(turnUuid);
    expect(resolveConnectionConfig(connection, {}).turnHeaders).toBeUndefined();
    expect(() => resolveConnectionConfig(connection, env)).toThrow();
  });

  it("fails closed on malformed or oversized supplementary proof", () => {
    expect(() => ideaTeamProofFromEnv({ CHORUS_IDEA_TEAM_TURNS: "[" })).toThrow();
    expect(() => ideaTeamProofFromEnv({ CHORUS_TURN_UUID: "bad" })).toThrow();
  });
});
