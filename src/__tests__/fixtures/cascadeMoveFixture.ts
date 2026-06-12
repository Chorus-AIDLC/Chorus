// src/__tests__/fixtures/cascadeMoveFixture.ts
//
// Shared in-memory Prisma stub + fixture seeder for the cross-project Idea
// cascade-move integration tests. Used by:
//   - src/__tests__/integration/cascade-move.integration.test.ts (service)
//   - src/mcp/__tests__/move-idea.integration.test.ts (MCP path)
//   - src/app/api/ideas/[uuid]/move/__tests__/integration.test.ts (REST path)
//
// All three surfaces hit `moveIdea` in src/services/idea.service.ts, so they
// share one mock prisma + store. The same store is reset between tests via
// `resetCascadeMoveStore()`.
//
// The default `buildCascadeMoveFixture()` matches the AC for the integration
// checkpoint task: 1 Idea I + 1 approved Proposal R + 1 Document D + 3 Tasks
// (T1→T2 dependency) + ≥5 Activities + 1 sibling Idea S in the same project
// whose proposals/documents/tasks must NOT be touched. Expected `moved`:
// { proposals: 1, documents: 1, tasks: 3, activities: 5 }.
//
// The richer "full pipeline" fixture (3 proposals across statuses, foreign-
// company isolation probe, etc.) lives in `seedFullPipelineFixture` for the
// service-level integration test that asserts spec-mandated behaviors beyond
// the cross-surface count check.

import { vi } from "vitest";

// ===== Row types =====

export type IdeaRow = {
  uuid: string;
  companyUuid: string;
  projectUuid: string;
  title: string;
  content: string | null;
  attachments: unknown;
  status: string;
  elaborationStatus: string | null;
  elaborationDepth: string | null;
  assigneeType: string | null;
  assigneeUuid: string | null;
  assignedAt: Date | null;
  assignedByUuid: string | null;
  createdByUuid: string;
  createdAt: Date;
  updatedAt: Date;
};

