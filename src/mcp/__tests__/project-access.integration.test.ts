import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentAuthContext } from "@/types/auth";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ROLE_PRESETS } from "@/lib/authz/presets";

type Row = Record<string, unknown>;
const fixture = vi.hoisted(() => {
  const rows: Record<string, Row[]> = {};
  const matches = (row: Row, where: Row): boolean => Object.entries(where).every(([key, value]) => {
    if (key === "OR") return (value as Row[]).some((condition) => matches(row, condition));
    if (typeof value === "object" && value !== null && "in" in value) {
      return (value.in as unknown[]).includes(row[key]);
    }
    if (typeof value === "object" && value !== null && "not" in value) {
      return row[key] !== value.not;
    }
    return row[key] === value;
  });
  const model = (name: string) => ({
    findFirst: vi.fn(async ({ where }: { where: Row }) =>
      (rows[name] ?? []).find((row) => matches(row, where)) ?? null),
    findMany: vi.fn(async ({ where }: { where: Row }) =>
      (rows[name] ?? []).filter((row) => matches(row, where))),
    count: vi.fn(async ({ where }: { where: Row }) =>
      (rows[name] ?? []).filter((row) => matches(row, where)).length),
  });
  const prisma = {
    project: model("project"),
    projectMember: {
      ...model("projectMember"),
      findUnique: vi.fn(async ({ where }: { where: { projectUuid_userUuid: Row } }) =>
        (rows.projectMember ?? []).find((row) => matches(row, where.projectUuid_userUuid)) ?? null),
    },
    idea: model("idea"),
    task: model("task"),
    proposal: {
      ...model("proposal"),
      create: vi.fn(async ({ data }: { data: Row }) => {
        const row = {
          uuid: "new-proposal",
          description: null, documentDrafts: null, taskDrafts: null,
          reviewedByUuid: null, reviewNote: null, reviewedAt: null,
          createdAt: new Date("2026-10-01"), updatedAt: new Date("2026-10-01"),
          ...data,
        };
        rows.proposal.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const row = (rows.proposal ?? []).find((proposal) => matches(proposal, where));
        if (!row) throw new Error("Proposal not found");
        Object.assign(row, data);
        return { ...row, project: (rows.project ?? []).find((project) => project.uuid === row.projectUuid) };
      }),
    },
    document: model("document"),
    comment: model("comment"),
    referenceArtifact: model("reference"),
    agentSession: model("session"),
    projectGroup: model("group"),
    projectGroupMember: model("projectGroupMember"),
    agent: { findUnique: vi.fn(async () => ({ name: "Agent" })) },
  };
  const entity = (name: string, uuid: string) => (rows[name] ?? []).find((r) => r.uuid === uuid) ?? null;
  const services = {
    project: {
      getProjectByUuid: vi.fn(async (_company: string, uuid: string) => entity("project", uuid)),
      projectExists: vi.fn(async (_company: string, uuid: string) => Boolean(entity("project", uuid))),
      listProjects: vi.fn(async () => ({ projects: [], total: 0 })),
    },
    task: {
      getTask: vi.fn(async (_company: string, uuid: string) => entity("task", uuid)),
      getTaskByUuid: vi.fn(async (_company: string, uuid: string) => entity("task", uuid)),
      claimTask: vi.fn(async () => undefined),
      checkAcceptanceCriteriaGate: vi.fn(async () => ({ allowed: true })),
      updateTask: vi.fn(async (uuid: string, data: Row) => ({ ...entity("task", uuid), ...data })),
    },
    idea: {
      getIdea: vi.fn(async (_company: string, uuid: string) => entity("idea", uuid)),
      getIdeaByUuid: vi.fn(async (_company: string, uuid: string) => entity("idea", uuid)),
      createIdea: vi.fn(async (params: Row) => ({ uuid: "new-idea", ...params })),
    },
    document: { getDocument: vi.fn(async (_company: string, uuid: string) => entity("document", uuid)) },
    proposal: {
      getProposalSection: vi.fn(async (_company: string, uuid: string) => entity("proposal", uuid)),
      getProposalByUuid: vi.fn(async (_company: string, uuid: string) => entity("proposal", uuid)),
      validateProposal: vi.fn<typeof import("@/services/proposal.service").validateProposal>(),
      submitProposal: vi.fn<typeof import("@/services/proposal.service").submitProposal>(),
      checkIdeasAssignee: vi.fn<typeof import("@/services/proposal.service").checkIdeasAssignee>(),
      checkIdeasAvailability: vi.fn<typeof import("@/services/proposal.service").checkIdeasAvailability>(),
      createProposal: vi.fn<typeof import("@/services/proposal.service").createProposal>(),
      approveProposal: vi.fn(async (uuid: string) => ({ ...entity("proposal", uuid), status: "approved" })),
    },
    activity: { createActivity: vi.fn(async () => undefined) },
    comment: { createComment: vi.fn(async () => ({ uuid: "new-comment" })), resolveProjectUuid: vi.fn(async () => "private") },
    reference: {
      REFERENCE_TYPES: ["docs", "repo", "issue_pr", "paper_blog"],
      REFERENCE_TARGET_TYPES: ["idea", "task", "proposal"],
      listReferences: vi.fn(async () => []),
      createReferences: vi.fn(async () => ({ errors: [] })),
    },
    session: {
      getSession: vi.fn(async (_company: string, uuid: string) => entity("session", uuid)),
      sessionCheckinToTask: vi.fn(async () => ({ checkinAt: "2026-10-01" })),
      listAgentSessions: vi.fn(async () => [] as Row[]),
      closeSession: vi.fn(async () => ({ uuid: "session", status: "closed", checkins: [{ taskUuid: "task-private" }] })),
    },
    group: {
      moveProjectToGroup: vi.fn(async () => ({ uuid: "private" })),
      deleteProjectGroup: vi.fn(async () => true),
      listProjectGroups: vi.fn(async () => ({ groups: [], total: 0, ungroupedCount: 0 })),
      getProjectGroup: vi.fn(async () => ({ uuid: "group", projects: [] })),
      getGroupDashboard: vi.fn(async () => ({ group: { uuid: "group" }, projects: [] })),
    },
    assignment: {
      getAvailableItems: vi.fn(async () => ({ ideas: [], tasks: [] })),
      getMyAssignments: vi.fn(async () => ({ ideaTracker: {}, taskTracker: {} })),
    },
    checkin: { buildCheckinResponse: vi.fn(async () => ({ activeProjects: {} })) },
    search: { search: vi.fn(async () => ({ results: [], counts: {} })) },
  };
  return { rows, prisma, services };
});

