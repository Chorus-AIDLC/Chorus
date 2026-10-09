// src/app/api/__tests__/entity-routes-access.test.ts
// Private-project access enforcement on entity-scoped REST routes
// (add-private-project-access, Tech Design D2/D4).
//
// The REAL project-access.service makes every access decision against an
// in-memory Prisma fixture; downstream business services are mocked so each
// test only observes the gate:
//   - non-member on a private project → 404 (indistinguishable from missing)
//   - viewer on a private project     → 200 on reads, 403 on writes
//   - editor on a private project     → writes allowed (incl. approve / verify)
//   - non-member on a public project  → unchanged (floored at editor)
// Denied requests must never reach the business service.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { AuthContext } from "@/types/auth";

// ===== In-memory access fixture =====

const db = vi.hoisted(() => ({
  projects: [] as { uuid: string; companyUuid: string; name: string; visibility: string }[],
  members: [] as { projectUuid: string; userUuid: string; companyUuid: string; role: string }[],
  entities: {} as Record<string, { uuid: string; companyUuid: string; projectUuid: string }[]>,
}));

const mockPrisma = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

const entityFinder = (type: string) => ({
  findFirst: vi.fn(async ({ where }: { where: { uuid: string; companyUuid: string } }) => {
    const e = (db.entities[type] ?? []).find((x) => x.uuid === where.uuid && x.companyUuid === where.companyUuid);
    return e ? { projectUuid: e.projectUuid } : null;
  }),
});

Object.assign(mockPrisma, {
  project: {
    findFirst: vi.fn(async ({ where }: { where: { uuid: string; companyUuid: string } }) => {
      const p = db.projects.find((x) => x.uuid === where.uuid && x.companyUuid === where.companyUuid);
      return p ? { ...p } : null;
    }),
  },
  projectMember: {
    findFirst: vi.fn(async ({ where }: { where: { companyUuid: string; projectUuid: string; role: string } }) =>
      db.members.find((m) => m.companyUuid === where.companyUuid && m.projectUuid === where.projectUuid && m.role === where.role) ?? null),
    findUnique: vi.fn(
      async ({ where }: { where: { companyUuid: string; projectUuid_userUuid: { projectUuid: string; userUuid: string } } }) => {
        const k = where.projectUuid_userUuid;
        const m = db.members.find((x) => x.companyUuid === where.companyUuid && x.projectUuid === k.projectUuid && x.userUuid === k.userUuid);
        return m ? { role: m.role } : null;
      },
    ),
  },
  // The matrix's actors are not the earliest company user; lazy Admin behavior
  // has separate real-PostgreSQL acceptance coverage.
  user: { findFirst: vi.fn(async ({ where }: { where: { companyUuid: string } }) =>
    where.companyUuid === "company-1" ? { uuid: "u-first" } : null) },
  idea: entityFinder("idea"),
  task: entityFinder("task"),
  proposal: entityFinder("proposal"),
  document: entityFinder("document"),
  comment: { findFirst: vi.fn(async () => null) },
});

// ===== Auth =====

const authState = vi.hoisted(() => ({ current: null as AuthContext | null }));

vi.mock("@/lib/auth", () => ({
  // Fresh object per request so the per-request access memo never leaks across tests.
  getAuthContext: vi.fn(async () => (authState.current ? { ...authState.current } : null)),
  isUser: (auth: { type: string }) => auth.type === "user",
  isAgent: (auth: { type: string }) => auth.type === "agent",
  isAssignee: vi.fn(async () => true),
  hasPermission: (auth: { permissions?: string[] }, perm: string) => auth.permissions?.includes(perm) ?? false,
  checkAgentPermission: (auth: { type: string; permissions?: string[] }, perm: string) => {
    if (auth.type === "agent" && !(auth.permissions?.includes(perm) ?? false)) {
      return new Response(JSON.stringify({ success: false, error: { message: `Missing permission: ${perm}` } }), {
        status: 403,
      });
    }
    return null;
  },
}));

// ===== Downstream business services (mocked) =====

const svc = vi.hoisted(() => {
  const f = () => vi.fn();
  return {
    // task.service
    getTask: f(), getTaskByUuid: f(), updateTask: f(), deleteTask: f(), isValidTaskStatusTransition: f(),
    checkDependenciesResolved: f(), claimTask: f(), releaseTask: f(), addTaskDependency: f(),
    getTaskDependencies: f(), removeTaskDependency: f(),
    // session.service
    getSessionsForTask: f(),
    // idea.service
    getIdea: f(), getIdeaByUuid: f(), updateIdea: f(), deleteIdea: f(), isValidIdeaStatusTransition: f(),
    claimIdea: f(), releaseIdea: f(), setIdeaParent: f(), moveIdea: f(), moveIdeaPreview: f(),
    // wake-preview.service
    previewIdeaWakeTarget: f(),
    // proposal.service
    getProposal: f(), getProposalByUuid: f(), approveProposal: f(), rejectProposal: f(), closeProposal: f(),
    revokeProposal: f(),
    // document.service
    getDocument: f(), getDocumentByUuid: f(), updateDocument: f(), deleteDocument: f(),
    // comment.service
    listComments: f(), createComment: f(), resolveAgentOwners: f(),
    // reference-artifact.service
    listReferences: f(), createReference: f(), getReference: f(), updateReference: f(), deleteReference: f(),
    // lineage.service
    resolveRootIdea: f(),
    // mention.service
    searchMentionables: f(),
    // activity.service
    createActivity: f(),
  };
});

