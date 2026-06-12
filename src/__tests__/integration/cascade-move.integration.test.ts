// src/__tests__/integration/cascade-move.integration.test.ts
//
// Integration checkpoint for the cross-project Idea cascade move (service layer).
//
// Scope (per AC item #6 of task 7a819820): drive the full AI-DLC pipeline tail
// — idea → proposal → admin approve → materialize → moveIdea — and assert
// every entity's `projectUuid` is updated and the returned `moved` counts are
// accurate.
//
// We don't spin up a real Postgres for unit-suite speed; instead we stand up
// an in-memory prisma stub that satisfies just the operations moveIdea +
// moveIdeaPreview perform: findFirst / findMany / update / updateMany / count
// + $transaction passthrough. The store and stubs are pulled from the shared
// fixture helper in src/__tests__/fixtures/cascadeMoveFixture.ts so the MCP
// and REST integration tests can build the same scenarios.
//
// What this catches:
//   - Idea, Proposal (any status), Document, Task, and Activity rows are all
//     reprojected to the target projectUuid.
//   - The returned `moved` counts equal each updateMany().count.
//   - Cross-company isolation: a same-uuid Proposal in another company is
//     untouched.
//   - Tables that the spec forbids touching (Comment, TaskDependency,
//     AcceptanceCriterion, AgentSession, SessionTaskCheckin, Notification)
//     stay byte-identical pre/post move.

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  cascadeMoveStore,
  resetCascadeMoveStore,
  buildMockPrisma,
  buildActivityServiceMock,
  seedFullPipelineFixture,
  FULL_COMPANY_A,
  FULL_COMPANY_B,
  FULL_P_NEW,
  FULL_IDEA_UUID,
  FULL_PROP_APPROVED,
  FULL_PROP_DRAFT,
  FULL_PROP_REJECTED,
  FULL_DOC_UUID,
  FULL_TASK_1,
  FULL_TASK_2,
  FULL_TASK_3,
} from "@/__tests__/fixtures/cascadeMoveFixture";

// vi.mock factories are hoisted above all imports/declarations, so the
// references inside them must come from vi.hoisted() — anything else triggers
// "Cannot access X before initialization".
const { hoistedPrisma, hoistedActivity } = vi.hoisted(() => ({
  hoistedPrisma: { current: null as unknown },
  hoistedActivity: { current: null as unknown },
}));

const mockPrisma = buildMockPrisma();
const mockActivityService = buildActivityServiceMock(FULL_COMPANY_A);
hoistedPrisma.current = mockPrisma;
hoistedActivity.current = mockActivityService;

// ===== Module mocks =====

vi.mock("@/lib/prisma", () => ({
  // The hoisted ref starts null at top-of-file but gets a value before any
  // import of @/lib/prisma is consumed (top-level await semantics in vitest).
  // moveIdea / moveIdeaPreview only read the export when their service body
  // runs, by which time hoistedPrisma.current === mockPrisma.
  get prisma() {
    return hoistedPrisma.current;
  },
}));
vi.mock("@/lib/event-bus", () => ({ eventBus: { emitChange: vi.fn() } }));
vi.mock("@/lib/uuid-resolver", () => ({
  formatAssigneeComplete: vi.fn().mockResolvedValue(null),
  formatCreatedBy: vi.fn().mockResolvedValue({ type: "user", uuid: "creator", name: "Creator" }),
}));
vi.mock("@/services/mention.service", () => ({
  parseMentions: vi.fn().mockReturnValue([]),
  createMentions: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/services/activity.service", () => ({
  get createActivity() {
    return (hoistedActivity.current as { createActivity: unknown }).createActivity;
  },
}));

import { moveIdea, moveIdeaPreview } from "@/services/idea.service";

// ===== Tests =====

beforeEach(() => {
  resetCascadeMoveStore();
  // Don't clearAllMocks here — that would wipe the activity-service mock
  // implementation and break createActivity's append-to-store side effect.
});