vi.mock("@/lib/prisma", () => ({ prisma: fixture.prisma }));
vi.mock("@/lib/event-bus", () => ({ eventBus: { emitPresence: vi.fn(), emitChange: vi.fn() } }));
vi.mock("@/services/project.service", () => fixture.services.project);
vi.mock("@/services/task.service", () => fixture.services.task);
vi.mock("@/services/idea.service", () => fixture.services.idea);
vi.mock("@/services/document.service", () => fixture.services.document);
vi.mock("@/services/proposal.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/proposal.service")>();
  // Exercise stored-source validation and proposal reuse warnings for real.
  fixture.services.proposal.validateProposal.mockImplementation(actual.validateProposal);
  fixture.services.proposal.submitProposal.mockImplementation(actual.submitProposal);
  fixture.services.proposal.checkIdeasAssignee.mockImplementation(actual.checkIdeasAssignee);
  fixture.services.proposal.checkIdeasAvailability.mockImplementation(actual.checkIdeasAvailability);
  fixture.services.proposal.createProposal.mockImplementation(actual.createProposal);
  return fixture.services.proposal;
});
vi.mock("@/services/activity.service", () => fixture.services.activity);
vi.mock("@/services/comment.service", () => fixture.services.comment);
vi.mock("@/services/reference-artifact.service", () => fixture.services.reference);
vi.mock("@/services/session.service", () => fixture.services.session);
vi.mock("@/services/project-group.service", () => fixture.services.group);
vi.mock("@/services/assignment.service", () => fixture.services.assignment);
vi.mock("@/services/checkin.service", () => fixture.services.checkin);
vi.mock("@/services/search.service", () => fixture.services.search);
vi.mock("@/services/notification.service", () => ({}));
vi.mock("@/services/elaboration.service", () => ({}));
vi.mock("@/services/mention.service", () => ({}));
vi.mock("@/services/agent.service", () => ({}));
vi.mock("@/lib/logger", () => ({ default: { child: () => ({ warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) } }));

// Access service is deliberately REAL: principal inheritance, visibility,
// company-scoped model resolution and membership checks run against fixtures.
import { eventBus } from "@/lib/event-bus";
import { getProjectAccess } from "@/services/project-access.service";
import { authorizeToolProjectAccess } from "../tools/project-access";
import { getToolProjectAccessPolicy } from "../tools/permission-map";
import { enablePresence } from "../tools/presence";
import { registerPublicTools } from "../tools/public";
import { registerPmTools } from "../tools/pm";
import { registerDeveloperTools } from "../tools/developer";
import { registerAdminTools } from "../tools/admin";
import { registerSessionTools } from "../tools/session";
import { createMcpServer } from "../server";

function auth(ownerUuid?: string, permissions = [...ROLE_PRESETS.admin_agent]): AgentAuthContext {
  return { type: "agent", companyUuid: "company", actorUuid: "agent", agentName: "Agent", ownerUuid, permissions, roles: [] };
}

type Handler = (params: Record<string, unknown>, extra?: unknown) => Promise<CallToolResult>;
function register(actor: AgentAuthContext) {
  const handlers: Record<string, Handler> = {};
  const originals: Record<string, ReturnType<typeof vi.fn<Handler>>> = {};
  const server = {
    registerTool(name: string, _config: unknown, handler: Handler) { handlers[name] = handler; },
  };
  enablePresence(server as unknown as McpServer, actor);
  const gatedRegister = server.registerTool;
  server.registerTool = (name, config, handler) => {
    const spy = vi.fn(handler);
    originals[name] = spy;
    return gatedRegister(name, config, spy);
  };
  registerPublicTools(server as unknown as McpServer, actor);
  registerPmTools(server as unknown as McpServer, actor);
  registerDeveloperTools(server as unknown as McpServer, actor);
  registerAdminTools(server as unknown as McpServer, actor);
  registerSessionTools(server as unknown as McpServer, actor);
  return { handlers, originals };
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(fixture.rows)) delete fixture.rows[key];
  fixture.rows.project = [
    { uuid: "public", companyUuid: "company", visibility: "public", name: "Public", groupUuid: "group" },
    { uuid: "private", companyUuid: "company", visibility: "private", name: "Private", groupUuid: "group" },
    { uuid: "foreign", companyUuid: "other-company", visibility: "public" },
  ];
  fixture.rows.projectMember = ["viewer", "editor", "admin"].map((role) =>
    ({ companyUuid: "company", projectUuid: "private", userUuid: role, role }));
  fixture.rows.projectGroupMember = [{ companyUuid: "company", groupUuid: "group", userUuid: "admin", role: "admin" }];
  for (const type of ["task", "idea", "document", "proposal"]) {
    fixture.rows[type] = ["private", "public", "foreign"].map((projectUuid) => ({
      uuid: `${type}-${projectUuid}`, projectUuid,
      companyUuid: projectUuid === "foreign" ? "other-company" : "company",
      title: `${type} ${projectUuid}`, status: type === "task" ? "to_verify" : "open",
    }));
  }
  for (const idea of fixture.rows.idea) {
    idea.elaborationStatus = idea.projectUuid === "private" ? "pending" : "resolved";
    if (idea.projectUuid === "private") idea.title = "CONFIDENTIAL ACQUISITION";
  }
  Object.assign(fixture.rows.document[0], {
    title: "CONFIDENTIAL STRATEGY DOCUMENT", status: "confidential-document-status",
  });
  for (const proposal of fixture.rows.proposal) {
    Object.assign(proposal, {
      inputType: "idea",
      inputUuids: [`idea-${proposal.projectUuid}`],
      status: "draft",
      description: "Proposal with complete drafts",
      documentDrafts: [{
        uuid: "document-draft", type: "tech_design", title: "Public design", content: "Implementation details. ".repeat(8),
      }],
      taskDrafts: [{
        uuid: "task-draft", title: "Public task", description: "Implement the design", priority: "medium", storyPoints: 1,
        acceptanceCriteriaItems: [{ description: "The design is implemented", required: true }],
      }],
      createdByUuid: "agent", createdByType: "agent",
      reviewedByUuid: null, reviewNote: null, reviewedAt: null,
      createdAt: new Date("2026-10-01"), updatedAt: new Date("2026-10-01"),
    });
  }
  fixture.rows.reference = [{ uuid: "reference-private", companyUuid: "company", targetType: "idea", targetUuid: "idea-private" }];
  fixture.rows.comment = [{ uuid: "comment-private", companyUuid: "company", targetType: "task", targetUuid: "task-private" }];
  fixture.rows.session = [
    { uuid: "session", companyUuid: "company", agentUuid: "agent", taskCheckins: [] },
    { uuid: "private-session", companyUuid: "company", agentUuid: "agent", taskCheckins: [{ taskUuid: "task-private" }] },
  ];
  fixture.rows.group = [{ uuid: "group", companyUuid: "company", visibility: "public" }];
});

