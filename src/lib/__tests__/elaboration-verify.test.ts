import { describe, expect, it } from "vitest";
import { canVerifyElaboration } from "@/lib/elaboration-verify";
import type { ElaborationResponse, ElaborationRoundResponse } from "@/types/elaboration";

function round(status: string, roundNumber = 1): ElaborationRoundResponse {
  return {
    uuid: `round-${roundNumber}`,
    roundNumber,
    status,
    isAppended: false,
    createdBy: { type: "agent", uuid: "agent-1" },
    validatedAt: null,
    questions: [],
    createdAt: "2026-06-20T00:00:00.000Z",
  };
}

function elaboration(rounds: ElaborationRoundResponse[]): ElaborationResponse {
  return {
    ideaUuid: "idea-1",
    depth: "standard",
    status: "pending_answers",
    rounds,
    summary: {
      totalQuestions: rounds.length,
      answeredQuestions: rounds.length,
      validatedRounds: 0,
      pendingRound: null,
    },
  };
}

describe("canVerifyElaboration", () => {
  it("is true when elaborating, not resolved, ≥1 round, no round pending", () => {
    expect(
      canVerifyElaboration({
        ideaStatus: "elaborating",
        elaborationStatus: "validating",
        elaboration: elaboration([round("answered")]),
      }),
    ).toBe(true);
  });

  it("treats legacy answered statuses (validated / needs_followup) as answered", () => {
    expect(
      canVerifyElaboration({
        ideaStatus: "elaborating",
        elaborationStatus: "validating",
        elaboration: elaboration([round("validated", 1), round("needs_followup", 2)]),
      }),
    ).toBe(true);
  });

  it("is false when the idea is not in elaborating status", () => {
    expect(
      canVerifyElaboration({
        ideaStatus: "elaborated",
        elaborationStatus: "validating",
        elaboration: elaboration([round("answered")]),
      }),
    ).toBe(false);
    expect(
      canVerifyElaboration({
        ideaStatus: "open",
        elaborationStatus: null,
        elaboration: elaboration([round("answered")]),
      }),
    ).toBe(false);
  });

  it("is false when the elaboration is already resolved", () => {
    expect(
      canVerifyElaboration({
        ideaStatus: "elaborating",
        elaborationStatus: "resolved",
        elaboration: elaboration([round("answered")]),
      }),
    ).toBe(false);
  });

  it("is false when there are zero rounds", () => {
    expect(
      canVerifyElaboration({
        ideaStatus: "elaborating",
        elaborationStatus: "validating",
        elaboration: elaboration([]),
      }),
    ).toBe(false);
  });

  it("is false when any round is still pending_answers", () => {
    expect(
      canVerifyElaboration({
        ideaStatus: "elaborating",
        elaborationStatus: "pending_answers",
        elaboration: elaboration([round("answered", 1), round("pending_answers", 2)]),
      }),
    ).toBe(false);
  });

  it("is false when elaboration data is missing (null/undefined)", () => {
    expect(
      canVerifyElaboration({
        ideaStatus: "elaborating",
        elaborationStatus: "validating",
        elaboration: null,
      }),
    ).toBe(false);
    expect(
      canVerifyElaboration({
        ideaStatus: "elaborating",
        elaborationStatus: undefined,
        elaboration: undefined,
      }),
    ).toBe(false);
  });
});