vi.mock("@/services/task.service", () => ({
  getTask: svc.getTask, getTaskByUuid: svc.getTaskByUuid, updateTask: svc.updateTask, deleteTask: svc.deleteTask,
  isValidTaskStatusTransition: svc.isValidTaskStatusTransition,
  checkDependenciesResolved: svc.checkDependenciesResolved, claimTask: svc.claimTask,
  releaseTask: svc.releaseTask, addTaskDependency: svc.addTaskDependency,
  getTaskDependencies: svc.getTaskDependencies, removeTaskDependency: svc.removeTaskDependency,
}));
vi.mock("@/services/session.service", () => ({ getSessionsForTask: svc.getSessionsForTask }));
vi.mock("@/services/idea.service", () => ({
  getIdea: svc.getIdea, getIdeaByUuid: svc.getIdeaByUuid, updateIdea: svc.updateIdea, deleteIdea: svc.deleteIdea,
  isValidIdeaStatusTransition: svc.isValidIdeaStatusTransition, claimIdea: svc.claimIdea,
  releaseIdea: svc.releaseIdea, setIdeaParent: svc.setIdeaParent, moveIdea: svc.moveIdea,
  moveIdeaPreview: svc.moveIdeaPreview,
}));
vi.mock("@/services/wake-preview.service", () => ({ previewIdeaWakeTarget: svc.previewIdeaWakeTarget }));
vi.mock("@/services/proposal.service", () => ({
  getProposal: svc.getProposal, getProposalByUuid: svc.getProposalByUuid, approveProposal: svc.approveProposal,
  rejectProposal: svc.rejectProposal, closeProposal: svc.closeProposal, revokeProposal: svc.revokeProposal,
}));
vi.mock("@/services/document.service", () => ({
  getDocument: svc.getDocument, getDocumentByUuid: svc.getDocumentByUuid, updateDocument: svc.updateDocument,
  deleteDocument: svc.deleteDocument,
}));
vi.mock("@/services/comment.service", () => ({
  listComments: svc.listComments, createComment: svc.createComment, resolveAgentOwners: svc.resolveAgentOwners,
}));
vi.mock("@/services/reference-artifact.service", () => ({
  REFERENCE_TARGET_TYPES: ["proposal", "task", "idea"],
  listReferences: svc.listReferences, createReference: svc.createReference, getReference: svc.getReference,
  updateReference: svc.updateReference, deleteReference: svc.deleteReference,
}));
vi.mock("@/services/lineage.service", () => ({ resolveRootIdea: svc.resolveRootIdea }));
vi.mock("@/services/mention.service", () => ({ searchMentionables: svc.searchMentionables }));
vi.mock("@/services/activity.service", () => ({ createActivity: svc.createActivity }));

// ===== Routes under test =====

import * as taskRoute from "@/app/api/tasks/[uuid]/route";
import * as taskClaimRoute from "@/app/api/tasks/[uuid]/claim/route";
import * as taskReleaseRoute from "@/app/api/tasks/[uuid]/release/route";
import * as taskDepsRoute from "@/app/api/tasks/[uuid]/dependencies/route";
import * as taskDepRoute from "@/app/api/tasks/[uuid]/dependencies/[dependsOnUuid]/route";
import * as taskSessionsRoute from "@/app/api/tasks/[uuid]/sessions/route";
import * as ideaRoute from "@/app/api/ideas/[uuid]/route";
import * as ideaClaimRoute from "@/app/api/ideas/[uuid]/claim/route";
import * as ideaReleaseRoute from "@/app/api/ideas/[uuid]/release/route";
import * as ideaParentRoute from "@/app/api/ideas/[uuid]/parent/route";
import * as ideaMoveRoute from "@/app/api/ideas/[uuid]/move/route";
import * as ideaMovePreviewRoute from "@/app/api/ideas/[uuid]/move/preview/route";
import * as ideaWakePreviewRoute from "@/app/api/ideas/[uuid]/wake-preview/route";
import * as proposalRoute from "@/app/api/proposals/[uuid]/route";
import * as proposalApproveRoute from "@/app/api/proposals/[uuid]/approve/route";
import * as proposalRejectRoute from "@/app/api/proposals/[uuid]/reject/route";
import * as proposalCloseRoute from "@/app/api/proposals/[uuid]/close/route";
import * as proposalRevokeRoute from "@/app/api/proposals/[uuid]/revoke/route";
import * as documentRoute from "@/app/api/documents/[uuid]/route";
import * as commentsRoute from "@/app/api/comments/route";
import * as referencesRoute from "@/app/api/references/route";
import * as referenceRoute from "@/app/api/references/[uuid]/route";
import * as rootIdeaRoute from "@/app/api/entities/[type]/[uuid]/root-idea/route";
import * as mentionablesRoute from "@/app/api/mentionables/route";

// ===== Fixture data =====

