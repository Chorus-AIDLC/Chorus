/**
 * Proposal service pure function tests.
 *
 * NOTE: ensureDocumentDraftUuid and ensureTaskDraftUuid are NOT exported
 * from proposal.service.ts, so they cannot be directly unit-tested.
 *
 * This file tests the exported type contracts and validates the draft
 * interfaces match expected shapes. If ensureDocumentDraftUuid / ensureTaskDraftUuid
 * are exported in the future, direct tests should be added.
 */

import { describe, it, expect } from "vitest";
import type {
  DocumentDraft,
  TaskDraft,
  DocumentDraftInput,
  TaskDraftInput,
  AcceptanceCriteriaItem,
  ValidationIssue,
  ValidationResult,
} from "@/services/proposal.service";

// ===== Draft type contracts =====

describe("proposal draft type contracts", () => {
  it("DocumentDraft requires uuid, type, title, content", () => {
    const draft: DocumentDraft = {
      uuid: "doc-uuid-1",
      type: "prd",
      title: "Product Requirements",
      content: "This is the PRD content...",
    };
    expect(draft.uuid).toBe("doc-uuid-1");
    expect(draft.type).toBe("prd");
  });

  it("DocumentDraftInput allows uuid to be optional", () => {
    const input: DocumentDraftInput = {
      type: "tech_design",
      title: "Tech Design",
      content: "Technical design document...",
    };
    expect(input.uuid).toBeUndefined();
  });

  it("DocumentDraftInput allows uuid to be provided", () => {
    const input: DocumentDraftInput = {
      uuid: "my-uuid",
      type: "prd",
      title: "PRD",
      content: "Content...",
    };
    expect(input.uuid).toBe("my-uuid");
  });

  it("TaskDraft requires uuid and title", () => {
    const draft: TaskDraft = {
      uuid: "task-uuid-1",
      title: "Implement feature X",
    };
    expect(draft.uuid).toBe("task-uuid-1");
    expect(draft.title).toBe("Implement feature X");
  });

  it("TaskDraft optional fields", () => {
    const draft: TaskDraft = {
      uuid: "task-uuid-2",
      title: "Task with all fields",
      description: "Full description",
      storyPoints: 5,
      priority: "high",
      acceptanceCriteria: "- [ ] Criterion 1",
      acceptanceCriteriaItems: [
        { description: "It works", required: true },
        { description: "It looks good" },
      ],
      dependsOnDraftUuids: ["task-uuid-1"],
    };
    expect(draft.storyPoints).toBe(5);
    expect(draft.dependsOnDraftUuids).toHaveLength(1);
    expect(draft.acceptanceCriteriaItems).toHaveLength(2);
  });

  it("TaskDraftInput allows uuid to be optional", () => {
    const input: TaskDraftInput = {
      title: "New task",
      description: "Task description",
    };
    expect(input.uuid).toBeUndefined();
  });

  it("AcceptanceCriteriaItem requires description, optional required flag", () => {
    const item1: AcceptanceCriteriaItem = { description: "Must pass tests" };
    expect(item1.required).toBeUndefined();

    const item2: AcceptanceCriteriaItem = { description: "Nice to have", required: false };
    expect(item2.required).toBe(false);
  });
});

// ===== Validation types =====

describe("proposal validation types", () => {
  it("ValidationIssue has id, level, message, and optional field", () => {
    const issue: ValidationIssue = {
      id: "E1",
      level: "error",
      message: "Missing PRD",
    };
    expect(issue.field).toBeUndefined();

    const issueWithField: ValidationIssue = {
      id: "W2",
      level: "warning",
      message: "Missing description",
      field: "Task 1",
    };
    expect(issueWithField.field).toBe("Task 1");
  });

  it("ValidationResult has valid boolean and issues array", () => {
    const result: ValidationResult = {
      valid: true,
      issues: [],
    };
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("ValidationResult with errors", () => {
    const result: ValidationResult = {
      valid: false,
      issues: [
        { id: "E1", level: "error", message: "Missing PRD" },
        { id: "W1", level: "warning", message: "No tech design" },
        { id: "I1", level: "info", message: "No priority set", field: "Task 1" },
      ],
    };
    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(3);
    expect(result.issues.filter((i) => i.level === "error")).toHaveLength(1);
  });
});