export type ProposalRow = {
  uuid: string;
  companyUuid: string;
  projectUuid: string;
  title: string;
  description: string | null;
  inputType: string;
  inputUuids: string[];
  documentDrafts: Array<{ draftUuid: string; type: string; title: string; content: string }> | null;
  taskDrafts: Array<{ draftUuid: string; title: string; description: string }> | null;
  status: string;
  createdByUuid: string;
  createdByType: string;
  reviewedByUuid: string | null;
  reviewNote: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type DocumentRow = {
  uuid: string;
  companyUuid: string;
  projectUuid: string;
  type: string;
  title: string;
  content: string | null;
  version: number;
  proposalUuid: string | null;
  createdByUuid: string;
  createdAt: Date;
  updatedAt: Date;
};

export type TaskRow = {
  uuid: string;
  companyUuid: string;
  projectUuid: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  storyPoints: number | null;
  acceptanceCriteria: string | null;
  assigneeType: string | null;
  assigneeUuid: string | null;
  assignedAt: Date | null;
  assignedByUuid: string | null;
  proposalUuid: string | null;
  createdByUuid: string;
  createdAt: Date;
  updatedAt: Date;
};

export type ActivityRow = {
  uuid: string;
  companyUuid: string;
  projectUuid: string;
  targetType: string;
  targetUuid: string;
  actorType: string;
  actorUuid: string;
  action: string;
  value: unknown;
  sessionUuid: string | null;
  sessionName: string | null;
  createdAt: Date;
};

export type CommentRow = {
  uuid: string;
  companyUuid: string;
  targetType: string;
  targetUuid: string;
  content: string;
  authorType: string;
  authorUuid: string;
  createdAt: Date;
  updatedAt: Date;
};

export type TaskDependencyRow = {
  taskUuid: string;
  dependsOnUuid: string;
  createdAt: Date;
};

export type AcceptanceCriterionRow = {
  uuid: string;
  taskUuid: string;
  description: string;
  required: boolean;
  devStatus: string;
  status: string;
  sortOrder: number;
};

export type AgentSessionRow = {
  uuid: string;
  companyUuid: string;
  agentUuid: string;
  name: string;
  status: string;
};

export type SessionTaskCheckinRow = {
  sessionUuid: string;
  taskUuid: string;
  checkedInAt: Date;
};

export type NotificationRow = {
  uuid: string;
  companyUuid: string;
  recipientUuid: string;
  entityType: string;
  entityUuid: string;
  read: boolean;
};

export interface CascadeMoveStore {
  ideas: IdeaRow[];
  proposals: ProposalRow[];
  documents: DocumentRow[];
  tasks: TaskRow[];
  activities: ActivityRow[];
  projects: Array<{ uuid: string; companyUuid: string; name: string }>;
  comments: CommentRow[];
  taskDependencies: TaskDependencyRow[];
  acceptanceCriteria: AcceptanceCriterionRow[];
  agentSessions: AgentSessionRow[];
  sessionTaskCheckins: SessionTaskCheckinRow[];
  notifications: NotificationRow[];
}

// Single in-memory store reused across all integration tests in this module.
// Tests must call `resetCascadeMoveStore()` in beforeEach.
export const cascadeMoveStore: CascadeMoveStore = {
  ideas: [],
  proposals: [],
  documents: [],
  tasks: [],
  activities: [],
  projects: [],
  comments: [],
  taskDependencies: [],
  acceptanceCriteria: [],
  agentSessions: [],
  sessionTaskCheckins: [],
  notifications: [],
};

export function resetCascadeMoveStore() {
  cascadeMoveStore.ideas = [];
  cascadeMoveStore.proposals = [];
  cascadeMoveStore.documents = [];
  cascadeMoveStore.tasks = [];
  cascadeMoveStore.activities = [];
  cascadeMoveStore.projects = [];
  cascadeMoveStore.comments = [];
  cascadeMoveStore.taskDependencies = [];
  cascadeMoveStore.acceptanceCriteria = [];
  cascadeMoveStore.agentSessions = [];
  cascadeMoveStore.sessionTaskCheckins = [];
  cascadeMoveStore.notifications = [];
}

// ===== Where-clause matcher =====
//
// Supports the operators moveIdea / moveIdeaPreview actually use:
//   eq scalar, in: [], array_contains: [v], OR: [...].

type WhereOp = Record<string, unknown> | undefined;

export function matchesWhere(row: Record<string, unknown>, where: WhereOp): boolean {
  if (!where) return true;
  for (const [key, expected] of Object.entries(where)) {
    if (key === "OR") {
      const branches = expected as Record<string, unknown>[];
      if (!branches.some((b) => matchesWhere(row, b))) return false;
      continue;
    }
    const actual = row[key];
    if (expected === null || typeof expected !== "object") {
      if (actual !== expected) return false;
      continue;
    }
    const op = expected as Record<string, unknown>;
    if ("in" in op) {
      const list = op.in as unknown[];
      if (!list.includes(actual)) return false;
      continue;
    }
    if ("array_contains" in op) {
      const needle = (op.array_contains as unknown[])[0];
      if (!Array.isArray(actual) || !actual.includes(needle)) return false;
      continue;
    }
    // Unknown operator: treat as scalar equality on the raw object.
    if (actual !== expected) return false;
  }
  return true;
}

export function makeModel<T extends { uuid?: string }>(
  getRows: () => T[],
  opts: { hydrateProject?: boolean } = {}
) {
  // Resolve `include: { project }` against the projects table so the service
  // can read `idea.project!.name` exactly as it does against real Prisma.
  const hydrate = (row: T | null, include: Record<string, unknown> | undefined) => {
    if (!row || !include || !opts.hydrateProject || !("project" in include)) return row;
    const projectUuid = (row as unknown as Record<string, string>).projectUuid;
    const project = cascadeMoveStore.projects.find((p) => p.uuid === projectUuid);
    return { ...row, project };
  };

  return {
    findFirst: vi.fn(async ({ where, include }: { where?: WhereOp; include?: Record<string, unknown> } = {}) => {
      const row = getRows().find((r) => matchesWhere(r as unknown as Record<string, unknown>, where)) ?? null;
      return hydrate(row, include);
    }),
    findMany: vi.fn(async ({ where }: { where?: WhereOp } = {}) => {
      return getRows().filter((r) => matchesWhere(r as unknown as Record<string, unknown>, where));
    }),
    update: vi.fn(async ({ where, data }: { where: WhereOp; data: Record<string, unknown> }) => {
      const row = getRows().find((r) => matchesWhere(r as unknown as Record<string, unknown>, where));
      if (!row) throw new Error("Row not found");
      Object.assign(row as unknown as Record<string, unknown>, data);
      return row;
    }),
    updateMany: vi.fn(async ({ where, data }: { where?: WhereOp; data: Record<string, unknown> }) => {
      const matched = getRows().filter((r) => matchesWhere(r as unknown as Record<string, unknown>, where));
      for (const r of matched) Object.assign(r as unknown as Record<string, unknown>, data);
      return { count: matched.length };
    }),
    count: vi.fn(async ({ where }: { where?: WhereOp } = {}) => {
      return getRows().filter((r) => matchesWhere(r as unknown as Record<string, unknown>, where)).length;
    }),
  };
}

// ===== Mock prisma builder =====
//
// All three integration tests share this stub. The service body reads `prisma`
// at call time, so each test file's vi.mock("@/lib/prisma", ...) just returns
// this object (or a getter for it).

export function buildMockPrisma() {
  const ideaModel = makeModel<IdeaRow>(() => cascadeMoveStore.ideas, { hydrateProject: true });
  const proposalModel = makeModel<ProposalRow>(() => cascadeMoveStore.proposals);
  const documentModel = makeModel<DocumentRow>(() => cascadeMoveStore.documents);
  const taskModel = makeModel<TaskRow>(() => cascadeMoveStore.tasks);
  const activityModel = makeModel<ActivityRow>(() => cascadeMoveStore.activities);
  const projectModel = makeModel(() => cascadeMoveStore.projects);

  const mockPrisma = {
    idea: ideaModel,
    proposal: proposalModel,
    document: documentModel,
    task: taskModel,
    activity: activityModel,
    project: projectModel,
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      return await fn(mockPrisma);
    }),
  };

  return mockPrisma;
}