const C = "company-1";
const PRIV = "11111111-1111-4111-8111-111111111111";
const PUB = "22222222-2222-4222-8222-222222222222";
const TARGET_PUB = "33333333-3333-4333-8333-333333333333";
const TARGET_PRIV = "44444444-4444-4444-8444-444444444444";
type Where = "priv" | "pub";
const PROJECT: Record<Where, string> = { priv: PRIV, pub: PUB };

const user = (uuid: string): AuthContext => ({ type: "user", companyUuid: C, actorUuid: uuid });
const OUTSIDER = user("u-out");
const VIEWER = user("u-viewer");
const EDITOR = user("u-editor");

// Entity uuids are derived from the project they live in.
const id = (type: string, where: Where, n = 1) => `${type}-${where}-${n}`;

let proposalStatus = "pending";

beforeEach(() => {
  vi.clearAllMocks();
  proposalStatus = "pending";
  db.projects = [
    { uuid: PRIV, companyUuid: C, name: "Private", visibility: "private" },
    { uuid: PUB, companyUuid: C, name: "Public", visibility: "public" },
    { uuid: TARGET_PUB, companyUuid: C, name: "Target public", visibility: "public" },
    { uuid: TARGET_PRIV, companyUuid: C, name: "Target private", visibility: "private" },
  ];
  db.members = [
    { projectUuid: PRIV, userUuid: "u-viewer", companyUuid: C, role: "viewer" },
    { projectUuid: PRIV, userUuid: "u-editor", companyUuid: C, role: "editor" },
    { projectUuid: TARGET_PRIV, userUuid: "u-editor", companyUuid: C, role: "viewer" },
  ];
  db.entities = {};
  for (const type of ["task", "idea", "proposal", "document"]) {
    db.entities[type] = (["priv", "pub"] as Where[]).flatMap((w) =>
      [1, 2].map((n) => ({ uuid: id(type, w, n), companyUuid: C, projectUuid: PROJECT[w] })),
    );
  }

  // Business-service defaults: every entity exists and every operation succeeds.
  const projectOf = (uuid: string) => (uuid.includes("-priv-") ? PRIV : PUB);
  const task = (uuid: string) => ({
    uuid, projectUuid: projectOf(uuid), status: "to_verify", assigneeType: "user", assigneeUuid: "u-editor",
  });
  svc.getTask.mockImplementation(async (_c: string, uuid: string) => task(uuid));
  svc.getTaskByUuid.mockImplementation(async (_c: string, uuid: string) => task(uuid));
  svc.isValidTaskStatusTransition.mockReturnValue(true);
  svc.checkDependenciesResolved.mockResolvedValue({ resolved: true, blockers: [] });
  svc.updateTask.mockImplementation(async (uuid: string, data: object) => ({ ...task(uuid), ...data }));
  svc.deleteTask.mockResolvedValue(undefined);
  svc.claimTask.mockResolvedValue({ claimed: true });
  svc.releaseTask.mockResolvedValue({ released: true });
  svc.addTaskDependency.mockResolvedValue({ added: true });
  svc.getTaskDependencies.mockResolvedValue({ dependsOn: [], dependedBy: [] });
  svc.removeTaskDependency.mockResolvedValue(undefined);
  svc.getSessionsForTask.mockResolvedValue([]);

  const idea = (uuid: string) => ({
    uuid, projectUuid: projectOf(uuid), status: "open", assigneeType: null, assigneeUuid: null,
  });
  svc.getIdea.mockImplementation(async (_c: string, uuid: string) => idea(uuid));
  svc.getIdeaByUuid.mockImplementation(async (_c: string, uuid: string) => idea(uuid));
  svc.isValidIdeaStatusTransition.mockReturnValue(true);
  svc.updateIdea.mockResolvedValue({ updated: true });
  svc.deleteIdea.mockResolvedValue(undefined);
  svc.claimIdea.mockResolvedValue({ claimed: true });
  svc.releaseIdea.mockResolvedValue({ released: true });
  svc.setIdeaParent.mockResolvedValue({ parented: true });
  svc.moveIdea.mockResolvedValue({ moved: { ideas: 1 } });
  svc.moveIdeaPreview.mockResolvedValue({ moved: { ideas: 1 } });
  svc.previewIdeaWakeTarget.mockResolvedValue({ outcome: "direct" });

  const proposal = (uuid: string) => ({ uuid, projectUuid: projectOf(uuid), status: proposalStatus });
  svc.getProposal.mockImplementation(async (_c: string, uuid: string) => proposal(uuid));
  svc.getProposalByUuid.mockImplementation(async (_c: string, uuid: string) => proposal(uuid));
  svc.approveProposal.mockResolvedValue({ status: "approved" });
  svc.rejectProposal.mockResolvedValue({ status: "draft" });
  svc.closeProposal.mockResolvedValue({ status: "closed" });
  svc.revokeProposal.mockResolvedValue({ closedTasks: [], deletedDocuments: [] });

  const document = (uuid: string) => ({ uuid, projectUuid: projectOf(uuid) });
  svc.getDocument.mockImplementation(async (_c: string, uuid: string) => document(uuid));
  svc.getDocumentByUuid.mockImplementation(async (_c: string, uuid: string) => document(uuid));
  svc.updateDocument.mockResolvedValue({ updated: true });
  svc.deleteDocument.mockResolvedValue(undefined);

  svc.listComments.mockResolvedValue({ comments: [], total: 0 });
  svc.createComment.mockResolvedValue({ uuid: "comment-1" });
  svc.resolveAgentOwners.mockImplementation(async (comments: unknown[]) => comments);

  // ref-<where> references point at the task in that project.
  svc.getReference.mockImplementation(async (_c: string, uuid: string) => {
    const m = /^ref-(priv|pub)$/.exec(uuid);
    return m ? { uuid, targetType: "task", targetUuid: id("task", m[1] as Where) } : null;
  });
  svc.listReferences.mockResolvedValue([]);
  svc.createReference.mockResolvedValue({ uuid: "ref-new" });
  svc.updateReference.mockResolvedValue({ updated: true });
  svc.deleteReference.mockResolvedValue(undefined);

  svc.resolveRootIdea.mockResolvedValue({ rootIdeaUuid: "idea-root", directIdeaUuid: "idea-root", lineage: [], resolvedVia: "root_idea" });
  svc.searchMentionables.mockResolvedValue([]);
  svc.createActivity.mockResolvedValue(undefined);
});

