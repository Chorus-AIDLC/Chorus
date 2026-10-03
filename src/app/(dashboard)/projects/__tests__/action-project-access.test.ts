// Behavioural coverage for project-level access in dashboard server actions.
// Drives the REAL project-access.service (and the server-action adapter in
// @/lib/project-access-action) against an in-memory @/lib/prisma fixture so the
// actual level resolution is exercised; only the business services are mocked.
//
// For one representative mutating action per entity type we prove, on a
// private project:
//   viewer     → { success:false, error:"Insufficient project access" }, no mutation
//   non-member → { success:false, error:"<Entity> not found" }, no mutation
//   editor     → success, mutation called
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AuthContext } from "@/types/auth";

// ===== In-memory prisma fixture (project / membership / entity → project) =====
const db = vi.hoisted(() => ({
  projects: [] as { uuid: string; companyUuid: string; name: string; visibility: string }[],
  members: [] as { projectUuid: string; userUuid: string; companyUuid: string; role: string }[],
  entities: {} as Record<string, { uuid: string; companyUuid: string; projectUuid: string }[]>,
  comments: [] as { uuid: string; companyUuid: string; targetType: string; targetUuid: string }[],
}));

const mockPrisma = vi.hoisted(() => {
  const entityFinder = (type: string) => ({
    findFirst: async ({ where }: { where: { uuid: string; companyUuid: string } }) => {
      const e = (db.entities[type] ?? []).find(
        (x) => x.uuid === where.uuid && x.companyUuid === where.companyUuid,
      );
      return e ? { projectUuid: e.projectUuid } : null;
    },
  });
  return {
    user: { findFirst: vi.fn(async () => null) },
    project: {
      findFirst: async ({ where }: { where: { uuid: string; companyUuid: string } }) => {
        const p = db.projects.find((x) => x.uuid === where.uuid && x.companyUuid === where.companyUuid);
        return p ? { ...p, uuid: p.uuid } : null;
      },
    },
    projectMember: {
      findFirst: vi.fn(async ({ where }: { where: { companyUuid: string; projectUuid: string; role: string } }) =>
        db.members.find((member) => member.companyUuid === where.companyUuid &&
          member.projectUuid === where.projectUuid && member.role === where.role) ?? null),
      findUnique: async ({
        where,
      }: {
        where: { companyUuid: string; projectUuid_userUuid: { projectUuid: string; userUuid: string } };
      }) => {
        const k = where.projectUuid_userUuid;
        const m = db.members.find((x) => x.companyUuid === where.companyUuid && x.projectUuid === k.projectUuid && x.userUuid === k.userUuid);
        return m ? { role: m.role } : null;
      },
    },
    idea: entityFinder("idea"),
    task: entityFinder("task"),
    proposal: entityFinder("proposal"),
    document: entityFinder("document"),
    comment: {
      findFirst: async ({ where }: { where: { uuid: string; companyUuid: string } }) => {
        const c = db.comments.find((x) => x.uuid === where.uuid && x.companyUuid === where.companyUuid);
        return c ? { targetType: c.targetType, targetUuid: c.targetUuid } : null;
      },
    },
  };
});
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

// ===== Auth =====
const authState = vi.hoisted(() => ({ current: null as AuthContext | null }));
// Fresh object per call so the per-request access cache never leaks across cases.
vi.mock("@/lib/auth-server", () => ({
  getServerAuthContext: vi.fn(async () => (authState.current ? { ...authState.current } : null)),
}));

// ===== Business services (mocked) =====
const svc = vi.hoisted(() => ({
  // task
  getTaskByUuid: vi.fn(),
  updateTask: vi.fn(),
  // idea
  updateIdea: vi.fn(),
  createIdea: vi.fn(),
  // proposal
  getProposalByUuid: vi.fn(),
  approveProposal: vi.fn(),
  // document
  getDocumentByUuid: vi.fn(),
  updateDocument: vi.fn(),
  // comment
  createComment: vi.fn(),
  deleteComment: vi.fn(),
  resolveProjectUuid: vi.fn(),
  resolveAgentOwners: vi.fn(),
  // reference
  createReference: vi.fn(),
  getReference: vi.fn(),
  deleteReference: vi.fn(),
  // project
  updateProject: vi.fn(),
  deleteProject: vi.fn(),
  // shared
  createActivity: vi.fn(),
}));