const entityCalls: [string, Record<string, unknown>, string][] = [
  ["chorus_get_task", { taskUuid: "task-private" }, "Task not found"],
  ["chorus_get_idea", { ideaUuid: "idea-private" }, "Idea not found"],
  ["chorus_get_document", { documentUuid: "document-private" }, "Document not found"],
  ["chorus_get_proposal", { proposalUuid: "proposal-private" }, "Proposal not found"],
  ["chorus_get_project", { projectUuid: "private" }, "Project not found"],
  ["chorus_add_comment", { targetType: "task", targetUuid: "task-private", content: "hi" }, "task not found"],
  ["chorus_pm_create_idea", { projectUuid: "private", title: "New" }, "Project not found"],
  ["chorus_pm_update_document_draft", { proposalUuid: "proposal-private", draftUuid: "draft", content: "x" }, "Proposal not found"],
  ["chorus_claim_task", { taskUuid: "task-private" }, "Task not found"],
  ["chorus_admin_verify_task", { taskUuid: "task-private" }, "Task not found"],
  ["chorus_session_checkin_task", { sessionUuid: "session", taskUuid: "task-private" }, "Task not found"],
  ["chorus_update_reference", { uuid: "reference-private", title: "New" }, "Failed to update reference: Reference with UUID reference-private not found"],
];

const storedSourceTools = ["chorus_pm_validate_proposal", "chorus_pm_submit_proposal"] as const;
const sourceTypes = ["idea", "document"] as const;
const sourceCallCases = storedSourceTools.flatMap((name) => sourceTypes.map((inputType) => ({ name, inputType })));

function setProposalInputs(inputType: "idea" | "document", inputUuids: string[], projectUuid = "public") {
  const proposal = fixture.rows.proposal.find((row) => row.uuid === `proposal-${projectUuid}`)!;
  Object.assign(proposal, { inputType, inputUuids });
  return proposal;
}