// ===== Request helpers =====

function req(method: string, path: string, body?: unknown): NextRequest {
  return new NextRequest(new URL(path, "http://localhost:3000"), {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
  });
}
const ctx = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) });

type Handler = (request: NextRequest, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
const h = (fn: unknown) => fn as Handler;

interface RouteCase {
  name: string;
  level: "viewer" | "editor";
  run: (w: Where) => Promise<Response>;
  service: ReturnType<typeof vi.fn>;
  // What a hidden entity returns (default: 404, same as a missing one).
  hidden?: { status: number; check?: (json: Record<string, unknown>) => void };
  setup?: () => void;
  // The service call IS the company-scoped lookup the access check needs (references/[uuid] GET).
  lookupFirst?: boolean;
}

const CASES: RouteCase[] = [
  // ----- tasks -----
  { name: "GET /tasks/[uuid]", level: "viewer", service: svc.getTask,
    run: (w) => h(taskRoute.GET)(req("GET", `/api/tasks/${id("task", w)}`), ctx({ uuid: id("task", w) })) },
  { name: "PATCH /tasks/[uuid] (verify → done)", level: "editor", service: svc.updateTask,
    run: (w) => h(taskRoute.PATCH)(req("PATCH", `/api/tasks/${id("task", w)}`, { status: "done" }), ctx({ uuid: id("task", w) })) },
  { name: "DELETE /tasks/[uuid]", level: "editor", service: svc.deleteTask,
    run: (w) => h(taskRoute.DELETE)(req("DELETE", `/api/tasks/${id("task", w)}`), ctx({ uuid: id("task", w) })) },
  { name: "POST /tasks/[uuid]/claim", level: "editor", service: svc.claimTask,
    run: (w) => h(taskClaimRoute.POST)(req("POST", `/api/tasks/${id("task", w)}/claim`, {}), ctx({ uuid: id("task", w) })) },
  { name: "POST /tasks/[uuid]/release", level: "editor", service: svc.releaseTask,
    run: (w) => h(taskReleaseRoute.POST)(req("POST", `/api/tasks/${id("task", w)}/release`), ctx({ uuid: id("task", w) })) },
  { name: "GET /tasks/[uuid]/dependencies", level: "viewer", service: svc.getTaskDependencies,
    run: (w) => h(taskDepsRoute.GET)(req("GET", `/api/tasks/${id("task", w)}/dependencies`), ctx({ uuid: id("task", w) })) },
  { name: "POST /tasks/[uuid]/dependencies", level: "editor", service: svc.addTaskDependency,
    run: (w) => h(taskDepsRoute.POST)(
      req("POST", `/api/tasks/${id("task", w)}/dependencies`, { dependsOnUuid: id("task", w, 2) }),
      ctx({ uuid: id("task", w) })) },
  { name: "DELETE /tasks/[uuid]/dependencies/[dependsOnUuid]", level: "editor", service: svc.removeTaskDependency,
    run: (w) => h(taskDepRoute.DELETE)(
      req("DELETE", `/api/tasks/${id("task", w)}/dependencies/${id("task", w, 2)}`),
      ctx({ uuid: id("task", w), dependsOnUuid: id("task", w, 2) })) },
  { name: "GET /tasks/[uuid]/sessions", level: "viewer", service: svc.getSessionsForTask,
    run: (w) => h(taskSessionsRoute.GET)(req("GET", `/api/tasks/${id("task", w)}/sessions`), ctx({ uuid: id("task", w) })) },
  // ----- ideas -----
  { name: "GET /ideas/[uuid]", level: "viewer", service: svc.getIdea,
    run: (w) => h(ideaRoute.GET)(req("GET", `/api/ideas/${id("idea", w)}`), ctx({ uuid: id("idea", w) })) },
  { name: "PATCH /ideas/[uuid]", level: "editor", service: svc.updateIdea,
    run: (w) => h(ideaRoute.PATCH)(req("PATCH", `/api/ideas/${id("idea", w)}`, { title: "New" }), ctx({ uuid: id("idea", w) })) },
  { name: "DELETE /ideas/[uuid]", level: "editor", service: svc.deleteIdea,
    run: (w) => h(ideaRoute.DELETE)(req("DELETE", `/api/ideas/${id("idea", w)}`), ctx({ uuid: id("idea", w) })) },
  { name: "POST /ideas/[uuid]/claim", level: "editor", service: svc.claimIdea,
    run: (w) => h(ideaClaimRoute.POST)(req("POST", `/api/ideas/${id("idea", w)}/claim`, {}), ctx({ uuid: id("idea", w) })) },
  { name: "POST /ideas/[uuid]/release", level: "editor", service: svc.releaseIdea,
    run: (w) => h(ideaReleaseRoute.POST)(req("POST", `/api/ideas/${id("idea", w)}/release`), ctx({ uuid: id("idea", w) })) },
  { name: "PATCH /ideas/[uuid]/parent", level: "editor", service: svc.setIdeaParent,
    // The parent route reports every lookup failure as 400; a hidden idea matches it.
    hidden: { status: 400, check: (j) => expect(JSON.stringify(j)).toContain("Idea not found") },
    run: (w) => h(ideaParentRoute.PATCH)(
      req("PATCH", `/api/ideas/${id("idea", w)}/parent`, { parentUuid: id("idea", w, 2) }), ctx({ uuid: id("idea", w) })) },
  { name: "PATCH /ideas/[uuid]/move", level: "editor", service: svc.moveIdea,
    run: (w) => h(ideaMoveRoute.PATCH)(
      req("PATCH", `/api/ideas/${id("idea", w)}/move`, { targetProjectUuid: TARGET_PUB }), ctx({ uuid: id("idea", w) })) },
  { name: "GET /ideas/[uuid]/move/preview", level: "viewer", service: svc.moveIdeaPreview,
    run: (w) => h(ideaMovePreviewRoute.GET)(
      req("GET", `/api/ideas/${id("idea", w)}/move/preview?targetProjectUuid=${TARGET_PUB}`), ctx({ uuid: id("idea", w) })) },
  { name: "GET /ideas/[uuid]/wake-preview", level: "viewer", service: svc.previewIdeaWakeTarget,
    run: (w) => h(ideaWakePreviewRoute.GET)(req("GET", `/api/ideas/${id("idea", w)}/wake-preview`), ctx({ uuid: id("idea", w) })) },
  // ----- proposals -----
  { name: "GET /proposals/[uuid]", level: "viewer", service: svc.getProposal,
    run: (w) => h(proposalRoute.GET)(req("GET", `/api/proposals/${id("proposal", w)}`), ctx({ uuid: id("proposal", w) })) },
  { name: "POST /proposals/[uuid]/approve", level: "editor", service: svc.approveProposal,
    run: (w) => h(proposalApproveRoute.POST)(
      req("POST", `/api/proposals/${id("proposal", w)}/approve`, {}), ctx({ uuid: id("proposal", w) })) },
  { name: "POST /proposals/[uuid]/reject", level: "editor", service: svc.rejectProposal,
    run: (w) => h(proposalRejectRoute.POST)(
      req("POST", `/api/proposals/${id("proposal", w)}/reject`, { reviewNote: "no" }), ctx({ uuid: id("proposal", w) })) },
  { name: "POST /proposals/[uuid]/close", level: "editor", service: svc.closeProposal,
    run: (w) => h(proposalCloseRoute.POST)(
      req("POST", `/api/proposals/${id("proposal", w)}/close`, { reviewNote: "done" }), ctx({ uuid: id("proposal", w) })) },
  { name: "POST /proposals/[uuid]/revoke", level: "editor", service: svc.revokeProposal,
    setup: () => { proposalStatus = "approved"; },
    run: (w) => h(proposalRevokeRoute.POST)(
      req("POST", `/api/proposals/${id("proposal", w)}/revoke`, {}), ctx({ uuid: id("proposal", w) })) },
  // ----- documents -----
  { name: "GET /documents/[uuid]", level: "viewer", service: svc.getDocument,
    run: (w) => h(documentRoute.GET)(req("GET", `/api/documents/${id("document", w)}`), ctx({ uuid: id("document", w) })) },
  { name: "PATCH /documents/[uuid]", level: "editor", service: svc.updateDocument,
    run: (w) => h(documentRoute.PATCH)(
      req("PATCH", `/api/documents/${id("document", w)}`, { title: "T" }), ctx({ uuid: id("document", w) })) },
  { name: "DELETE /documents/[uuid]", level: "editor", service: svc.deleteDocument,
    run: (w) => h(documentRoute.DELETE)(req("DELETE", `/api/documents/${id("document", w)}`), ctx({ uuid: id("document", w) })) },
  // ----- comments -----
  { name: "GET /comments", level: "viewer", service: svc.listComments,
    run: (w) => h(commentsRoute.GET)(req("GET", `/api/comments?targetType=task&targetUuid=${id("task", w)}`), ctx({})) },
  { name: "POST /comments", level: "editor", service: svc.createComment,
    run: (w) => h(commentsRoute.POST)(
      req("POST", "/api/comments", { targetType: "idea", targetUuid: id("idea", w), content: "hi" }), ctx({})) },
  // ----- references -----
  { name: "GET /references", level: "viewer", service: svc.listReferences,
    run: (w) => h(referencesRoute.GET)(req("GET", `/api/references?targetType=task&targetUuid=${id("task", w)}`), ctx({})) },
  { name: "POST /references", level: "editor", service: svc.createReference,
    hidden: { status: 404, check: (j) => expect(JSON.stringify(j)).toContain("not found") },
    run: (w) => h(referencesRoute.POST)(req("POST", "/api/references", {
      targetType: "proposal", targetUuid: id("proposal", w), type: "docs", url: "https://x.dev", title: "X",
    }), ctx({})) },
  { name: "GET /references/[uuid]", level: "viewer", service: svc.getReference, lookupFirst: true,
    run: (w) => h(referenceRoute.GET)(req("GET", `/api/references/ref-${w}`), ctx({ uuid: `ref-${w}` })) },
  { name: "PATCH /references/[uuid]", level: "editor", service: svc.updateReference,
    run: (w) => h(referenceRoute.PATCH)(req("PATCH", `/api/references/ref-${w}`, { title: "Y" }), ctx({ uuid: `ref-${w}` })) },
  { name: "DELETE /references/[uuid]", level: "editor", service: svc.deleteReference,
    run: (w) => h(referenceRoute.DELETE)(req("DELETE", `/api/references/ref-${w}`), ctx({ uuid: `ref-${w}` })) },
  // ----- entities / mentionables -----
  { name: "GET /entities/[type]/[uuid]/root-idea", level: "viewer", service: svc.resolveRootIdea,
    // Missing entities resolve to a successful "not_found" result; hidden ones match it.
    hidden: { status: 200, check: (j) => expect((j.data as { resolvedVia: string }).resolvedVia).toBe("not_found") },
    run: (w) => h(rootIdeaRoute.GET)(
      req("GET", `/api/entities/task/${id("task", w)}/root-idea`), ctx({ type: "task", uuid: id("task", w) })) },
  { name: "GET /mentionables (entity context)", level: "viewer", service: svc.searchMentionables,
    run: (w) => h(mentionablesRoute.GET)(
      req("GET", `/api/mentionables?q=a&entityType=task&entityUuid=${id("task", w)}`), ctx({})) },
];

async function call(c: RouteCase, auth: AuthContext, w: Where) {
  authState.current = auth;
  c.setup?.();
  const res = await c.run(w);
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, json };
}