// ===== Default fixture (AC scenario) =====
//
// 1 Idea + 1 approved Proposal + 1 Document + 3 Tasks (T1→T2 dependency) +
// 5 Activity rows + 1 sibling Idea (with its own approved proposal +
// document + task) in the same project.
//
// Expected `moved` after `moveIdea(I, P_new)`:
//   { proposals: 1, documents: 1, tasks: 3, activities: 5 }
//
// The sibling idea's resources MUST stay on P_OLD (the move only follows
// the moved idea's inputUuids match).

export const COMPANY_UUID = "00000000-0000-4000-8000-000000000001";
export const P_OLD = "10000000-0000-4000-8000-000000000001";
export const P_NEW = "10000000-0000-4000-8000-000000000002";

export const FIXTURE_IDEA_UUID = "20000000-0000-4000-8000-000000000001";
export const FIXTURE_PROPOSAL_UUID = "30000000-0000-4000-8000-000000000001";
export const FIXTURE_DOC_UUID = "40000000-0000-4000-8000-000000000001";
export const FIXTURE_TASK_1 = "50000000-0000-4000-8000-000000000001";
export const FIXTURE_TASK_2 = "50000000-0000-4000-8000-000000000002";
export const FIXTURE_TASK_3 = "50000000-0000-4000-8000-000000000003";

export const SIBLING_IDEA_UUID = "20000000-0000-4000-8000-000000000099";
export const SIBLING_PROPOSAL_UUID = "30000000-0000-4000-8000-000000000099";
export const SIBLING_DOC_UUID = "40000000-0000-4000-8000-000000000099";
export const SIBLING_TASK_UUID = "50000000-0000-4000-8000-000000000099";

const ACTOR_USER = "60000000-0000-4000-8000-000000000001";
const AGENT_UUID = "60000000-0000-4000-8000-000000000002";

