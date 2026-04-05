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

  it('should map "pending_review" to "elaborated"', () => {
    expect(normalizeIdeaStatus("pending_review")).toBe("elaborated");
  });

  it('should map "proposal_created" to "elaborated"', () => {
    expect(normalizeIdeaStatus("proposal_created")).toBe("elaborated");
  });

  it('should map "completed" to "elaborated"', () => {
    expect(normalizeIdeaStatus("completed")).toBe("elaborated");
  });

  it('should map "closed" to "elaborated"', () => {
    expect(normalizeIdeaStatus("closed")).toBe("elaborated");
  });

  it("should pass through current statuses unchanged", () => {
    expect(normalizeIdeaStatus("open")).toBe("open");
    expect(normalizeIdeaStatus("elaborating")).toBe("elaborating");
    expect(normalizeIdeaStatus("elaborated")).toBe("elaborated");
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
      ["elaborating", "elaborated"],
    ];

    it.each(validCases)("%s -> %s should be valid", (from, to) => {
      expect(isValidIdeaStatusTransition(from, to)).toBe(true);
    });
  });

  describe("invalid transitions", () => {
    const invalidCases: [string, string][] = [
      ["open", "elaborated"],
      ["elaborating", "open"],
      ["elaborated", "open"],
      ["elaborated", "elaborating"],
    ];

    it.each(invalidCases)("%s -> %s should be invalid", (from, to) => {
      expect(isValidIdeaStatusTransition(from, to)).toBe(false);
    });
  });

  describe("legacy status normalization in transitions", () => {
    it('should treat "assigned" as "elaborating" for transitions', () => {
      // "assigned" normalizes to "elaborating", which can go to "elaborated"
      expect(isValidIdeaStatusTransition("assigned", "elaborated")).toBe(true);
      expect(isValidIdeaStatusTransition("assigned", "open")).toBe(false);
    });

    it('should treat "in_progress" as "elaborating" for transitions', () => {
      expect(isValidIdeaStatusTransition("in_progress", "elaborated")).toBe(true);
      expect(isValidIdeaStatusTransition("in_progress", "open")).toBe(false);
    });

    it('should treat "pending_review" as "elaborated" (terminal) for transitions', () => {
      // "pending_review" normalizes to "elaborated", which is terminal
      expect(isValidIdeaStatusTransition("pending_review", "open")).toBe(false);
      expect(isValidIdeaStatusTransition("pending_review", "elaborating")).toBe(false);
    });
  });

  it("should return false for unknown source status", () => {
    expect(isValidIdeaStatusTransition("nonexistent", "open")).toBe(false);
  });

  it("should have all expected statuses in IDEA_STATUS_TRANSITIONS", () => {
    const expectedStatuses = ["open", "elaborating", "elaborated"];
    expect(Object.keys(IDEA_STATUS_TRANSITIONS).sort()).toEqual(expectedStatuses.sort());
  });

  it("elaborated should be a terminal state with no transitions", () => {
    expect(IDEA_STATUS_TRANSITIONS["elaborated"]).toEqual([]);
  });
});
