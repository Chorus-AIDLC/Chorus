import { beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";

const services = vi.hoisted(() => ({
  project: {
    getProjectByUuid: vi.fn(),
    listProjects: vi.fn(),
    projectExists: vi.fn(),
  },
  idea: { listIdeas: vi.fn() },
  document: { listDocuments: vi.fn() },
  proposal: { listProposals: vi.fn() },
  task: { listTasks: vi.fn(), getUnblockedTasks: vi.fn() },
  activity: { listActivities: vi.fn() },
  comment: { listComments: vi.fn() },
  assignment: { getAvailableItems: vi.fn(), getMyAssignments: vi.fn() },
  notification: { list: vi.fn(), markRead: vi.fn() },
  session: { listAgentSessions: vi.fn() },
  search: { search: vi.fn() },
  checkin: { buildCheckinResponse: vi.fn() },
  projectGroup: { getGroupDashboard: vi.fn() },
}));

vi.mock("@/services/project.service", () => services.project);
vi.mock("@/services/idea.service", () => services.idea);
vi.mock("@/services/document.service", () => services.document);
vi.mock("@/services/proposal.service", () => services.proposal);
vi.mock("@/services/task.service", () => services.task);
vi.mock("@/services/activity.service", () => services.activity);
vi.mock("@/services/comment.service", () => services.comment);
vi.mock("@/services/assignment.service", () => services.assignment);
vi.mock("@/services/notification.service", () => services.notification);
vi.mock("@/services/session.service", () => services.session);
vi.mock("@/services/reference-artifact.service", () => ({
  REFERENCE_TYPES: ["docs", "repo", "issue_pr", "paper_blog"],
}));
vi.mock("@/services/elaboration.service", () => ({}));
vi.mock("@/services/project-group.service", () => services.projectGroup);
vi.mock("@/services/mention.service", () => ({}));
vi.mock("@/services/search.service", () => services.search);
vi.mock("@/services/checkin.service", () => services.checkin);

import { registerPublicTools } from "@/mcp/tools/public";
import { registerSessionTools } from "@/mcp/tools/session";
import type { AgentAuthContext } from "@/types/auth";

type Handler = (params: Record<string, unknown>) => Promise<{
  content: Array<{ text: string }>;
}>;

const handlers: Record<string, Handler> = {};
const schemas: Record<string, z.ZodType> = {};
const server = {
  registerTool: (
    name: string,
    config: { inputSchema: z.ZodType },
    handler: Handler,
  ) => {
    schemas[name] = config.inputSchema;
    handlers[name] = handler;
  },
};
const auth: AgentAuthContext = {
  type: "agent",
  companyUuid: "company-1",
  actorUuid: "agent-1",
  ownerUuid: "owner-1",
  roles: ["admin_agent"],
  permissions: [],
  agentName: "Agent",
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.keys(handlers).forEach((key) => delete handlers[key]);
  Object.keys(schemas).forEach((key) => delete schemas[key]);
  registerPublicTools(server as never, auth);
  registerSessionTools(server as never, auth);
  services.project.getProjectByUuid.mockResolvedValue({ uuid: "project-1" });
});