vi.mock("@/services/task.service", () => ({
  getTaskByUuid: svc.getTaskByUuid,
  updateTask: svc.updateTask,
  listTasks: vi.fn(),
  getProjectTaskDependencies: vi.fn(),
  checkDependenciesResolved: vi.fn(),
  checkAcceptanceCriteriaGate: vi.fn(),
}));
vi.mock("@/services/idea.service", () => ({
  updateIdea: svc.updateIdea,
  createIdea: svc.createIdea,
  listIdeas: vi.fn(),
  deleteIdea: vi.fn(),
}));
vi.mock("@/services/proposal.service", () => ({
  getProposalByUuid: svc.getProposalByUuid,
  approveProposal: svc.approveProposal,
  checkIdeasAvailability: vi.fn(),
  rejectProposal: vi.fn(),
  closeProposal: vi.fn(),
  revokeProposal: vi.fn(),
  submitProposal: vi.fn(),
  deleteProposal: vi.fn(),
  addDocumentDraft: vi.fn(),
  addTaskDraft: vi.fn(),
  updateDocumentDraft: vi.fn(),
  updateTaskDraft: vi.fn(),
  removeDocumentDraft: vi.fn(),
  removeTaskDraft: vi.fn(),
}));
vi.mock("@/services/document.service", () => ({
  getDocumentByUuid: svc.getDocumentByUuid,
  updateDocument: svc.updateDocument,
}));
vi.mock("@/services/comment.service", () => ({
  createComment: svc.createComment,
  deleteComment: svc.deleteComment,
  resolveProjectUuid: svc.resolveProjectUuid,
  resolveAgentOwners: svc.resolveAgentOwners,
  listComments: vi.fn(),
  batchCommentCounts: vi.fn(),
}));
vi.mock("@/services/reference-artifact.service", () => ({
  REFERENCE_TARGET_TYPES: ["proposal", "task", "idea"],
  createReference: svc.createReference,
  getReference: svc.getReference,
  deleteReference: svc.deleteReference,
  updateReference: vi.fn(),
  listReferences: vi.fn(),
}));
vi.mock("@/services/project.service", () => ({
  updateProject: svc.updateProject,
  deleteProject: svc.deleteProject,
  createProject: vi.fn(),
}));
vi.mock("@/services/activity.service", () => ({ createActivity: svc.createActivity }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/logger", () => {
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), child: vi.fn() };
  logger.child.mockReturnValue(logger);
  return { default: logger };
});

import { forceMoveTaskToColumnAction } from "../[uuid]/tasks/actions";
import { createIdeaAction, updateIdeaAction } from "../[uuid]/ideas/actions";
import { approveProposalAction } from "../[uuid]/proposals/[proposalUuid]/actions";
import { updateDocumentAction } from "../[uuid]/documents/[documentUuid]/actions";
import { createCommentAction, deleteCommentAction } from "../comment-actions";
import { createReferenceAction, deleteReferenceAction } from "../[uuid]/references-actions";
import { updateProject, deleteProject } from "@/actions/project";

// ===== Fixture data =====
const C = "company-1";
const as = (userUuid: string) => {
  authState.current = { type: "user", companyUuid: C, actorUuid: userUuid };
};

beforeEach(() => {
  vi.clearAllMocks();
  db.projects = [
    { uuid: "priv", companyUuid: C, name: "Private", visibility: "private" },
    { uuid: "pub", companyUuid: C, name: "Public", visibility: "public" },
  ];
  db.members = [
    { projectUuid: "priv", userUuid: "u-admin", companyUuid: C, role: "admin" },
    { projectUuid: "priv", userUuid: "u-editor", companyUuid: C, role: "editor" },
    { projectUuid: "priv", userUuid: "u-viewer", companyUuid: C, role: "viewer" },
    { projectUuid: "pub", userUuid: "u-admin", companyUuid: C, role: "admin" },
  ];
  db.entities = {
    task: [
      { uuid: "t-priv", companyUuid: C, projectUuid: "priv" },
      { uuid: "t-pub", companyUuid: C, projectUuid: "pub" },
    ],
    idea: [{ uuid: "i-priv", companyUuid: C, projectUuid: "priv" }],
    proposal: [{ uuid: "p-priv", companyUuid: C, projectUuid: "priv" }],
    document: [{ uuid: "d-priv", companyUuid: C, projectUuid: "priv" }],
  };
  db.comments = [{ uuid: "c-priv", companyUuid: C, targetType: "task", targetUuid: "t-priv" }];

  svc.getTaskByUuid.mockImplementation(async (_c: string, uuid: string) => ({
    uuid,
    status: "open",
    projectUuid: uuid === "t-pub" ? "pub" : "priv",
  }));
  svc.updateTask.mockResolvedValue({});
  svc.updateIdea.mockResolvedValue({ uuid: "i-priv" });
  svc.createIdea.mockResolvedValue({ uuid: "i-new" });
  svc.getProposalByUuid.mockResolvedValue({ uuid: "p-priv", status: "pending", projectUuid: "priv" });
  svc.approveProposal.mockResolvedValue({});
  svc.getDocumentByUuid.mockResolvedValue({ uuid: "d-priv", projectUuid: "priv" });
  svc.updateDocument.mockResolvedValue({});
  svc.createComment.mockResolvedValue({ uuid: "c-new" });
  svc.deleteComment.mockResolvedValue(undefined);
  svc.resolveProjectUuid.mockResolvedValue("priv");
  svc.resolveAgentOwners.mockImplementation(async (rows: unknown[]) => rows);
  svc.createReference.mockResolvedValue({ uuid: "r-new" });
  svc.getReference.mockResolvedValue({ uuid: "r-priv", targetType: "task", targetUuid: "t-priv" });
  svc.deleteReference.mockResolvedValue(undefined);
  svc.updateProject.mockResolvedValue({ uuid: "priv" });
  svc.deleteProject.mockResolvedValue(true);
  svc.createActivity.mockResolvedValue({});
});