describe("cross-project Idea cascade move (integration)", () => {
  it("flips projectUuid for Idea + every approved-proposal-derived entity and returns accurate counts", async () => {
    seedFullPipelineFixture();

    // ----- preview -----
    const preview = await moveIdeaPreview(FULL_COMPANY_A, FULL_IDEA_UUID, FULL_P_NEW);
    // 1 idea (no lineage descendants in this fixture), 3 proposals (approved +
    // draft + rejected), 1 document, 3 tasks, 8 historical activity rows
    // (1 idea + 3 proposals + 1 document + 3 tasks).
    expect(preview.moved).toEqual({ ideas: 1, proposals: 3, documents: 1, tasks: 3, activities: 8 });

    // ----- real move -----
    const result = await moveIdea(FULL_COMPANY_A, FULL_IDEA_UUID, FULL_P_NEW, "user-1", "user");

    // Counts match the preview exactly (no concurrent writes scenario).
    expect(result.moved).toEqual(preview.moved);

    // Idea row.
    expect(cascadeMoveStore.ideas.find((i) => i.uuid === FULL_IDEA_UUID)?.projectUuid).toBe(FULL_P_NEW);

    // Every linked proposal — regardless of status — flipped to P_NEW.
    for (const p of cascadeMoveStore.proposals.filter(
      (p) => p.companyUuid === FULL_COMPANY_A && p.inputUuids.includes(FULL_IDEA_UUID),
    )) {
      expect(p.projectUuid).toBe(FULL_P_NEW);
    }

    // Document.
    expect(cascadeMoveStore.documents.find((d) => d.uuid === FULL_DOC_UUID)?.projectUuid).toBe(FULL_P_NEW);

    // All three Tasks.
    for (const t of [FULL_TASK_1, FULL_TASK_2, FULL_TASK_3]) {
      expect(cascadeMoveStore.tasks.find((tk) => tk.uuid === t)?.projectUuid).toBe(FULL_P_NEW);
    }

    // Every historical Activity row hit by the cascade is now on P_NEW.
    // Filter out the freshly-emitted "moved" event (action === "moved") since
    // we're asserting the cascade's effect on pre-existing rows here.
    const cascadedActivities = cascadeMoveStore.activities.filter(
      (a) =>
        a.action !== "moved" &&
        ((a.targetType === "idea" && a.targetUuid === FULL_IDEA_UUID) ||
          (a.targetType === "proposal" &&
            [FULL_PROP_APPROVED, FULL_PROP_DRAFT, FULL_PROP_REJECTED].includes(a.targetUuid)) ||
          (a.targetType === "document" && a.targetUuid === FULL_DOC_UUID) ||
          (a.targetType === "task" && [FULL_TASK_1, FULL_TASK_2, FULL_TASK_3].includes(a.targetUuid))),
    );
    expect(cascadedActivities.length).toBe(8);
    for (const a of cascadedActivities) {
      expect(a.projectUuid).toBe(FULL_P_NEW);
    }

    // The "moved" event activity itself is recorded on the new project.
    const moveEvent = cascadeMoveStore.activities.find((a) => a.action === "moved");
    expect(moveEvent).toBeDefined();
    expect(moveEvent!.projectUuid).toBe(FULL_P_NEW);
  });

  it("never touches Comment / TaskDependency / AcceptanceCriterion / AgentSession / SessionTaskCheckin / Notification", async () => {
    seedFullPipelineFixture();

    const beforeSnapshot = {
      comments: JSON.stringify(cascadeMoveStore.comments),
      taskDependencies: JSON.stringify(cascadeMoveStore.taskDependencies),
      acceptanceCriteria: JSON.stringify(cascadeMoveStore.acceptanceCriteria),
      agentSessions: JSON.stringify(cascadeMoveStore.agentSessions),
      sessionTaskCheckins: JSON.stringify(cascadeMoveStore.sessionTaskCheckins),
      notifications: JSON.stringify(cascadeMoveStore.notifications),
    };

    await moveIdea(FULL_COMPANY_A, FULL_IDEA_UUID, FULL_P_NEW, "user-1", "user");

    expect(JSON.stringify(cascadeMoveStore.comments)).toBe(beforeSnapshot.comments);
    expect(JSON.stringify(cascadeMoveStore.taskDependencies)).toBe(beforeSnapshot.taskDependencies);
    expect(JSON.stringify(cascadeMoveStore.acceptanceCriteria)).toBe(beforeSnapshot.acceptanceCriteria);
    expect(JSON.stringify(cascadeMoveStore.agentSessions)).toBe(beforeSnapshot.agentSessions);
    expect(JSON.stringify(cascadeMoveStore.sessionTaskCheckins)).toBe(beforeSnapshot.sessionTaskCheckins);
    expect(JSON.stringify(cascadeMoveStore.notifications)).toBe(beforeSnapshot.notifications);

    // And the Task assignee fields on the migrated tasks are preserved.
    for (const t of [FULL_TASK_1, FULL_TASK_2, FULL_TASK_3]) {
      const row = cascadeMoveStore.tasks.find((tk) => tk.uuid === t)!;
      expect(row.assigneeType).toBe("agent");
      expect(row.assigneeUuid).toBe("agent-1");
    }
  });

  it("preserves cross-company isolation — a same-uuid Proposal in another company is untouched", async () => {
    seedFullPipelineFixture();

    const foreign = cascadeMoveStore.proposals.find((p) => p.companyUuid === FULL_COMPANY_B)!;
    const foreignBefore = JSON.stringify(foreign);

    const result = await moveIdea(FULL_COMPANY_A, FULL_IDEA_UUID, FULL_P_NEW, "user-1", "user");

    // Foreign-company row is byte-equal pre/post.
    expect(JSON.stringify(cascadeMoveStore.proposals.find((p) => p.companyUuid === FULL_COMPANY_B)!)).toBe(
      foreignBefore,
    );
    // And foreign row is NOT counted in `moved.proposals` (only the 3 from COMPANY_A).
    expect(result.moved.proposals).toBe(3);
  });
});
