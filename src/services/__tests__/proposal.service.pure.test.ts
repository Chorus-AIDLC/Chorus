import { describe, it, expect, vi } from "vitest";

// Mock transitive dependencies
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/generated/prisma/client", () => ({ Prisma: { JsonNull: null } }));
vi.mock("@/lib/event-bus", () => ({ eventBus: { emitChange: vi.fn() } }));
vi.mock("@/lib/uuid-resolver", () => ({ formatCreatedBy: vi.fn(), formatReview: vi.fn() }));
vi.mock("@/services/document.service", () => ({ createDocumentFromProposal: vi.fn() }));
vi.mock("@/services/task.service", () => ({ createTasksFromProposal: vi.fn() }));

import {
  ensureDocumentDraftUuid,
  ensureTaskDraftUuid,
} from "@/services/proposal.service";

// ===== ensureDocumentDraftUuid =====

describe("ensureDocumentDraftUuid", () => {
  it("should preserve existing uuid", () => {
    const draft = { uuid: "my-existing-uuid", type: "prd", title: "Title", content: "Content" };
    const result = ensureDocumentDraftUuid(draft);
    expect(result.uuid).toBe("my-existing-uuid");
  });

  it("should generate uuid when missing", () => {
    const draft = { type: "tech_design", title: "Title", content: "Content" };
    const result = ensureDocumentDraftUuid(draft);
    expect(result.uuid).toBeDefined();
    expect(result.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("should generate unique uuids each time", () => {
    const draft = { type: "prd", title: "Title", content: "Content" };
    const result1 = ensureDocumentDraftUuid(draft);
    const result2 = ensureDocumentDraftUuid(draft);
    expect(result1.uuid).not.toBe(result2.uuid);
  });

  it("should preserve all other fields", () => {
    const draft = { type: "adr", title: "ADR Title", content: "Decision content" };
    const result = ensureDocumentDraftUuid(draft);
    expect(result.type).toBe("adr");
    expect(result.title).toBe("ADR Title");
    expect(result.content).toBe("Decision content");
  });

  it("should not generate uuid when empty string provided", () => {
    // Empty string is falsy, so it should generate a new UUID
    const draft = { uuid: "", type: "prd", title: "T", content: "C" };
    const result = ensureDocumentDraftUuid(draft);
    expect(result.uuid).not.toBe("");
    expect(result.uuid).toMatch(/^[0-9a-f]{8}-/);
  });
});

// ===== ensureTaskDraftUuid =====

describe("ensureTaskDraftUuid", () => {
  it("should preserve existing uuid", () => {
    const draft = { uuid: "task-uuid-123", title: "My Task" };
    const result = ensureTaskDraftUuid(draft);
    expect(result.uuid).toBe("task-uuid-123");
  });

  it("should generate uuid when missing", () => {
    const draft = { title: "New Task" };
    const result = ensureTaskDraftUuid(draft);
    expect(result.uuid).toBeDefined();
    expect(result.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("should preserve all optional fields", () => {
    const draft = {
      title: "Task with details",
      description: "Full description",
      priority: "high",
      storyPoints: 5,
      acceptanceCriteria: "- [ ] Done",
      dependsOnDraftUuids: ["other-uuid"],
    };
    const result = ensureTaskDraftUuid(draft);
    expect(result.title).toBe("Task with details");
    expect(result.description).toBe("Full description");
    expect(result.priority).toBe("high");
    expect(result.storyPoints).toBe(5);
    expect(result.dependsOnDraftUuids).toEqual(["other-uuid"]);
  });

  it("should generate unique uuids each time", () => {
    const draft = { title: "Task" };
    const result1 = ensureTaskDraftUuid(draft);
    const result2 = ensureTaskDraftUuid(draft);
    expect(result1.uuid).not.toBe(result2.uuid);
  });
});
