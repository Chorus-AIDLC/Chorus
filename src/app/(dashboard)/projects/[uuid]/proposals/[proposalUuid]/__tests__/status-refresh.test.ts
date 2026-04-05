import { describe, it, expect } from "vitest";
import { shouldRefresh } from "../draft-diff";

// Tests the actual exported shouldRefresh function used by ProposalEditor
// router.refresh() should be called when:
// 1. Status changes (e.g. draft → pending)
// 2. Draft count changes while in draft status (for ValidationChecklist)

describe("shouldRefresh", () => {
  it("triggers on status change (draft → pending)", () => {
    expect(shouldRefresh("draft", "pending", 1, 1, 3, 3)).toBe(true);
  });

  it("triggers on status change (pending → approved)", () => {
    expect(shouldRefresh("pending", "approved", 1, 1, 3, 3)).toBe(true);
  });

  it("triggers on status change (pending → draft via reject)", () => {
    expect(shouldRefresh("pending", "draft", 1, 1, 3, 3)).toBe(true);
  });

  it("does NOT trigger when status unchanged and no draft count change", () => {
    expect(shouldRefresh("draft", "draft", 1, 1, 3, 3)).toBe(false);
  });

  it("triggers when doc draft added in draft status", () => {
    expect(shouldRefresh("draft", "draft", 1, 2, 3, 3)).toBe(true);
  });

  it("triggers when task draft added in draft status", () => {
    expect(shouldRefresh("draft", "draft", 1, 1, 3, 4)).toBe(true);
  });

  it("triggers when doc draft removed in draft status", () => {
    expect(shouldRefresh("draft", "draft", 2, 1, 3, 3)).toBe(true);
  });

  it("does NOT trigger on draft count change when NOT in draft status", () => {
    // In pending/approved status, checklist isn't shown, no need to refresh
    expect(shouldRefresh("pending", "pending", 1, 2, 3, 3)).toBe(false);
  });

  it("triggers when both status AND draft count change", () => {
    expect(shouldRefresh("draft", "pending", 1, 2, 3, 4)).toBe(true);
  });

  it("handles null latest status", () => {
    expect(shouldRefresh("draft", null, 1, 1, 3, 3)).toBe(false);
  });
});