export interface CascadeMoveFixture {
  companyUuid: string;
  fromProjectUuid: string;
  toProjectUuid: string;
  ideaUuid: string;
  proposalUuid: string;
  documentUuid: string;
  taskUuids: [string, string, string];
  siblingIdeaUuid: string;
  siblingProposalUuid: string;
  siblingDocumentUuid: string;
  siblingTaskUuid: string;
  actorUuid: string;
  /** Expected `moved` counts the move call should return / the UI should display. */
  expectedMoved: { ideas: 1; proposals: 1; documents: 1; tasks: 3; activities: 5 };
  /** Snapshot of sibling-resource UUIDs+projects taken at fixture build time
   *  for cross-fixture isolation assertions. */
  siblingSnapshot: {
    ideaProjectUuid: string;
    proposalProjectUuid: string;
    documentProjectUuid: string;
    taskProjectUuid: string;
  };
}

/**
 * Seed the integration store with the AC fixture described above. The store
 * MUST be reset (via `resetCascadeMoveStore()`) before each call.
 */
export function buildCascadeMoveFixture(): CascadeMoveFixture {
  // Projects
  cascadeMoveStore.projects.push(
    { uuid: P_OLD, companyUuid: COMPANY_UUID, name: "Old Project" },
    { uuid: P_NEW, companyUuid: COMPANY_UUID, name: "New Project" }
  );

  // 1) Primary Idea I in P_OLD.
  cascadeMoveStore.ideas.push({
    uuid: FIXTURE_IDEA_UUID,
    companyUuid: COMPANY_UUID,
    projectUuid: P_OLD,
    title: "Cascade-move integration fixture",
    content: "primary idea body",
    attachments: null,
    status: "elaborated",
    elaborationStatus: "resolved",
    elaborationDepth: "standard",
    assigneeType: "agent",
    assigneeUuid: AGENT_UUID,
    assignedAt: new Date(),
    assignedByUuid: null,
    createdByUuid: ACTOR_USER,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // 2) Single approved Proposal R linked to I.
  cascadeMoveStore.proposals.push({
    uuid: FIXTURE_PROPOSAL_UUID,
    companyUuid: COMPANY_UUID,
    projectUuid: P_OLD,
    title: "Approved proposal",
    description: null,
    inputType: "idea",
    inputUuids: [FIXTURE_IDEA_UUID],
    documentDrafts: null,
    taskDrafts: null,
    status: "approved",
    createdByUuid: AGENT_UUID,
    createdByType: "agent",
    reviewedByUuid: ACTOR_USER,
    reviewNote: null,
    reviewedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // 3) Materialized: 1 Document D linked to R.
  cascadeMoveStore.documents.push({
    uuid: FIXTURE_DOC_UUID,
    companyUuid: COMPANY_UUID,
    projectUuid: P_OLD,
    type: "prd",
    title: "PRD",
    content: "approved doc body",
    version: 1,
    proposalUuid: FIXTURE_PROPOSAL_UUID,
    createdByUuid: AGENT_UUID,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // 4) Materialized: 3 Tasks T1..T3 linked to R, with T1→T2 dependency.
  for (const t of [FIXTURE_TASK_1, FIXTURE_TASK_2, FIXTURE_TASK_3]) {
    cascadeMoveStore.tasks.push({
      uuid: t,
      companyUuid: COMPANY_UUID,
      projectUuid: P_OLD,
      title: `Task ${t}`,
      description: null,
      status: "in_progress",
      priority: "medium",
      storyPoints: 1,
      acceptanceCriteria: null,
      assigneeType: "agent",
      assigneeUuid: AGENT_UUID,
      assignedAt: new Date(),
      assignedByUuid: null,
      proposalUuid: FIXTURE_PROPOSAL_UUID,
      createdByUuid: AGENT_UUID,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
  cascadeMoveStore.taskDependencies.push({
    taskUuid: FIXTURE_TASK_2,
    dependsOnUuid: FIXTURE_TASK_1,
    createdAt: new Date(),
  });

  // 5) Activity stream: exactly 5 historical rows targeting the migrated
  //    entities (1 idea + 1 proposal + 1 document + 2 task events). The AC
  //    requires "≥ 5"; we land on 5 so equality assertions are crisp.
  const seedActivity = (targetType: string, targetUuid: string, action: string) => {
    cascadeMoveStore.activities.push({
      uuid: `act-${targetType}-${targetUuid}-${cascadeMoveStore.activities.length + 1}`,
      companyUuid: COMPANY_UUID,
      projectUuid: P_OLD,
      targetType,
      targetUuid,
      actorType: "agent",
      actorUuid: AGENT_UUID,
      action,
      value: null,
      sessionUuid: null,
      sessionName: null,
      createdAt: new Date(),
    });
  };
  seedActivity("idea", FIXTURE_IDEA_UUID, "created");
  seedActivity("proposal", FIXTURE_PROPOSAL_UUID, "approved");
  seedActivity("document", FIXTURE_DOC_UUID, "created");
  seedActivity("task", FIXTURE_TASK_1, "created");
  seedActivity("task", FIXTURE_TASK_2, "assigned");
  // 5 historical rows total.

  // 6) Sibling Idea S in the SAME project (P_OLD) with its own approved
  //    proposal + document + task. inputUuids does NOT contain
  //    FIXTURE_IDEA_UUID, so the cascade must skip every row below.
  cascadeMoveStore.ideas.push({
    uuid: SIBLING_IDEA_UUID,
    companyUuid: COMPANY_UUID,
    projectUuid: P_OLD,
    title: "Sibling idea (must remain in P_OLD)",
    content: null,
    attachments: null,
    status: "open",
    elaborationStatus: null,
    elaborationDepth: null,
    assigneeType: null,
    assigneeUuid: null,
    assignedAt: null,
    assignedByUuid: null,
    createdByUuid: ACTOR_USER,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  cascadeMoveStore.proposals.push({
    uuid: SIBLING_PROPOSAL_UUID,
    companyUuid: COMPANY_UUID,
    projectUuid: P_OLD,
    title: "Sibling proposal",
    description: null,
    inputType: "idea",
    inputUuids: [SIBLING_IDEA_UUID],
    documentDrafts: null,
    taskDrafts: null,
    status: "approved",
    createdByUuid: AGENT_UUID,
    createdByType: "agent",
    reviewedByUuid: ACTOR_USER,
    reviewNote: null,
    reviewedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  cascadeMoveStore.documents.push({
    uuid: SIBLING_DOC_UUID,
    companyUuid: COMPANY_UUID,
    projectUuid: P_OLD,
    type: "prd",
    title: "Sibling PRD",
    content: null,
    version: 1,
    proposalUuid: SIBLING_PROPOSAL_UUID,
    createdByUuid: AGENT_UUID,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  cascadeMoveStore.tasks.push({
    uuid: SIBLING_TASK_UUID,
    companyUuid: COMPANY_UUID,
    projectUuid: P_OLD,
    title: "Sibling task",
    description: null,
    status: "open",
    priority: "low",
    storyPoints: null,
    acceptanceCriteria: null,
    assigneeType: null,
    assigneeUuid: null,
    assignedAt: null,
    assignedByUuid: null,
    proposalUuid: SIBLING_PROPOSAL_UUID,
    createdByUuid: AGENT_UUID,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return {
    companyUuid: COMPANY_UUID,
    fromProjectUuid: P_OLD,
    toProjectUuid: P_NEW,
    ideaUuid: FIXTURE_IDEA_UUID,
    proposalUuid: FIXTURE_PROPOSAL_UUID,
    documentUuid: FIXTURE_DOC_UUID,
    taskUuids: [FIXTURE_TASK_1, FIXTURE_TASK_2, FIXTURE_TASK_3],
    siblingIdeaUuid: SIBLING_IDEA_UUID,
    siblingProposalUuid: SIBLING_PROPOSAL_UUID,
    siblingDocumentUuid: SIBLING_DOC_UUID,
    siblingTaskUuid: SIBLING_TASK_UUID,
    actorUuid: ACTOR_USER,
    expectedMoved: { ideas: 1, proposals: 1, documents: 1, tasks: 3, activities: 5 },
    siblingSnapshot: {
      ideaProjectUuid: P_OLD,
      proposalProjectUuid: P_OLD,
      documentProjectUuid: P_OLD,
      taskProjectUuid: P_OLD,
    },
  };
}

// ===== Full-pipeline fixture (richer service-level scenario) =====
//
// Used by the existing service-level integration test in
// src/__tests__/integration/cascade-move.integration.test.ts. Exposes 3
// proposals across statuses + cross-company isolation probe + forbidden-
// table fixtures. Counts: proposals=3, documents=1, tasks=3, activities=8.

export const FULL_COMPANY_A = "C_a";
export const FULL_COMPANY_B = "C_b";
export const FULL_P_OLD = "project-old-aaaa-aaaa-aaaaaaaaaaaa";
export const FULL_P_NEW = "project-new-bbbb-bbbb-bbbbbbbbbbbb";
export const FULL_IDEA_UUID = "idea-1111-1111-1111-111111111111";
export const FULL_PROP_APPROVED = "proposal-app-2222-2222-222222222222";
export const FULL_PROP_DRAFT = "proposal-drf-3333-3333-333333333333";
export const FULL_PROP_REJECTED = "proposal-rej-4444-4444-444444444444";
export const FULL_DOC_UUID = "doc-5555-5555-5555-555555555555";
export const FULL_TASK_1 = "task-aaaa-1111-1111-111111111111";
export const FULL_TASK_2 = "task-bbbb-2222-2222-222222222222";
export const FULL_TASK_3 = "task-cccc-3333-3333-333333333333";

export function seedFullPipelineFixture() {
  // Project rows so moveIdea's pre-flight check on the target project passes.
  cascadeMoveStore.projects.push(
    { uuid: FULL_P_OLD, companyUuid: FULL_COMPANY_A, name: "Old Project" },
    { uuid: FULL_P_NEW, companyUuid: FULL_COMPANY_A, name: "New Project" }
  );

  // Stage 1 — createIdea: an idea sits in the old project.
  cascadeMoveStore.ideas.push({
    uuid: FULL_IDEA_UUID,
    companyUuid: FULL_COMPANY_A,
    projectUuid: FULL_P_OLD,
    title: "Cascade Move E2E Idea",
    content: "body",
    attachments: null,
    status: "elaborated",
    elaborationStatus: "resolved",
    elaborationDepth: "standard",
    assigneeType: "agent",
    assigneeUuid: "agent-1",
    assignedAt: new Date(),
    assignedByUuid: null,
    createdByUuid: "user-1",
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // Stage 2 — three proposals across distinct statuses (approved, draft,
  // rejected). The spec demands every status follow the idea, regardless of
  // approval state.
  for (const [uuid, status] of [
    [FULL_PROP_APPROVED, "approved"],
    [FULL_PROP_DRAFT, "draft"],
    [FULL_PROP_REJECTED, "rejected"],
  ] as const) {
    cascadeMoveStore.proposals.push({
      uuid,
      companyUuid: FULL_COMPANY_A,
      projectUuid: FULL_P_OLD,
      title: `Proposal ${status}`,
      description: null,
      inputType: "idea",
      inputUuids: [FULL_IDEA_UUID],
      documentDrafts: null,
      taskDrafts: null,
      status,
      createdByUuid: "agent-1",
      createdByType: "agent",
      reviewedByUuid: status === "approved" ? "user-1" : null,
      reviewNote: null,
      reviewedAt: status === "approved" ? new Date() : null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  // Stage 3 — admin approves: proposal materializes one Document + three Tasks.
  cascadeMoveStore.documents.push({
    uuid: FULL_DOC_UUID,
    companyUuid: FULL_COMPANY_A,
    projectUuid: FULL_P_OLD,
    type: "prd",
    title: "PRD",
    content: "doc body",
    version: 1,
    proposalUuid: FULL_PROP_APPROVED,
    createdByUuid: "agent-1",
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  for (const t of [FULL_TASK_1, FULL_TASK_2, FULL_TASK_3]) {
    cascadeMoveStore.tasks.push({
      uuid: t,
      companyUuid: FULL_COMPANY_A,
      projectUuid: FULL_P_OLD,
      title: `Task ${t}`,
      description: null,
      status: "in_progress",
      priority: "medium",
      storyPoints: 1,
      acceptanceCriteria: null,
      assigneeType: "agent",
      assigneeUuid: "agent-1",
      assignedAt: new Date(),
      assignedByUuid: null,
      proposalUuid: FULL_PROP_APPROVED,
      createdByUuid: "agent-1",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  // Stage 4 — historical activity stream (1 row per entity).
  const seedActivity = (targetType: string, targetUuid: string, action: string) => {
    cascadeMoveStore.activities.push({
      uuid: `act-${targetType}-${targetUuid}`,
      companyUuid: FULL_COMPANY_A,
      projectUuid: FULL_P_OLD,
      targetType,
      targetUuid,
      actorType: "agent",
      actorUuid: "agent-1",
      action,
      value: null,
      sessionUuid: null,
      sessionName: null,
      createdAt: new Date(),
    });
  };
  seedActivity("idea", FULL_IDEA_UUID, "created");
  seedActivity("proposal", FULL_PROP_APPROVED, "approved");
  seedActivity("proposal", FULL_PROP_DRAFT, "created");
  seedActivity("proposal", FULL_PROP_REJECTED, "rejected");
  seedActivity("document", FULL_DOC_UUID, "created");
  seedActivity("task", FULL_TASK_1, "created");
  seedActivity("task", FULL_TASK_2, "created");
  seedActivity("task", FULL_TASK_3, "created");

  // Forbidden-table fixtures: these MUST stay byte-equal post-move.
  cascadeMoveStore.comments.push({
    uuid: "comment-1",
    companyUuid: FULL_COMPANY_A,
    targetType: "task",
    targetUuid: FULL_TASK_1,
    content: "lgtm",
    authorType: "user",
    authorUuid: "user-1",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  cascadeMoveStore.taskDependencies.push({
    taskUuid: FULL_TASK_2,
    dependsOnUuid: FULL_TASK_1,
    createdAt: new Date(),
  });
  cascadeMoveStore.acceptanceCriteria.push({
    uuid: "ac-1",
    taskUuid: FULL_TASK_1,
    description: "must do X",
    required: true,
    devStatus: "passed",
    status: "passed",
    sortOrder: 0,
  });
  cascadeMoveStore.agentSessions.push({
    uuid: "session-1",
    companyUuid: FULL_COMPANY_A,
    agentUuid: "agent-1",
    name: "build session",
    status: "active",
  });
  cascadeMoveStore.sessionTaskCheckins.push({
    sessionUuid: "session-1",
    taskUuid: FULL_TASK_1,
    checkedInAt: new Date(),
  });
  cascadeMoveStore.notifications.push({
    uuid: "notif-1",
    companyUuid: FULL_COMPANY_A,
    recipientUuid: "user-1",
    entityType: "task",
    entityUuid: FULL_TASK_1,
    read: false,
  });

  // Cross-company contamination probe.
  cascadeMoveStore.proposals.push({
    uuid: "proposal-foreign-9999-9999-999999999999",
    companyUuid: FULL_COMPANY_B,
    projectUuid: "project-foreign",
    title: "Foreign company proposal",
    description: null,
    inputType: "idea",
    inputUuids: [FULL_IDEA_UUID],
    documentDrafts: null,
    taskDrafts: null,
    status: "approved",
    createdByUuid: "agent-foreign",
    createdByType: "agent",
    reviewedByUuid: null,
    reviewNote: null,
    reviewedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

// ===== Mock activity-service factory =====
//
// All three integration tests need to mock @/services/activity.service so
// that createActivity appends to cascadeMoveStore.activities (rather than
// hitting a real DB). Each test file calls vi.mock with a hoisted factory;
// this helper produces the shared implementation.

export function buildActivityServiceMock(defaultCompanyUuid?: string) {
  return {
    createActivity: vi.fn(
      async (params: { projectUuid: string; targetType: string; targetUuid: string; action: string; companyUuid?: string }) => {
        cascadeMoveStore.activities.push({
          uuid: `activity-move-${cascadeMoveStore.activities.length + 1}`,
          companyUuid: params.companyUuid ?? defaultCompanyUuid ?? COMPANY_UUID,
          projectUuid: params.projectUuid,
          targetType: params.targetType,
          targetUuid: params.targetUuid,
          actorType: "user",
          actorUuid: "actor-1",
          action: params.action,
          value: null,
          sessionUuid: null,
          sessionName: null,
          createdAt: new Date(),
        });
      }
    ),
  };
}