interface Case {
  entity: string;
  run: () => Promise<{ success: boolean; error?: unknown }>;
  mutation: ReturnType<typeof vi.fn>;
  notFound: string;
}

const cases: Case[] = [
  {
    entity: "task (forceMoveTaskToColumnAction)",
    run: () => forceMoveTaskToColumnAction("t-priv", "done"),
    mutation: svc.updateTask,
    notFound: "Task not found",
  },
  {
    entity: "idea (updateIdeaAction)",
    run: () => updateIdeaAction({ ideaUuid: "i-priv", projectUuid: "priv", title: "T", content: null }),
    mutation: svc.updateIdea,
    notFound: "Idea not found",
  },
  {
    entity: "idea create (createIdeaAction)",
    run: () => createIdeaAction({ projectUuid: "priv", title: "New" }),
    mutation: svc.createIdea,
    notFound: "Project not found",
  },
  {
    entity: "proposal (approveProposalAction)",
    run: () => approveProposalAction("p-priv"),
    mutation: svc.approveProposal,
    notFound: "Proposal not found",
  },
  {
    entity: "document (updateDocumentAction)",
    run: () => updateDocumentAction("d-priv", "priv", "content"),
    mutation: svc.updateDocument,
    notFound: "Document not found",
  },
  {
    entity: "comment create (createCommentAction)",
    run: () => createCommentAction("task", "t-priv", "hello"),
    mutation: svc.createComment,
    notFound: "Task not found",
  },
  {
    entity: "comment delete (deleteCommentAction)",
    run: () => deleteCommentAction("c-priv"),
    mutation: svc.deleteComment,
    notFound: "Comment not found",
  },
  {
    entity: "reference create (createReferenceAction)",
    run: () =>
      createReferenceAction({
        targetType: "task",
        targetUuid: "t-priv",
        type: "docs",
        url: "https://example.com",
        title: "Ref",
      }),
    mutation: svc.createReference,
    notFound: "Task not found",
  },
  {
    entity: "reference delete (deleteReferenceAction)",
    run: () => deleteReferenceAction("r-priv"),
    mutation: svc.deleteReference,
    notFound: "Reference not found",
  },
];

describe.each(cases)("private project: $entity", ({ run, mutation, notFound }) => {
  it("rejects a viewer with Insufficient project access and does not mutate", async () => {
    as("u-viewer");
    const result = await run();
    expect(result).toEqual({ success: false, error: "Insufficient project access" });
    expect(mutation).not.toHaveBeenCalled();
  });

  it("rejects a non-member as not found and does not mutate", async () => {
    as("u-outsider");
    const result = await run();
    expect(result).toEqual({ success: false, error: notFound });
    expect(mutation).not.toHaveBeenCalled();
  });

  it("lets an editor through", async () => {
    as("u-editor");
    const result = await run();
    expect(result.success).toBe(true);
    expect(mutation).toHaveBeenCalledTimes(1);
  });
});

describe("project settings (manage_project)", () => {
  it("private: viewer and editor are rejected, admin succeeds", async () => {
    as("u-viewer");
    expect(await updateProject("priv", { name: "x" })).toEqual({
      success: false,
      error: "Only project admins can manage this project",
    });
    as("u-editor");
    expect(await updateProject("priv", { name: "x" })).toEqual({
      success: false,
      error: "Only project admins can manage this project",
    });
    expect(await deleteProject("priv")).toEqual({
      success: false,
      error: "Only project admins can manage this project",
    });
    expect(svc.updateProject).not.toHaveBeenCalled();
    expect(svc.deleteProject).not.toHaveBeenCalled();

    as("u-admin");
    expect(await updateProject("priv", { name: "x" })).toEqual({ success: true, data: { uuid: "priv" } });
    expect(svc.updateProject).toHaveBeenCalledTimes(1);
  });

  it("private: a non-member gets Project not found", async () => {
    as("u-outsider");
    expect(await updateProject("priv", { name: "x" })).toEqual({ success: false, error: "Project not found" });
    expect(await deleteProject("priv")).toEqual({ success: false, error: "Project not found" });
    expect(svc.updateProject).not.toHaveBeenCalled();
    expect(svc.deleteProject).not.toHaveBeenCalled();
  });

  it("public: any company member may still edit settings (unchanged behaviour)", async () => {
    as("u-outsider");
    svc.updateProject.mockResolvedValue({ uuid: "pub" });
    expect(await updateProject("pub", { name: "x" })).toEqual({ success: true, data: { uuid: "pub" } });
  });
});

describe("public projects keep today's behaviour", () => {
  it("a non-member can still mutate a task in a public project", async () => {
    as("u-outsider");
    const result = await forceMoveTaskToColumnAction("t-pub", "done");
    expect(result).toEqual({ success: true });
    expect(svc.updateTask).toHaveBeenCalledWith("t-pub", { status: "done" });
  });
});