describe.each(CASES)("$name ($level)", (c) => {
  it("private project, non-member → hidden like a missing entity; service never called", async () => {
    const { status, json } = await call(c, OUTSIDER, "priv");
    const expected = c.hidden ?? { status: 404 };
    expect(status).toBe(expected.status);
    if (expected.check) expected.check(json);
    else expect(json.success).toBe(false);
    if (!c.lookupFirst) expect(c.service).not.toHaveBeenCalled();
  });

  it(`private project, viewer → ${c.level === "viewer" ? "200" : "403"}`, async () => {
    const { status } = await call(c, VIEWER, "priv");
    if (c.level === "viewer") {
      expect(status).toBe(200);
      expect(c.service).toHaveBeenCalled();
    } else {
      expect(status).toBe(403);
      if (!c.lookupFirst) expect(c.service).not.toHaveBeenCalled();
    }
  });

  it("private project, editor → 200", async () => {
    const { status } = await call(c, EDITOR, "priv");
    expect(status).toBe(200);
    expect(c.service).toHaveBeenCalled();
  });

  it("public project, non-member → unchanged (200)", async () => {
    const { status } = await call(c, OUTSIDER, "pub");
    expect(status).toBe(200);
    expect(c.service).toHaveBeenCalled();
  });
});

describe("cross-entity checks", () => {
  it("dependency POST: a hidden dependsOn task reads like a missing one (400), no service call", async () => {
    authState.current = OUTSIDER;
    const res = await h(taskDepsRoute.POST)(
      req("POST", `/api/tasks/${id("task", "pub")}/dependencies`, { dependsOnUuid: id("task", "priv") }),
      ctx({ uuid: id("task", "pub") }),
    );
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("Dependency task not found");
    expect(svc.addTaskDependency).not.toHaveBeenCalled();
  });

  it("dependency DELETE: checks the dependsOn task too", async () => {
    authState.current = OUTSIDER;
    const res = await h(taskDepRoute.DELETE)(
      req("DELETE", `/api/tasks/${id("task", "pub")}/dependencies/${id("task", "priv")}`),
      ctx({ uuid: id("task", "pub"), dependsOnUuid: id("task", "priv") }),
    );
    expect(res.status).toBe(404);
    expect(svc.removeTaskDependency).not.toHaveBeenCalled();
  });

  it("parent PATCH: a hidden new parent reads like a missing one (400)", async () => {
    authState.current = OUTSIDER;
    const res = await h(ideaParentRoute.PATCH)(
      req("PATCH", `/api/ideas/${id("idea", "pub")}/parent`, { parentUuid: id("idea", "priv") }),
      ctx({ uuid: id("idea", "pub") }),
    );
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("Parent idea not found");
    expect(svc.setIdeaParent).not.toHaveBeenCalled();
  });

  it("parent PATCH: detaching (null parent) only checks the child", async () => {
    authState.current = EDITOR;
    const res = await h(ideaParentRoute.PATCH)(
      req("PATCH", `/api/ideas/${id("idea", "priv")}/parent`, { parentUuid: null }),
      ctx({ uuid: id("idea", "priv") }),
    );
    expect(res.status).toBe(200);
  });

  it("move PATCH: hidden target project → 404 Target project not found", async () => {
    authState.current = OUTSIDER;
    const res = await h(ideaMoveRoute.PATCH)(
      req("PATCH", `/api/ideas/${id("idea", "pub")}/move`, { targetProjectUuid: TARGET_PRIV }),
      ctx({ uuid: id("idea", "pub") }),
    );
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).toContain("Target project not found");
    expect(svc.moveIdea).not.toHaveBeenCalled();
  });

  it("move PATCH: viewer-only on the target project → 403", async () => {
    authState.current = EDITOR; // editor on PRIV, viewer on TARGET_PRIV
    const res = await h(ideaMoveRoute.PATCH)(
      req("PATCH", `/api/ideas/${id("idea", "priv")}/move`, { targetProjectUuid: TARGET_PRIV }),
      ctx({ uuid: id("idea", "priv") }),
    );
    expect(res.status).toBe(403);
    expect(svc.moveIdea).not.toHaveBeenCalled();
  });

  it("move preview: viewer on the target project is enough", async () => {
    authState.current = EDITOR;
    const res = await h(ideaMovePreviewRoute.GET)(
      req("GET", `/api/ideas/${id("idea", "priv")}/move/preview?targetProjectUuid=${TARGET_PRIV}`),
      ctx({ uuid: id("idea", "priv") }),
    );
    expect(res.status).toBe(200);
  });

  it("move preview: hidden target project → 404", async () => {
    authState.current = OUTSIDER;
    const res = await h(ideaMovePreviewRoute.GET)(
      req("GET", `/api/ideas/${id("idea", "pub")}/move/preview?targetProjectUuid=${TARGET_PRIV}`),
      ctx({ uuid: id("idea", "pub") }),
    );
    expect(res.status).toBe(404);
    expect(svc.moveIdeaPreview).not.toHaveBeenCalled();
  });

  it("references/[uuid]: a missing reference stays 404", async () => {
    authState.current = EDITOR;
    const res = await h(referenceRoute.GET)(req("GET", "/api/references/ref-missing"), ctx({ uuid: "ref-missing" }));
    expect(res.status).toBe(404);
  });

  it("mentionables without entity context is not gated", async () => {
    authState.current = OUTSIDER;
    const res = await h(mentionablesRoute.GET)(req("GET", "/api/mentionables?q=a"), ctx({}));
    expect(res.status).toBe(200);
    expect(svc.searchMentionables).toHaveBeenCalled();
  });
});