describe("MCP central project access", () => {
  it.each([
    ["chorus_get_project", { projectUuid: "private" }],
    ["chorus_get_project_groups", {}],
    ["chorus_get_project_group", { groupUuid: "group" }],
    ["chorus_get_group_dashboard", { groupUuid: "group" }],
  ] as const)("requires project:read for %s even when the owner is an inherited group Editor", async (tool, params) => {
    fixture.rows.projectGroupMember.push({ companyUuid: "company", groupUuid: "group", userUuid: "group-editor", role: "editor" });
    const { handlers, originals } = register(auth("group-editor", ["task:read"]));
    const response = await handlers[tool](params);
    expect(response.isError).toBe(true);
    expect(response.content).toEqual([{ type: "text", text: "Missing agent capability: project:read" }]);
    expect(originals[tool]).not.toHaveBeenCalled();
    expect(eventBus.emitPresence).not.toHaveBeenCalled();
  });

  it("search intersects requested entity types with agent read capabilities", async () => {
    const { handlers } = register(auth("admin", ["task:read"]));
    await handlers.chorus_search({ query: "secret", entityTypes: ["task", "project_group", "idea"] });
    expect(fixture.services.search.search).toHaveBeenCalledWith(expect.objectContaining({ entityTypes: ["task"] }));
    fixture.services.search.search.mockClear();
    const result = await handlers.chorus_search({ query: "secret", entityTypes: ["project_group"] });
    expect(fixture.services.search.search).not.toHaveBeenCalled();
    expect((result.content[0] as { text: string }).text).not.toContain("secret");
  });

  it("project-only local grants cannot read the explicit group roster through includeMembers", async () => {
    const { handlers } = register(auth("editor"));
    await expect(handlers.chorus_get_project_group({ groupUuid: "group", includeMembers: true }))
      .rejects.toThrow("Insufficient project group access");
  });

  it("group audit comments cannot be addressed through the project comment tool", async () => {
    const { handlers, originals } = register(auth("admin"));
    const response = await handlers.chorus_get_comments({ targetType: "project_group", targetUuid: "group" });
    expect(response.isError).toBe(true);
    expect(originals.chorus_get_comments).not.toHaveBeenCalled();
  });
  it.each(entityCalls)("hides %s before its actual handler and presence", async (name, params, text) => {
    const { handlers, originals } = register(auth("nonmember"));
    expect(await handlers[name](params)).toEqual({ content: [{ type: "text", text }], isError: true });
    expect(originals[name]).not.toHaveBeenCalled();
    expect(eventBus.emitPresence).not.toHaveBeenCalled();
  });

  it.each(entityCalls.slice(0, 5))("allows viewer reads through %s", async (name, params) => {
    const { handlers, originals } = register(auth("viewer"));
    expect((await handlers[name](params)).isError).not.toBe(true);
    expect(originals[name]).toHaveBeenCalledOnce();
    if (name !== "chorus_get_project") expect(eventBus.emitPresence).toHaveBeenCalledWith(
      expect.objectContaining({ projectUuid: "private", action: "view" }),
    );
  });

  it.each(entityCalls.slice(5))("forbids viewer writes through %s before handler and presence", async (name, params) => {
    const { handlers, originals } = register(auth("viewer"));
    expect(await handlers[name](params)).toEqual({
      content: [{ type: "text", text: "Insufficient project access" }], isError: true,
    });
    expect(originals[name]).not.toHaveBeenCalled();
    expect(eventBus.emitPresence).not.toHaveBeenCalled();
  });

  it.each([
    entityCalls[5], entityCalls[6], entityCalls[8], entityCalls[9], entityCalls[10],
  ])("allows editors through the actual %s handler", async (name, params) => {
    const { handlers, originals } = register(auth("editor"));
    expect((await handlers[name](params)).isError).not.toBe(true);
    expect(originals[name]).toHaveBeenCalledOnce();
  });

  it("keeps public reads and management open to ownerless company agents", async () => {
    const { handlers } = register(auth());
    expect((await handlers.chorus_get_task({ taskUuid: "task-public" })).isError).not.toBe(true);
    expect((await handlers.chorus_admin_move_project_to_group({ projectUuid: "public", groupUuid: null })).isError).not.toBe(true);
    expect(fixture.services.group.moveProjectToGroup).toHaveBeenCalledOnce();
  });

  it("hides private entities from ownerless agents", async () => {
    const { handlers, originals } = register(auth());
    expect(await handlers.chorus_get_task({ taskUuid: "task-private" })).toEqual({
      content: [{ type: "text", text: "Task not found" }], isError: true,
    });
    expect(originals.chorus_get_task).not.toHaveBeenCalled();
    expect(eventBus.emitPresence).not.toHaveBeenCalled();
  });

  it.each(["viewer", "editor"])("requires private admin for a group move by %s", async (owner) => {
    const { handlers, originals } = register(auth(owner));
    expect((await handlers.chorus_admin_move_project_to_group({ projectUuid: "private", groupUuid: null })).isError).toBe(true);
    expect(originals.chorus_admin_move_project_to_group).not.toHaveBeenCalled();
    expect(eventBus.emitPresence).not.toHaveBeenCalled();
  });

  it("allows a private admin to move a project", async () => {
    const { handlers } = register(auth("admin"));
    expect((await handlers.chorus_admin_move_project_to_group({ projectUuid: "private", groupUuid: null })).isError).not.toBe(true);
  });

  it("does not let a forged projectUuid hide the actual entity project", async () => {
    const { handlers, originals } = register(auth("nonmember"));
    expect(await handlers.chorus_get_task({ taskUuid: "task-private", projectUuid: "public" })).toEqual({
      content: [{ type: "text", text: "Task not found" }], isError: true,
    });
    expect(originals.chorus_get_task).not.toHaveBeenCalled();
    expect(eventBus.emitPresence).not.toHaveBeenCalled();
  });

  it("rejects visible mismatched project/entity pairs too", async () => {
    const { handlers, originals } = register(auth("editor"));
    expect((await handlers.chorus_create_tasks({ projectUuid: "public", proposalUuid: "proposal-private", tasks: [] })).isError).toBe(true);
    expect(originals.chorus_create_tasks).not.toHaveBeenCalled();
    expect(eventBus.emitPresence).not.toHaveBeenCalled();
  });

  it.each(["missing", "foreign"])("matches hidden and %s task errors", async (suffix) => {
    const { handlers } = register(auth("nonmember"));
    const hidden = await handlers.chorus_get_task({ taskUuid: "task-private" });
    expect(await handlers.chorus_get_task({ taskUuid: `task-${suffix}` })).toEqual(hidden);
    expect(eventBus.emitPresence).not.toHaveBeenCalled();
  });

  it.each([
    ["chorus_move_idea", { ideaUuid: "idea-public", targetProjectUuid: "private" }],
    ["chorus_update_task", { taskUuid: "task-public", addDependsOn: ["task-private"] }],
    ["chorus_update_task", { taskUuid: "task-public", removeDependsOn: ["task-private"] }],
    ["chorus_create_tasks", { projectUuid: "public", tasks: [{ title: "New", dependsOnTaskUuids: ["task-private"] }] }],
    ["chorus_pm_create_proposal", { projectUuid: "public", inputType: "idea", inputUuids: ["idea-private"], title: "New" }],
    ["chorus_pm_create_proposal", { projectUuid: "public", inputType: "document", inputUuids: ["document-private"], title: "New" }],
    ["chorus_pm_create_idea", { projectUuid: "public", parentUuid: "idea-private", title: "New" }],
  ] as [string, Record<string, unknown>][])("checks secondary projects for %s before any handler/presence", async (name, params) => {
    const { handlers, originals } = register(auth("nonmember"));
    expect((await handlers[name](params)).isError).toBe(true);
    expect(originals[name]).not.toHaveBeenCalled();
    expect(eventBus.emitPresence).not.toHaveBeenCalled();
  });

  it("resolves commentUuid through the stored comment target", async () => {
    await expect(authorizeToolProjectAccess("chorus_update_task", { commentUuid: "comment-private" }, auth("nonmember"),
      getToolProjectAccessPolicy("chorus_update_task"))).rejects.toThrow("Comment not found");
    expect(fixture.prisma.comment.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { uuid: "comment-private", companyUuid: "company" },
    }));
  });

  it("authorizes all proposal sources without forbidding accessible cross-project inputs", async () => {
    const resources = await authorizeToolProjectAccess(
      "chorus_pm_create_proposal",
      { projectUuid: "public", inputType: "document", inputUuids: ["document-private"] },
      auth("editor"),
      getToolProjectAccessPolicy("chorus_pm_create_proposal"),
    );
    expect(resources.map((r) => r.projectUuid)).toEqual(["public", "private"]);
  });

  describe("proposal reuse warning isolation", () => {
    const params = {
      projectUuid: "public", title: "My proposal",
      inputType: "idea", inputUuids: ["idea-public"],
    };

    beforeEach(() => {
      Object.assign(fixture.rows.idea.find((row) => row.uuid === "idea-public")!, {
        assigneeType: "agent", assigneeUuid: "agent",
      });
      Object.assign(fixture.rows.proposal.find((row) => row.uuid === "proposal-public")!, {
        title: "Visible public proposal",
      });
      Object.assign(fixture.rows.proposal.find((row) => row.uuid === "proposal-private")!, {
        title: "SECRET PRIVATE PROPOSAL TITLE", inputUuids: ["idea-public"],
      });
      Object.assign(fixture.rows.proposal.find((row) => row.uuid === "proposal-foreign")!, {
        title: "SECRET OTHER COMPANY PROPOSAL", inputUuids: ["idea-public"],
      });
    });

    it.each(["nonmember", "ownerless", "revoked"])(
      "excludes hidden proposal titles and UUIDs for %s without suppressing public reuse",
      async (principal) => {
        if (principal === "revoked") {
          fixture.rows.projectMember.push({
            companyUuid: "company", projectUuid: "private", userUuid: principal, role: "viewer",
          });
          expect((await getProjectAccess(auth(principal), "private")).level).toBe("viewer");
          fixture.rows.projectMember = fixture.rows.projectMember.filter((row) => row.userUuid !== principal);
        }
        // A new auth context models the next stateless MCP request after removal.
        const actor = auth(principal === "ownerless" ? undefined : principal);
        expect((await getProjectAccess(actor, "private")).level).toBe("none");
        const { handlers, originals } = register(actor);
        const response = await handlers.chorus_pm_create_proposal(params);
        const text = (response.content[0] as { text: string }).text;

        expect(response.isError).not.toBe(true);
        expect(text).toContain('"uuid": "new-proposal"');
        expect(text).toContain('Note: Idea is also referenced by existing Proposal(s): "Visible public proposal"');
        expect(text).not.toContain("SECRET");
        expect(text).not.toContain("proposal-private");
        expect(text).not.toContain("proposal-foreign");
        expect(originals.chorus_pm_create_proposal).toHaveBeenCalledOnce();
        expect(fixture.services.proposal.checkIdeasAvailability).toHaveBeenCalledWith(actor, ["idea-public"]);
        // The actual service result, not only the final warning, excludes hidden UUIDs.
        expect(await fixture.services.proposal.checkIdeasAvailability.mock.results[0].value).toEqual({
          available: false,
          usedIdeas: [{
            uuid: "idea-public", proposalUuid: "proposal-public", proposalTitle: "Visible public proposal",
          }],
        });
        expect(fixture.prisma.proposal.create).toHaveBeenCalledOnce();
      },
    );

    it.each(["viewer", "editor", "admin"])(
      "preserves readable cross-project reuse warnings for a private %s's agent",
      async (principal) => {
        const { handlers } = register(auth(principal));
        const response = await handlers.chorus_pm_create_proposal(params);
        const text = (response.content[0] as { text: string }).text;

        expect(response.isError).not.toBe(true);
        expect(text).toContain("Visible public proposal");
        expect(text).toContain("SECRET PRIVATE PROPOSAL TITLE");
        expect(text).not.toContain("SECRET OTHER COMPANY PROPOSAL");
        expect(await fixture.services.proposal.checkIdeasAvailability.mock.results[0].value).toMatchObject({
          usedIdeas: [
            { proposalUuid: "proposal-private" },
            { proposalUuid: "proposal-public" },
          ],
        });
        expect(fixture.prisma.proposal.create).toHaveBeenCalledOnce();
      },
    );

    it("does not emit a reuse warning when only hidden proposals reference the input", async () => {
      fixture.rows.proposal.find((row) => row.uuid === "proposal-public")!.inputUuids = [];
      const { handlers } = register(auth("nonmember"));
      const response = await handlers.chorus_pm_create_proposal(params);

      expect(response.isError).not.toBe(true);
      expect(JSON.parse((response.content[0] as { text: string }).text)).toEqual({
        uuid: "new-proposal", title: "My proposal", status: "draft",
      });
      expect(await fixture.services.proposal.checkIdeasAvailability.mock.results[0].value).toEqual({
        available: true, usedIdeas: [],
      });
    });

    it("keeps the installed SDK response free of private reuse data", async () => {
      const server = createMcpServer(auth("nonmember"));
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "proposal-reuse-test", version: "1" });
      try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        const response = await client.callTool({ name: "chorus_pm_create_proposal", arguments: params });

        expect(response.isError).not.toBe(true);
        expect(JSON.stringify(response)).toContain("Visible public proposal");
        expect(JSON.stringify(response)).not.toContain("SECRET");
        expect(JSON.stringify(response)).not.toContain("proposal-private");
        expect(fixture.prisma.proposal.create).toHaveBeenCalledOnce();
      } finally {
        await client.close();
        await server.close();
      }
    });
  });

  describe("persisted proposal source access", () => {
    const deniedCases = sourceCallCases.flatMap((source) =>
      ["nonmember", "revoked", "ownerless"].map((principal) => ({ ...source, principal })));

    it.each(deniedCases)(
      "hides stored $inputType sources from $principal through $name before handler and presence",
      async ({ name, inputType, principal }) => {
        const proposal = setProposalInputs(inputType, [`${inputType}-public`, `${inputType}-private`]);
        if (principal === "revoked") {
          fixture.rows.projectMember.push({ projectUuid: "private", userUuid: "revoked", role: "viewer" });
          expect((await getProjectAccess(auth("revoked"), "private")).level).toBe("viewer");
          fixture.rows.projectMember = fixture.rows.projectMember.filter((member) => member.userUuid !== "revoked");
        }
        const { handlers, originals } = register(auth(principal === "ownerless" ? undefined : principal));
        // Sources are persisted on the public proposal, never supplied in the request.
        const params = { proposalUuid: proposal.uuid };
        const denied = await handlers[name](params);
        expect(denied).toEqual({
          content: [{ type: "text", text: `${inputType === "idea" ? "Idea" : "Document"} not found` }],
          isError: true,
        });
        const privateSource = fixture.rows[inputType].find((row) => row.uuid === `${inputType}-private`)!;
        expect(JSON.stringify(denied)).not.toContain(privateSource.title);
        expect(JSON.stringify(denied)).not.toContain(
          inputType === "idea" ? privateSource.elaborationStatus : privateSource.status,
        );
        expect(originals[name]).not.toHaveBeenCalled();
        expect(fixture.services.proposal.validateProposal).not.toHaveBeenCalled();
        expect(fixture.services.proposal.submitProposal).not.toHaveBeenCalled();
        expect(fixture.prisma.idea.findMany).not.toHaveBeenCalled();
        expect(fixture.prisma.proposal.update).not.toHaveBeenCalled();
        expect(eventBus.emitChange).not.toHaveBeenCalled();
        expect(eventBus.emitPresence).not.toHaveBeenCalled();

        // A private source is indistinguishable from a missing source.
        proposal.inputUuids = [`${inputType}-missing`];
        expect(await handlers[name](params)).toEqual(denied);
        expect(originals[name]).not.toHaveBeenCalled();
        expect(eventBus.emitPresence).not.toHaveBeenCalled();
      },
    );

    it.each(sourceCallCases)(
      "allows a viewer to read stored cross-project $inputType sources through $name",
      async ({ name, inputType }) => {
        const proposal = setProposalInputs(inputType, [`${inputType}-public`, `${inputType}-private`]);
        fixture.rows.idea[0].elaborationStatus = "resolved";
        const actor = auth("viewer");
        expect((await getProjectAccess(actor, "private")).level).toBe("viewer");
        expect((await getProjectAccess(actor, "public")).level).toBe("editor");
        const { handlers, originals } = register(actor);
        const response = await handlers[name]({ proposalUuid: proposal.uuid });
        expect(response.isError).not.toBe(true);
        expect(originals[name]).toHaveBeenCalledOnce();
        expect(eventBus.emitPresence).toHaveBeenCalledWith(expect.objectContaining({
          projectUuid: "public", entityType: "proposal", entityUuid: proposal.uuid,
        }));
        if (name === "chorus_pm_validate_proposal") {
          expect(JSON.parse((response.content[0] as { text: string }).text)).toMatchObject({ valid: true });
          expect(fixture.services.proposal.validateProposal).toHaveBeenCalledWith("company", proposal.uuid);
        } else {
          expect(JSON.parse((response.content[0] as { text: string }).text)).toEqual({
            uuid: proposal.uuid, status: "pending",
          });
          expect(fixture.services.proposal.submitProposal).toHaveBeenCalledWith(proposal.uuid, "company");
          expect(fixture.prisma.proposal.update).toHaveBeenCalledOnce();
        }
        if (inputType === "document") expect(fixture.prisma.idea.findMany).not.toHaveBeenCalled();
      },
    );

    it.each(storedSourceTools)(
      "allows an authorized viewer to receive real private-source validation issues through %s",
      async (name) => {
        const proposal = setProposalInputs("idea", ["idea-private"]);
        const { handlers, originals } = register(auth("viewer"));
        const response = await handlers[name]({ proposalUuid: proposal.uuid });
        const text = (response.content[0] as { text: string }).text;
        expect(text).toContain("CONFIDENTIAL ACQUISITION");
        expect(text).toContain("status: pending");
        if (name === "chorus_pm_validate_proposal") {
          expect(JSON.parse(text)).toMatchObject({
            valid: false,
            issues: [expect.objectContaining({ id: "E5", field: "CONFIDENTIAL ACQUISITION" })],
          });
        } else {
          expect(response.isError).toBe(true);
          expect(text).toContain("Proposal validation failed");
        }
        expect(originals[name]).toHaveBeenCalledOnce();
        expect(fixture.prisma.idea.findMany).toHaveBeenCalledWith(expect.objectContaining({
          where: { uuid: { in: ["idea-private"] }, companyUuid: "company" },
          select: { uuid: true, title: true, elaborationStatus: true },
        }));
        expect(fixture.prisma.proposal.update).not.toHaveBeenCalled();
      },
    );

    it.each(sourceCallCases)(
      "keeps public-only stored $inputType sources accessible to ownerless agents through $name",
      async ({ name, inputType }) => {
        const proposal = setProposalInputs(inputType, [`${inputType}-public`]);
        const { handlers, originals } = register(auth());
        expect((await handlers[name]({ proposalUuid: proposal.uuid })).isError).not.toBe(true);
        expect(originals[name]).toHaveBeenCalledOnce();
      },
    );

    it.each(sourceCallCases)(
      "still requires destination write access for $name despite readable $inputType sources",
      async ({ name, inputType }) => {
        const proposal = setProposalInputs(inputType, [`${inputType}-public`], "private");
        const { handlers, originals } = register(auth("viewer"));
        expect(await handlers[name]({ proposalUuid: proposal.uuid })).toEqual({
          content: [{ type: "text", text: "Insufficient project access" }], isError: true,
        });
        expect(originals[name]).not.toHaveBeenCalled();
        expect(eventBus.emitPresence).not.toHaveBeenCalled();
      },
    );

    it.each(sourceTypes)(
      "preserves admin approval of own drafts without reading stored private %s inputs",
      async (inputType) => {
        const proposal = setProposalInputs(inputType, [`${inputType}-private`]);
        proposal.status = "pending";
        const { handlers, originals } = register(auth("nonmember"));
        const response = await handlers.chorus_admin_approve_proposal({ proposalUuid: proposal.uuid });
        expect(response.isError).not.toBe(true);
        expect(JSON.parse((response.content[0] as { text: string }).text)).toEqual({
          uuid: proposal.uuid, status: "approved",
        });
        expect(originals.chorus_admin_approve_proposal).toHaveBeenCalledOnce();
        expect(fixture.services.proposal.approveProposal).toHaveBeenCalledWith(proposal.uuid, "company", "agent", null);
        expect(fixture.services.proposal.validateProposal).not.toHaveBeenCalled();
        expect(fixture.prisma[inputType].findFirst).not.toHaveBeenCalled();
        expect(fixture.prisma[inputType].findMany).not.toHaveBeenCalled();
      },
    );
  });

  it.each(["chorus_get_session", "chorus_close_session"])("gates all active tasks of %s", async (name) => {
    const { handlers, originals } = register(auth("nonmember"));
    expect((await handlers[name]({ sessionUuid: "private-session" })).isError).toBe(true);
    expect(originals[name]).not.toHaveBeenCalled();
    expect(fixture.services.session.getSession).not.toHaveBeenCalled();
    expect(eventBus.emitPresence).not.toHaveBeenCalled();
  });

  it("preserves compact session outputs without exposing historical or active checkin UUIDs", async () => {
    fixture.services.session.listAgentSessions.mockResolvedValueOnce([{
      uuid: "private-session", agentUuid: "agent", name: "Worker", status: "active",
      checkins: [{ taskUuid: "task-private" }],
    }]);
    const { handlers } = register(auth("nonmember"));
    const listed = await handlers.chorus_list_sessions({ page: 1, pageSize: 20 });
    expect((listed.content[0] as { text: string }).text).not.toContain("task-private");
    const closed = await handlers.chorus_close_session({ sessionUuid: "session" });
    expect(JSON.parse((closed.content[0] as { text: string }).text)).toEqual({ uuid: "session", status: "closed" });
  });

  it.each(["nonmember", "viewer", "editor"])("rejects full-group deletion/ungrouping for %s atomically", async (owner) => {
    const { handlers, originals } = register(auth(owner));
    expect((await handlers.chorus_admin_delete_project_group({ groupUuid: "group" })).isError).toBe(true);
    expect(originals.chorus_admin_delete_project_group).not.toHaveBeenCalled();
    expect(fixture.services.group.deleteProjectGroup).not.toHaveBeenCalled();
    expect(eventBus.emitPresence).not.toHaveBeenCalled();
    expect(fixture.prisma.project.findMany).not.toHaveBeenCalled();
  });

  it("allows deletion of an empty group and a group whose private projects are administered", async () => {
    const { handlers } = register(auth("admin"));
    expect((await handlers.chorus_admin_delete_project_group({ groupUuid: "group" })).isError).not.toBe(true);
    fixture.rows.project = [];
    expect((await handlers.chorus_admin_delete_project_group({ groupUuid: "group" })).isError).not.toBe(true);
  });

  it("returns visibility and effective owner membership in get_project", async () => {
    const { handlers } = register(auth("editor"));
    const response = await handlers.chorus_get_project({ projectUuid: "private" });
    expect(JSON.parse((response.content[0] as { text: string }).text)).toMatchObject({
      visibility: "private", accessLevel: "editor",
    });
  });

  it("keeps agent capability bits independent of owner access", () => {
    const { handlers } = register(auth("admin", []));
    expect(handlers.chorus_admin_verify_task).toBeUndefined();
    expect(handlers.chorus_claim_task).toBeUndefined();
    expect(handlers.chorus_get_task).toBeDefined();
  });

  it("propagates authorization database errors without handler or presence", async () => {
    const { handlers, originals } = register(auth("editor"));
    fixture.prisma.task.findFirst.mockRejectedValueOnce(new Error("Access DB unavailable"));
    await expect(handlers.chorus_get_task({ taskUuid: "task-private" })).rejects.toThrow("Access DB unavailable");
    expect(originals.chorus_get_task).not.toHaveBeenCalled();
    expect(eventBus.emitPresence).not.toHaveBeenCalled();
  });

  it("uses the installed SDK's tools/call error shape on hidden entities and auth failures", async () => {
    const server = createMcpServer(auth("nonmember"));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "access-test", version: "1" });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const hidden = await client.callTool({ name: "chorus_get_task", arguments: { taskUuid: "task-private" } });
      const missing = await client.callTool({ name: "chorus_get_task", arguments: { taskUuid: "missing" } });
      expect(hidden).toEqual(missing);
      expect(hidden).toEqual({ content: [{ type: "text", text: "Task not found" }], isError: true });
      fixture.prisma.task.findFirst.mockRejectedValueOnce(new Error("Access DB unavailable"));
      expect(await client.callTool({ name: "chorus_get_task", arguments: { taskUuid: "task-private" } })).toEqual({
        content: [{ type: "text", text: "Access DB unavailable" }], isError: true,
      });
      expect(fixture.services.task.getTask).not.toHaveBeenCalled();
      expect(eventBus.emitPresence).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("passes auth and header project scopes to filtered service callers", async () => {
    const actor = { ...auth("nonmember"), projectUuids: ["public"] };
    const { handlers } = register(actor);
    await handlers.chorus_list_projects({ page: 1, pageSize: 20 });
    await handlers.chorus_search({ query: "Task", scope: "global" });
    await handlers.chorus_get_project_groups({ page: 1, pageSize: 20 });
    await handlers.chorus_get_project_group({ groupUuid: "group" });
    await handlers.chorus_get_group_dashboard({ groupUuid: "group" });
    await handlers.chorus_get_available_tasks({ projectUuid: "public", proposalUuids: ["proposal-public"] });
    await handlers.chorus_get_my_assignments({});
    await handlers.chorus_checkin({});
    expect(fixture.services.project.listProjects).toHaveBeenCalledWith(expect.objectContaining({ auth: actor }));
    expect(fixture.services.search.search).toHaveBeenCalledWith(expect.objectContaining({ auth: actor, projectUuids: actor.projectUuids }));
    expect(fixture.services.group.listProjectGroups).toHaveBeenCalledWith("company", actor);
    expect(fixture.services.group.getProjectGroup).toHaveBeenCalledWith("company", "group", actor);
    expect(fixture.services.group.getGroupDashboard).toHaveBeenCalledWith("company", "group", actor);
    expect(fixture.services.assignment.getAvailableItems).toHaveBeenCalledWith("company", "public", false, true, ["proposal-public"], actor);
    expect(fixture.services.assignment.getMyAssignments).toHaveBeenCalledWith(actor, actor.projectUuids);
    expect(fixture.services.checkin.buildCheckinResponse).toHaveBeenCalledWith(actor);
  });
});