describe("MCP collection migration", () => {
  it.each([
    ["chorus_checkin", () => {
      services.checkin.buildCheckinResponse.mockResolvedValue({
        agent: { uuid: "agent-1", name: "Agent" },
        ideaTracker: {
          project: {
            name: "Project",
            ideas: Array.from({ length: 100 }, (_, index) => ({
              uuid: `idea-${index}`,
              title: "界".repeat(256),
            })),
          },
        },
        notifications: [],
      });
    }],
    ["chorus_get_my_assignments", () => {
      services.assignment.getMyAssignments.mockResolvedValue({
        ideaTracker: {
          project: {
            name: "Project",
            ideas: Array.from({ length: 100 }, (_, index) => ({
              uuid: `idea-${index}`,
              title: "界".repeat(256),
            })),
          },
        },
        taskTracker: {
          project: {
            name: "Project",
            tasks: Array.from({ length: 100 }, (_, index) => ({
              uuid: `task-${index}`,
              title: "界".repeat(256),
            })),
          },
        },
      });
    }],
    ["chorus_get_group_dashboard", () => {
      services.projectGroup.getGroupDashboard.mockResolvedValue({
        group: { uuid: "group-1", name: "Group" },
        recentActivities: Array.from({ length: 20 }, (_, index) => ({
          uuid: `activity-${index}`,
          content: "界".repeat(2_000),
        })),
      });
    }],
  ])("guards the final %s aggregate JSON", async (tool, arrange) => {
    arrange();
    const response = await handlers[tool](
      tool === "chorus_get_group_dashboard" ? { groupUuid: "group-1" } : {},
    );

    expect(Buffer.byteLength(response.content[0].text, "utf8")).toBeLessThanOrEqual(
      65_536,
    );
  });

  it("uses shared defaults and maximum validation for every page collection", () => {
    const tools = [
      "chorus_list_projects",
      "chorus_get_ideas",
      "chorus_get_documents",
      "chorus_get_proposals",
      "chorus_list_tasks",
      "chorus_get_activity",
      "chorus_get_comments",
      "chorus_get_unblocked_tasks",
      "chorus_get_project_groups",
      "chorus_list_sessions",
    ];

    for (const tool of tools) {
      const base = tool === "chorus_list_projects" ||
          tool === "chorus_list_sessions" ||
          tool === "chorus_get_project_groups"
        ? {}
        : tool === "chorus_get_comments"
          ? { targetType: "task", targetUuid: "task-1" }
          : { projectUuid: "project-1" };
      const parsed = schemas[tool].parse(base) as { page: number; pageSize: number };
      expect(parsed.page, tool).toBe(1);
      expect(parsed.pageSize, tool).toBe(20);
      expect(schemas[tool].safeParse({ ...base, pageSize: 101 }).success, tool)
        .toBe(false);
    }
  });

  it("keeps task filters but emits compact rows under the byte ceiling", async () => {
    const long = "界".repeat(20_000);
    services.task.listTasks.mockResolvedValue({
      tasks: Array.from({ length: 20 }, (_, index) => ({
        uuid: `task-${index}`,
        title: long,
        description: long,
        acceptanceCriteria: long,
        comments: [{ content: long }],
        status: "open",
        priority: "high",
        proposalUuid: "proposal-1",
      })),
      total: 500,
    });

    const response = await handlers.chorus_list_tasks({
      projectUuid: "project-1",
      status: "open",
      priority: "high",
      proposalUuids: ["proposal-1"],
      page: 2,
      pageSize: 20,
    });
    const text = response.content[0].text;
    const payload = JSON.parse(text);

    expect(services.task.listTasks).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "open",
        priority: "high",
        proposalUuids: ["proposal-1"],
        skip: 20,
        take: 20,
      }),
    );
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(65_536);
    expect(payload).toMatchObject({
      returned: 20,
      page: 2,
      pageSize: 20,
      total: 500,
    });
    expect(payload.tasks[0].title).toHaveLength(256);
    expect(payload.tasks[0]).not.toHaveProperty("description");
    expect(payload.tasks[0]).not.toHaveProperty("acceptanceCriteria");
    expect(payload.tasks[0]).not.toHaveProperty("comments");
  });

  it("preserves authoritative fields for list-only resources", async () => {
    services.activity.listActivities.mockResolvedValue({
      activities: [{
        uuid: "activity-1",
        action: "updated",
        targetType: "task",
        targetUuid: "task-1",
        actorType: "agent",
        actorUuid: "agent-1",
        value: { status: "done" },
        sessionUuid: "session-1",
        sessionName: "Worker",
        createdAt: "2026-07-30T12:00:00.000Z",
      }],
      total: 1,
    });
    services.comment.listComments.mockResolvedValue({
      comments: [{
        uuid: "comment-1",
        targetType: "task",
        targetUuid: "task-1",
        content: "full comment body",
        author: { type: "user", uuid: "user-1", name: "Owner" },
        createdAt: "2026-07-30T12:00:00.000Z",
        updatedAt: "2026-07-30T12:00:00.000Z",
      }],
      total: 1,
    });
    services.notification.list.mockResolvedValue({
      notifications: [{
        uuid: "notification-1",
        projectUuid: "project-1",
        projectName: "Project",
        recipientType: "agent",
        recipientUuid: "agent-1",
        entityType: "idea",
        entityUuid: "idea-1",
        entityTitle: "Idea",
        action: "human_instruction",
        message: "Resume work",
        actorType: "user",
        actorUuid: "user-1",
        actorName: "Owner",
        readAt: null,
        archivedAt: null,
        createdAt: "2026-07-30T12:00:00.000Z",
        instructionText: "Deploy after completion",
      }],
      total: 1,
      unreadCount: 1,
    });

    const activity = JSON.parse((await handlers.chorus_get_activity({
      projectUuid: "project-1",
      page: 1,
      pageSize: 20,
    })).content[0].text);
    const comments = JSON.parse((await handlers.chorus_get_comments({
      targetType: "task",
      targetUuid: "task-1",
      page: 1,
      pageSize: 20,
    })).content[0].text);
    const notifications = JSON.parse((await handlers.chorus_get_notifications({
      status: "all",
      limit: 20,
      offset: 0,
      autoMarkRead: false,
    })).content[0].text);

    expect(activity.activities[0]).toMatchObject({
      value: { status: "done" },
      sessionUuid: "session-1",
      sessionName: "Worker",
    });
    expect(comments.comments[0]).toMatchObject({
      content: "full comment body",
      author: { type: "user", uuid: "user-1", name: "Owner" },
    });
    expect(notifications.notifications[0]).toMatchObject({
      message: "Resume work",
      actorName: "Owner",
      instructionText: "Deploy after completion",
    });
  });

  it("requests comment pages in newest-first offset order", async () => {
    services.comment.listComments.mockResolvedValue({ comments: [], total: 0 });

    await handlers.chorus_get_comments({
      targetType: "idea",
      targetUuid: "idea-1",
      page: 3,
      pageSize: 10,
    });

    expect(services.comment.listComments).toHaveBeenCalledWith({
      companyUuid: "company-1",
      targetType: "idea",
      targetUuid: "idea-1",
      skip: 20,
      take: 10,
    });
  });

  it("traverses every task page exactly once without mutating service rows", async () => {
    const serviceRows = Array.from({ length: 37 }, (_, index) => ({
      uuid: `task-${index}`,
      title: `Task ${index}`,
      description: `Full REST detail ${index}`,
      acceptanceCriteria: `Criterion ${index}`,
      status: "open",
      priority: "high",
      proposalUuid: "proposal-1",
    }));
    services.task.listTasks.mockImplementation(
      async ({ skip, take }: { skip: number; take: number }) => ({
        tasks: serviceRows.slice(skip, skip + take),
        total: serviceRows.length,
      }),
    );

    const seen: string[] = [];
    for (const page of [1, 2]) {
      const response = await handlers.chorus_list_tasks({
        projectUuid: "project-1",
        page,
        pageSize: 20,
      });
      const payload = JSON.parse(response.content[0].text);

      expect(payload).toMatchObject({
        returned: page === 1 ? 20 : 17,
        page,
        pageSize: 20,
        total: 37,
      });
      expect(payload.tasks).toHaveLength(payload.returned);
      expect(payload.tasks.every(
        (task: Record<string, unknown>) => !("description" in task),
      )).toBe(true);
      seen.push(...payload.tasks.map((task: { uuid: string }) => task.uuid));
    }

    expect(seen).toEqual(serviceRows.map((task) => task.uuid));
    expect(new Set(seen)).toHaveLength(serviceRows.length);
    expect(serviceRows[0]).toMatchObject({
      description: "Full REST detail 0",
      acceptanceCriteria: "Criterion 0",
    });
  });

  it("passes UUID search filters through and emits a compact bounded result", async () => {
    const uuid = "123e4567-e89b-42d3-a456-426614174000";
    services.search.search.mockResolvedValue({
      results: [{
        entityType: "task",
        uuid,
        title: "Exact task",
        snippet: "",
        status: "open",
        projectUuid: "project-1",
        projectName: "Project A",
        updatedAt: "2026-07-30T00:00:00.000Z",
        description: "must not escape",
      }],
      counts: {
        tasks: 1,
        ideas: 0,
        proposals: 0,
        documents: 0,
        projects: 0,
        projectGroups: 0,
      },
    });

    const response = await handlers.chorus_search({
      query: uuid,
      scope: "project",
      scopeUuid: "project-1",
      entityTypes: ["task"],
    });
    const payload = JSON.parse(response.content[0].text);

    expect(services.search.search).toHaveBeenCalledWith({
      companyUuid: "company-1",
      query: uuid,
      scope: "project",
      scopeUuid: "project-1",
      entityTypes: ["task"],
      limit: 50,
    });
    expect(payload.results).toEqual([{
      entityType: "task",
      uuid,
      title: "Exact task",
      snippet: "",
      status: "open",
      projectUuid: "project-1",
      projectName: "Project A",
      updatedAt: "2026-07-30T00:00:00.000Z",
    }]);
    expect(payload).toMatchObject({
      returned: 1,
      page: 1,
      pageSize: 50,
      total: 1,
    });
  });

  it("paginates compact sessions without changing the service call", async () => {
    services.session.listAgentSessions.mockResolvedValue(
      Array.from({ length: 25 }, (_, index) => ({
        uuid: `session-${index}`,
        name: `Session ${index}`,
        description: "detail".repeat(1_000),
        status: "active",
        agentUuid: "agent-1",
      })),
    );

    const response = await handlers.chorus_list_sessions({
      status: "active",
      page: 2,
      pageSize: 20,
    });
    const payload = JSON.parse(response.content[0].text);

    expect(services.session.listAgentSessions).toHaveBeenCalledWith(
      "company-1",
      "agent-1",
      "active",
    );
    expect(payload).toMatchObject({
      returned: 5,
      page: 2,
      pageSize: 20,
      total: 25,
    });
    expect(payload.sessions[0]).not.toHaveProperty("description");
  });
});