describe("comment HTTP reads", () => {
  const targetTypes = ["idea", "proposal", "task", "document"];
  const read = (query: string) => h(commentsRoute.GET)(req("GET", `/api/comments?${query}`), ctx({}));
  const targetQuery = (targetType = "task", targetUuid = id(targetType, "priv")) =>
    `targetType=${targetType}&targetUuid=${targetUuid}`;
  const expectNoReads = () => {
    expect(svc.listComments).not.toHaveBeenCalled();
    expect(svc.resolveAgentOwners).not.toHaveBeenCalled();
  };

  beforeEach(() => {
    authState.current = VIEWER;
  });

  it.each(targetTypes)("returns attributed cursor comments and metadata to a %s viewer", async (targetType) => {
    const comments = [
      { uuid: "newer", content: "agent comment", author: { type: "agent", uuid: "agent-1", name: "Agent" } },
      { uuid: "older", content: "user comment", author: { type: "user", uuid: "u-viewer", name: "Viewer" } },
    ];
    const attributed = [
      { ...comments[0], author: { ...comments[0].author, owner: { uuid: "owner-1", name: "Owner" } } },
      comments[1],
    ];
    svc.listComments.mockResolvedValue({ comments, total: 3, nextCursor: "older", hasMore: true });
    svc.resolveAgentOwners.mockResolvedValue(attributed);

    const response = await read(`${targetQuery(targetType)}&limit=2`);

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      success: true, data: { comments: attributed, total: 3, nextCursor: "older", hasMore: true },
    });
    expect(svc.listComments).toHaveBeenCalledExactlyOnceWith({
      companyUuid: C, targetType, targetUuid: id(targetType, "priv"), cursor: null, limit: 2,
    });
    expect(svc.resolveAgentOwners).toHaveBeenCalledExactlyOnceWith(comments);
    expect(svc.listComments.mock.invocationCallOrder[0]).toBeLessThan(svc.resolveAgentOwners.mock.invocationCallOrder[0]);
  });

  it.each([
    { query: "cursor=older", cursor: "older", limit: 10 },
    { query: "cursor=older&limit=1", cursor: "older", limit: 1 },
    { query: "limit=100", cursor: null, limit: 100 },
  ])("accepts cursor defaults and limit boundaries: $query", async ({ query, cursor, limit }) => {
    svc.listComments.mockResolvedValue({ comments: [], total: 0, nextCursor: null, hasMore: false });

    const response = await read(`${targetQuery()}&${query}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      success: true, data: { comments: [], total: 0, nextCursor: null, hasMore: false },
    });
    expect(svc.listComments).toHaveBeenCalledExactlyOnceWith({
      companyUuid: C, targetType: "task", targetUuid: id("task", "priv"), cursor, limit,
    });
  });

  it.each(["", "0", "-1", "101", "1.5", "10foo", "NaN", "Infinity", "1e1", "0x10", " 10 ", "+1", "9".repeat(310)])(
    "rejects invalid cursor limit %j before comment or owner reads", async (limit) => {
      const response = await read(`${targetQuery()}&limit=${encodeURIComponent(limit)}`);

      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({
        success: false, error: { code: "VALIDATION_ERROR", details: { limit: expect.any(String) } },
      });
      expectNoReads();
    },
  );

  it.each(["limit=10", "page=1"])("rejects unauthenticated reads: %s", async (pagination) => {
    authState.current = null;

    const response = await read(`${targetQuery()}&${pagination}`);

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ success: false, error: { code: "UNAUTHORIZED" } });
    expectNoReads();
  });

  it.each(targetTypes)("does not disclose hidden, missing, or foreign-company %s targets", async (targetType) => {
    db.entities[targetType].push({ uuid: "foreign-target", companyUuid: "company-2", projectUuid: PUB });
    authState.current = OUTSIDER;

    for (const pagination of ["limit=10", "cursor=older", "limit=NaN", "page=1"]) {
      const bodies = [];
      for (const targetUuid of [id(targetType, "priv"), "missing-target", "foreign-target"]) {
        const response = await read(`${targetQuery(targetType, targetUuid)}&${pagination}`);
        expect(response.status).toBe(404);
        bodies.push(await response.json());
      }
      expect(bodies[0]).toEqual(bodies[1]);
      expect(bodies[0]).toEqual(bodies[2]);
      expect(bodies[0]).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
    }
    expectNoReads();
  });

  it.each(["", "targetType=task", "targetUuid=some-target", "targetType=comment&targetUuid=some-target"])(
    "validates required and supported targets: %s", async (query) => {
      const response = await read(`${query}&limit=10`);
      expect(response.status).toBe(422);
      expectNoReads();
    },
  );

  it.each([
    { query: "", page: 1, pageSize: 20, skip: 0 },
    { query: "&page=2&pageSize=2", page: 2, pageSize: 2, skip: 2 },
  ])("preserves offset shape, pagination and ordering: $query", async ({ query, page, pageSize, skip }) => {
    const comments = [
      { uuid: "older", author: { type: "agent", uuid: "agent-1", name: "Agent" } },
      { uuid: "newer", author: { type: "user", uuid: "u-viewer", name: "Viewer" } },
    ];
    svc.listComments.mockResolvedValue({ comments, total: 4 });

    const response = await read(`${targetQuery()}${query}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: comments, meta: { page, pageSize, total: 4 } });
    expect(svc.listComments).toHaveBeenCalledExactlyOnceWith({
      companyUuid: C, targetType: "task", targetUuid: id("task", "priv"), skip, take: pageSize,
    });
    expect(svc.resolveAgentOwners).not.toHaveBeenCalled();
  });
});

