import { describe, it, expect } from "vitest";
import {
  normalizeIdeaStatus,
  isValidIdeaStatusTransition,
  IDEA_STATUS_TRANSITIONS,
} from "@/services/idea.service";

// ===== normalizeIdeaStatus =====

describe("normalizeIdeaStatus", () => {
  it('should map "assigned" to "elaborating"', () => {
    expect(normalizeIdeaStatus("assigned")).toBe("elaborating");
  });

  it('should map "in_progress" to "elaborating"', () => {
    expect(normalizeIdeaStatus("in_progress")).toBe("elaborating");
  });

  it('should map "pending_review" to "proposal_created"', () => {
    expect(normalizeIdeaStatus("pending_review")).toBe("proposal_created");
  });

  it("should pass through current statuses unchanged", () => {
    expect(normalizeIdeaStatus("open")).toBe("open");
    expect(normalizeIdeaStatus("elaborating")).toBe("elaborating");
    expect(normalizeIdeaStatus("proposal_created")).toBe("proposal_created");
    expect(normalizeIdeaStatus("completed")).toBe("completed");
    expect(normalizeIdeaStatus("closed")).toBe("closed");
  });

  it("should pass through unknown statuses unchanged", () => {
    expect(normalizeIdeaStatus("unknown_status")).toBe("unknown_status");
  });
});

// ===== isValidIdeaStatusTransition =====

describe("isValidIdeaStatusTransition", () => {
  describe("valid transitions", () => {
    const validCases: [string, string][] = [
      ["open", "elaborating"],
      ["open", "closed"],
      ["elaborating", "proposal_created"],
      ["elaborating", "closed"],
      ["proposal_created", "completed"],
      ["proposal_created", "elaborating"],
      ["proposal_created", "closed"],
      ["completed", "closed"],
    ];

    it.each(validCases)("%s -> %s should be valid", (from, to) => {
      expect(isValidIdeaStatusTransition(from, to)).toBe(true);
    });
  });

  describe("invalid transitions", () => {
    const invalidCases: [string, string][] = [
      ["open", "completed"],
      ["open", "proposal_created"],
      ["elaborating", "open"],
      ["elaborating", "completed"],
      ["proposal_created", "open"],
      ["completed", "open"],
      ["completed", "elaborating"],
      ["completed", "proposal_created"],
      ["closed", "open"],
      ["closed", "elaborating"],
      ["closed", "proposal_created"],
      ["closed", "completed"],
    ];

    it.each(invalidCases)("%s -> %s should be invalid", (from, to) => {
      expect(isValidIdeaStatusTransition(from, to)).toBe(false);
    });
  });

  describe("legacy status normalization in transitions", () => {
    it('should treat "assigned" as "elaborating" for transitions', () => {
      // "assigned" normalizes to "elaborating", which can go to "proposal_created"
      expect(isValidIdeaStatusTransition("assigned", "proposal_created")).toBe(true);
      expect(isValidIdeaStatusTransition("assigned", "closed")).toBe(true);
      expect(isValidIdeaStatusTransition("assigned", "open")).toBe(false);
    });

    it('should treat "in_progress" as "elaborating" for transitions', () => {
      expect(isValidIdeaStatusTransition("in_progress", "proposal_created")).toBe(true);
      expect(isValidIdeaStatusTransition("in_progress", "closed")).toBe(true);
      expect(isValidIdeaStatusTransition("in_progress", "completed")).toBe(false);
    });

    it('should treat "pending_review" as "proposal_created" for transitions', () => {
      expect(isValidIdeaStatusTransition("pending_review", "completed")).toBe(true);
      expect(isValidIdeaStatusTransition("pending_review", "elaborating")).toBe(true);
      expect(isValidIdeaStatusTransition("pending_review", "closed")).toBe(true);
      expect(isValidIdeaStatusTransition("pending_review", "open")).toBe(false);
    });
  });

  it("should return false for unknown source status", () => {
    expect(isValidIdeaStatusTransition("nonexistent", "open")).toBe(false);
  });

  it("should have all expected statuses in IDEA_STATUS_TRANSITIONS", () => {
    const expectedStatuses = ["open", "elaborating", "proposal_created", "completed", "closed"];
    expect(Object.keys(IDEA_STATUS_TRANSITIONS).sort()).toEqual(expectedStatuses.sort());
  });

  it("closed should be a terminal state with no transitions", () => {
    expect(IDEA_STATUS_TRANSITIONS["closed"]).toEqual([]);
  });
});