describe("agents inherit their owner's project level", () => {
  const agent = (ownerUuid?: string): AuthContext => ({
    type: "agent", companyUuid: C, actorUuid: "agent-1", ownerUuid,
    permissions: ["proposal:admin", "proposal:read", "task:write"],
  } as AuthContext);

  it("owner is editor → agent may approve", async () => {
    authState.current = agent("u-editor");
    const res = await h(proposalApproveRoute.POST)(
      req("POST", `/api/proposals/${id("proposal", "priv")}/approve`, {}), ctx({ uuid: id("proposal", "priv") }));
    expect(res.status).toBe(200);
    expect(svc.approveProposal).toHaveBeenCalled();
  });

  it("owner is viewer → 403", async () => {
    authState.current = agent("u-viewer");
    const res = await h(proposalApproveRoute.POST)(
      req("POST", `/api/proposals/${id("proposal", "priv")}/approve`, {}), ctx({ uuid: id("proposal", "priv") }));
    expect(res.status).toBe(403);
    expect(svc.approveProposal).not.toHaveBeenCalled();
  });

  it("ownerless agent → 404 on a private project", async () => {
    authState.current = agent(undefined);
    const res = await h(proposalApproveRoute.POST)(
      req("POST", `/api/proposals/${id("proposal", "priv")}/approve`, {}), ctx({ uuid: id("proposal", "priv") }));
    expect(res.status).toBe(404);
  });

  it("agent permission check still runs first (missing bit → 403 before access check)", async () => {
    authState.current = { ...agent("u-editor"), permissions: [] } as AuthContext;
    const res = await h(proposalApproveRoute.POST)(
      req("POST", `/api/proposals/${id("proposal", "priv")}/approve`, {}), ctx({ uuid: id("proposal", "priv") }));
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).toContain("proposal:admin");
  });
});
