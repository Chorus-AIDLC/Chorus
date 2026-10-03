import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Notification, Prisma } from "@/generated/prisma/client";
import type { AgentAuthContext, AuthContext } from "@/types/auth";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { fixture, group, groupMember, localMember, project, auth } from "./project-group.fixture";

// Use the existing stateful project/group persistence fixture, keeping the real
// project-access resolver and notification service. Apply the notification SQL
// predicate before pagination/count/update, rather than returning canned rows.
vi.mock("@/lib/prisma", async () => ({
  prisma: (await import("./project-group.fixture")).fixture.prisma,
}));
const events = vi.hoisted(() => ({ emit: vi.fn() }));
vi.mock("@/lib/event-bus", () => ({ eventBus: events }));
vi.mock("@/services/notification-turn", () => ({ createTurnAndResolveTarget: vi.fn() }));
const enrichment = vi.hoisted(() => ({
  resolveResourceOrchestrator: vi.fn(async () => null),
  resolveWakerSessionAnchor: vi.fn(async () => null),
}));
vi.mock("@/services/orchestrator.service", () => enrichment);
vi.mock("@/services/daemon-session.service", () => ({ resolveDirectIdeaUuid: vi.fn(async () => null) }));
vi.mock("@/services/idea-tracker.service", () => ({ buildActiveProjectDistribution: vi.fn(async () => ({})) }));
const requestAuth = vi.hoisted(() => ({ current: null as AuthContext | null }));
vi.mock("@/lib/auth", () => ({
  getAuthContext: async () => requestAuth.current,
  isUser: (context: AuthContext) => context.type === "user",
}));

import * as notifications from "@/services/notification.service";
import { GET as listRoute } from "@/app/api/notifications/route";
import { GET as countRoute } from "@/app/api/notifications/unread-count/route";
import { PATCH as readRoute } from "@/app/api/notifications/[uuid]/read/route";
import { PATCH as archiveRoute } from "@/app/api/notifications/[uuid]/archive/route";
import { POST as readAllRoute } from "@/app/api/notifications/read-all/route";
import { buildCheckinResponse } from "@/services/checkin.service";
import { registerPublicTools } from "@/mcp/tools/public";

const rows: Notification[] = [];
const agents: { uuid: string; companyUuid: string; ownerUuid: string | null; roles: string[]; permissions: string[] }[] = [];

function matches(row: Notification, where: Prisma.NotificationWhereInput = {}): boolean {
  return Object.entries(where).every(([field, expected]) => {
    if (expected === undefined) return true;
    if (field === "OR") return (expected as Prisma.NotificationWhereInput[]).some((part) => matches(row, part));
    if (field === "AND") return (Array.isArray(expected) ? expected : [expected as Prisma.NotificationWhereInput]).every((part) => matches(row, part));
    if (field === "NOT") return !(Array.isArray(expected) ? expected : [expected as Prisma.NotificationWhereInput]).some((part) => matches(row, part));
    const actual = row[field as keyof Notification];
    if (expected !== null && typeof expected === "object") {
      if ("in" in expected) return (expected.in as unknown[]).includes(actual);
      if ("not" in expected) return actual !== expected.not;
    }
    return actual === expected;
  });
}

const persistence = {
  findMany: vi.fn(async ({ where, skip = 0, take = rows.length, distinct, orderBy }: Prisma.NotificationFindManyArgs) => {
    let selected = rows.filter((row) => matches(row, where));
    if (Array.isArray(distinct) && distinct.includes("entityUuid")) {
      const seen = new Set<string>();
      selected = selected.filter((row) => {
        if (seen.has(row.entityUuid)) return false;
        seen.add(row.entityUuid);
        return true;
      });
    }
    if (orderBy) selected.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return selected.slice(skip, skip + take).map((row) => ({ ...row }));
  }),
  findFirst: vi.fn(async ({ where }: Prisma.NotificationFindFirstArgs) =>
    rows.find((row) => matches(row, where)) ?? null),
  count: vi.fn(async ({ where }: Prisma.NotificationCountArgs) => rows.filter((row) => matches(row, where)).length),
  updateMany: vi.fn(async ({ where, data }: Prisma.NotificationUpdateManyArgs) => {
    const selected = rows.filter((row) => matches(row, where));
    for (const row of selected) {
      if (data.readAt !== undefined) row.readAt = data.readAt as Date;
      if (data.archivedAt !== undefined) row.archivedAt = data.archivedAt as Date;
    }
    return { count: selected.length };
  }),
};
fixture.prisma.notification = persistence;
fixture.prisma.agent = {
  findFirst: vi.fn(async ({ where }: Prisma.AgentFindFirstArgs) =>
    agents.find((agent) => agent.companyUuid === where?.companyUuid && agent.uuid === where?.uuid) ?? null),
  update: vi.fn(async () => ({ ...agents[0], name: "Agent", persona: null, systemPrompt: null, owner: null })),
};

function add(uuid: string, projectUuid: string, overrides: Partial<Notification> = {}): Notification {
  const row: Notification = {
    id: rows.length + 1,
    uuid,
    companyUuid: "c",
    projectUuid,
    projectName: `${projectUuid} project title`,
    recipientType: "user",
    recipientUuid: "viewer",
    entityType: "task",
    entityUuid: `entity-${uuid}`,
    entityTitle: `${uuid} entity title`,
    action: "task_assigned",
    message: `${uuid} private message`,
    actorType: "user",
    actorUuid: "admin",
    actorName: "Admin",
    readAt: null,
    archivedAt: null,
    instructionText: null,
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, rows.length)),
    updatedAt: new Date(),
    ...overrides,
  };
  rows.push(row);
  return row;
}

function list(context: AuthContext, filters: Partial<notifications.NotificationListParams> = {}) {
  return notifications.list({
    companyUuid: context.companyUuid,
    recipientType: context.type,
    recipientUuid: context.actorUuid,
    auth: context,
    ...filters,
  });
}

function agentAuth(permissions: AgentAuthContext["permissions"] = ["task:read"], ownerUuid: string | null = "viewer"): AgentAuthContext {
  return { type: "agent", companyUuid: "c", actorUuid: "agent", ownerUuid: ownerUuid ?? undefined, roles: [], permissions, agentName: "Agent" };
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture.reset();
  rows.length = 0;
  agents.length = 0;
  requestAuth.current = auth("viewer");
  group("g", "public");
  project("private", "g");
  project("public", null, "public");
  groupMember("g", "viewer", "viewer");
});

describe("historical notification access", () => {
  it.each(["group", "project"] as const)("hides historical titles after revoking the last %s grant", async (grant) => {
    if (grant === "project") {
      fixture.state.projectGroupMember = [];
      localMember("private", "viewer", "viewer");
    }
    add("private-notification", "private");
    expect((await list(auth("viewer"))).notifications).toHaveLength(1);

    if (grant === "group") fixture.state.projectGroupMember = [];
    else fixture.state.projectMember = [];

    const result = await list(auth("viewer"));
    expect(result).toEqual({ notifications: [], total: 0, unreadCount: 0 });
    expect(await notifications.getUnreadCount("c", "user", "viewer", auth("viewer"))).toBe(0);
    // Reusing a request auth object also queries current grants; no stale ACL cache.
    const context = auth("viewer");
    groupMember("g", "viewer", "viewer");
    expect((await list(context)).total).toBe(1);
    fixture.state.projectGroupMember = [];
    expect((await list(context)).total).toBe(0);
  });

  it("keeps notifications when an independent direct grant survives group revocation", async () => {
    add("private-notification", "private");
    localMember("private", "viewer", "viewer");
    fixture.state.projectGroupMember = [];
    expect((await list(auth("viewer"))).notifications.map((row) => row.uuid)).toEqual(["private-notification"]);
    fixture.state.projectMember = [];
    expect((await list(auth("viewer"))).total).toBe(0);
  });

  it("fills pages and counts only accessible rows before applying offset, read and archive filters", async () => {
    add("public-oldest", "public");
    add("private-old", "private");
    add("public-middle", "public");
    add("private-middle", "private");
    add("public-newest", "public");
    add("public-read", "public", { readAt: new Date() });
    add("public-archived", "public", { archivedAt: new Date() });
    add("private-newest", "private");
    fixture.state.projectGroupMember = [];

    const first = await list(auth("viewer"), { readFilter: "unread", archived: false, take: 2 });
    expect(first.notifications.map((row) => row.uuid)).toEqual(["public-newest", "public-middle"]);
    expect(first.total).toBe(3);
    expect(first.unreadCount).toBe(3);
    const second = await list(auth("viewer"), { readFilter: "unread", archived: false, skip: 2, take: 2 });
    expect(second.notifications.map((row) => row.uuid)).toEqual(["public-oldest"]);
    expect(second.total).toBe(3);
    expect(second.unreadCount).toBe(3);
    const beyond = await list(auth("viewer"), { skip: 99, archived: false });
    expect(beyond.notifications).toEqual([]);
    expect(beyond.total).toBe(4);
    expect(beyond.unreadCount).toBe(3);
    expect((await list(auth("viewer"), { readFilter: "read", archived: false })).total).toBe(1);
    expect((await list(auth("viewer"), { archived: true })).total).toBe(1);
    // The unread badge remains global, even on a project-scoped empty page.
    expect(await list(auth("viewer"), { projectUuid: "private" })).toEqual({
      notifications: [], total: 0, unreadCount: 3,
    });
    expect(enrichment.resolveResourceOrchestrator).not.toHaveBeenCalledWith("c", "task", "entity-private-newest");
  });

  it("hides orphaned projects but preserves deleted-entity history and projectless instructions", async () => {
    add("deleted-entity", "public"); // No task row exists; the notification is historical.
    add("orphan-project", "deleted-project");
    add("system", "", { entityType: "daemon_session", instructionText: "Owner instruction" });
    fixture.state.projectGroupMember = [];
    const result = await list(auth("viewer"));
    expect(result.notifications.map((row) => row.uuid)).toEqual(["system", "deleted-entity"]);
    expect(result.unreadCount).toBe(2);
  });

  it("scopes notification rows, projects and grants to the caller's company and recipient", async () => {
    add("mine", "public");
    add("other-recipient", "public", { recipientUuid: "outside" });
    add("other-type", "public", { recipientType: "agent" });
    add("other-company", "public", { companyUuid: "foreign" });
    add("foreign-system", "", { companyUuid: "foreign" });
    fixture.state.project.push({ uuid: "foreign-project", companyUuid: "foreign", visibility: "public" });
    add("foreign-project-ref", "foreign-project");
    fixture.state.projectGroupMember = [];
    fixture.state.projectMember.push({ companyUuid: "foreign", userUuid: "viewer", projectUuid: "private", role: "admin" });
    fixture.state.projectGroupMember.push({ companyUuid: "foreign", userUuid: "viewer", groupUuid: "g", role: "admin" });
    add("foreign-grants", "private");
    const result = await list(auth("viewer"));
    expect(result.notifications.map((row) => row.uuid)).toEqual(["mine"]);
    expect(result.total).toBe(1);
    expect(result.unreadCount).toBe(1);
    await expect(list(auth("outside"), { recipientUuid: "viewer" })).rejects.toThrow("does not match authentication");
    await expect(list(auth("viewer"), { companyUuid: "foreign" })).rejects.toThrow("does not match authentication");
  });

  it("intersects the agent owner's grants with current entity read capabilities", async () => {
    const context = agentAuth();
    add("task", "private", { recipientType: "agent", recipientUuid: "agent" });
    add("idea", "private", { recipientType: "agent", recipientUuid: "agent", entityType: "idea" });
    add("instruction", "", { recipientType: "agent", recipientUuid: "agent", entityType: "daemon_session" });
    expect((await list(context)).notifications.map((row) => row.uuid)).toEqual(["instruction", "task"]);
    context.permissions = ["task:write"];
    expect((await list(context)).notifications.map((row) => row.uuid)).toEqual(["instruction"]);
    context.permissions = ["task:read"];
    fixture.state.projectGroupMember = [];
    expect((await list(context)).notifications.map((row) => row.uuid)).toEqual(["instruction"]);
  });

  it("allows ownerless agents to read capable public resources and owner-scoped instructions", async () => {
    add("private", "private", { recipientType: "agent", recipientUuid: "agent" });
    add("public", "public", { recipientType: "agent", recipientUuid: "agent" });
    add("instruction", "", { recipientType: "agent", recipientUuid: "agent", entityType: "daemon_session" });
    expect((await list(agentAuth(["task:read"], null))).notifications.map((row) => row.uuid)).toEqual(["instruction", "public"]);
    expect((await list(agentAuth([]))).notifications.map((row) => row.uuid)).toEqual(["instruction"]);
  });

  it("uses a comment target's capability and fails closed for unknown types or deleted comments", async () => {
    for (const uuid of ["task-comment", "idea-comment", "deleted-comment", "unknown"]) {
      add(uuid, "private", { recipientType: "agent", recipientUuid: "agent", entityType: uuid === "unknown" ? "unknown" : "comment", entityUuid: uuid });
    }
    fixture.state.comment.push(
      { uuid: "task-comment", companyUuid: "c", targetType: "task", targetUuid: "task" },
      { uuid: "idea-comment", companyUuid: "c", targetType: "idea", targetUuid: "idea" },
      { uuid: "deleted-comment", companyUuid: "foreign", targetType: "task", targetUuid: "task" },
    );
    expect((await list(agentAuth())).notifications.map((row) => row.uuid)).toEqual(["task-comment"]);
  });

  it("skips comment resolution on reads, counts and count emissions without recipient comment candidates", async () => {
    const recipient = { recipientType: "agent", recipientUuid: "agent" };
    add("visible-task", "public", recipient);
    add("other-recipient-comment", "public", { ...recipient, recipientUuid: "other", entityType: "comment", entityUuid: "unrelated-comment" });
    add("other-type-comment", "public", { entityType: "comment", entityUuid: "unrelated-comment" });
    add("foreign-comment", "public", { ...recipient, companyUuid: "foreign", entityType: "comment", entityUuid: "unrelated-comment" });
    add("hidden-comment", "private", { ...recipient, entityType: "comment", entityUuid: "unrelated-comment" });
    fixture.state.comment.push({ uuid: "unrelated-comment", companyUuid: "c", targetType: "task", targetUuid: "task" });
    fixture.state.projectGroupMember = [];

    const context = agentAuth();
    expect((await list(context)).total).toBe(1);
    expect(await notifications.getUnreadCount("c", "agent", "agent", context)).toBe(1);
    await notifications.markRead("visible-task", "c", "agent", "agent", context);
    expect(events.emit).toHaveBeenLastCalledWith("notification:agent:agent", { type: "count_update", unreadCount: 0 });
    expect(fixture.prisma.comment.findMany).not.toHaveBeenCalled();
    const candidateQueries = persistence.findMany.mock.calls.map(([args]) => args).filter((args) => args.select);
    expect(candidateQueries).toHaveLength(3);
    for (const candidate of candidateQueries) {
      expect(candidate).toEqual({
        where: { companyUuid: "c", recipientType: "agent", recipientUuid: "agent", projectUuid: { in: ["public"] }, entityType: "comment" },
        select: { entityUuid: true },
        distinct: ["entityUuid"],
      });
    }
  });

  it("resolves only candidate comment UUIDs before filtered pagination and counts", async () => {
    const recipient = { recipientType: "agent", recipientUuid: "agent", entityType: "comment" };
    add("oldest", "public", { ...recipient, entityUuid: "old-comment" });
    add("duplicate", "public", { ...recipient, entityUuid: "old-comment", readAt: new Date() });
    add("incapable", "public", { ...recipient, entityUuid: "idea-comment" });
    add("newest", "public", { ...recipient, entityUuid: "new-comment" });
    add("orphan", "public", { ...recipient, entityUuid: "deleted-comment" });
    add("hidden", "private", { ...recipient, entityUuid: "hidden-comment" });
    add("other-recipient", "public", { ...recipient, recipientUuid: "other", entityUuid: "other-comment" });
    fixture.state.comment.push(
      ...["old-comment", "new-comment", "hidden-comment", "other-comment", "unrelated-comment"].map((uuid) =>
        ({ uuid, companyUuid: "c", targetType: "task", targetUuid: "task" })),
      { uuid: "idea-comment", companyUuid: "c", targetType: "idea", targetUuid: "idea" },
      { uuid: "deleted-comment", companyUuid: "foreign", targetType: "task", targetUuid: "task" },
    );
    fixture.state.projectGroupMember = [];
    const context = agentAuth();
    const result = await list(context, { readFilter: "unread", archived: false, skip: 1, take: 1 });
    expect(result.notifications.map((row) => row.uuid)).toEqual(["oldest"]);
    expect(result.total).toBe(2);
    expect(result.unreadCount).toBe(2);
    expect(await notifications.getUnreadCount("c", "agent", "agent", context)).toBe(2);
    expect(fixture.prisma.comment.findMany).toHaveBeenCalledTimes(2);
    for (const [query] of fixture.prisma.comment.findMany.mock.calls) {
      expect(query).toEqual({
        where: {
          companyUuid: "c",
          uuid: { in: ["old-comment", "idea-comment", "new-comment", "deleted-comment"] },
          targetType: { in: ["task"] },
        },
        select: { uuid: true },
      });
    }
    await expect(notifications.markRead("orphan", "c", "agent", "agent", context)).rejects.toThrow("Notification not found");
    expect(rows.find((row) => row.uuid === "orphan")?.readAt).toBeNull();
  });

  it("skips comment candidate and target queries without readable resources or visible projects", async () => {
    add("private-comment", "private", { recipientType: "agent", recipientUuid: "agent", entityType: "comment" });
    expect((await list(agentAuth([]))).total).toBe(0);
    fixture.state.project.length = 0;
    expect(await notifications.getUnreadCount("c", "agent", "agent", agentAuth())).toBe(0);
    expect(persistence.findMany.mock.calls.filter(([args]) => args.select)).toHaveLength(0);
    expect(fixture.prisma.comment.findMany).not.toHaveBeenCalled();
  });

  it("internal callers resolve current persisted agent ownership and effective permissions", async () => {
    add("private", "private", { recipientType: "agent", recipientUuid: "agent" });
    agents.push({ uuid: "agent", companyUuid: "c", ownerUuid: "viewer", roles: [], permissions: ["task:read"] });
    const params = { companyUuid: "c", recipientType: "agent", recipientUuid: "agent" };
    expect((await notifications.list(params)).total).toBe(1);
    agents[0].ownerUuid = "outside";
    expect((await notifications.list(params)).total).toBe(0);
    agents[0].ownerUuid = "viewer";
    agents[0].permissions = [];
    agents[0].roles = ["developer_agent"];
    expect((await notifications.list(params)).total).toBe(1);
    agents[0].roles = [];
    expect((await notifications.list(params)).total).toBe(0);
    await expect(notifications.getUnreadCount("foreign", "agent", "agent")).rejects.toThrow("recipient not found");
  });
});

describe("notification mutations use the same current access predicate", () => {
  it.each(["markRead", "archive"] as const)("%s conceals revoked, foreign and other-recipient rows without changing them", async (operation) => {
    const hidden = add("hidden", "private");
    const other = add("other", "public", { recipientUuid: "outside" });
    const foreign = add("foreign", "public", { companyUuid: "foreign" });
    fixture.state.projectGroupMember = [];
    for (const row of [hidden, other, foreign]) {
      await expect(notifications[operation](row.uuid, "c", "user", "viewer", auth("viewer"))).rejects.toThrow("Notification not found");
      expect(row.readAt).toBeNull();
      expect(row.archivedAt).toBeNull();
    }
    expect(events.emit).not.toHaveBeenCalled();
    expect(enrichment.resolveResourceOrchestrator).not.toHaveBeenCalled();
  });

  it("keeps read/archive idempotent and emits only the filtered unread count", async () => {
    add("hidden", "private");
    add("remaining", "public");
    const row = add("visible", "public");
    fixture.state.projectGroupMember = [];
    const result = await notifications.markRead(row.uuid, "c", "user", "viewer", auth("viewer"));
    const readAt = result.readAt;
    expect((await notifications.markRead(row.uuid, "c", "user", "viewer", auth("viewer"))).readAt).toBe(readAt);
    expect(events.emit).toHaveBeenLastCalledWith("notification:user:viewer", { type: "count_update", unreadCount: 1 });
    const archived = await notifications.archive("remaining", "c", "user", "viewer", auth("viewer"));
    expect((await notifications.archive("remaining", "c", "user", "viewer", auth("viewer"))).archivedAt).toBe(archived.archivedAt);
    expect(events.emit).toHaveBeenLastCalledWith("notification:user:viewer", { type: "count_update", unreadCount: 0 });
  });

  it("marks all visible unread rows, including archived rows, while preserving hidden rows", async () => {
    const hidden = add("hidden", "private");
    add("public", "public");
    add("archived", "public", { archivedAt: new Date() });
    add("system", "");
    add("already-read", "public", { readAt: new Date() });
    fixture.state.projectGroupMember = [];
    expect(await notifications.markAllRead("c", "user", "viewer", "private", auth("viewer"))).toEqual({ count: 0 });
    expect(await notifications.markAllRead("c", "user", "viewer", undefined, auth("viewer"))).toEqual({ count: 3 });
    expect(hidden.readAt).toBeNull();
    expect(events.emit).toHaveBeenLastCalledWith("notification:user:viewer", { type: "count_update", unreadCount: 0 });
  });
});

describe("notification REST endpoints share service access filtering", () => {
  const context = { params: Promise.resolve({}) };
  const request = (path: string, method = "GET") => new NextRequest(`http://localhost${path}`, { method });

  it("lists a filled page and matching unread badge after access revocation", async () => {
    add("public-old", "public");
    add("private", "private");
    add("public-new", "public");
    add("private-new", "private");
    fixture.state.projectGroupMember = [];
    const response = await listRoute(request("/api/notifications?limit=1&offset=1&unreadOnly=true"), context);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data.notifications.map((row: { uuid: string }) => row.uuid)).toEqual(["public-old"]);
    expect(body.data.unreadCount).toBe(2);
    const count = await countRoute(request("/api/notifications/unread-count"), context);
    expect((await count.json()).data.count).toBe(2);
    expect(JSON.stringify(body)).not.toContain("private project title");
    expect(JSON.stringify(body)).not.toContain("private-new entity title");
  });

  it("passes the authenticated agent's effective read capabilities into the service", async () => {
    add("private", "private", { recipientType: "agent", recipientUuid: "agent" });
    requestAuth.current = agentAuth([]);
    const response = await listRoute(request("/api/notifications"), context);
    expect((await response.json()).data).toEqual({ notifications: [], unreadCount: 0 });
  });

  it.each([readRoute, archiveRoute])("returns 404 for a revoked notification mutation without leaking its title", async (route) => {
    const hidden = add("hidden", "private");
    fixture.state.projectGroupMember = [];
    const response = await route(request("/api/notifications/hidden/read", "PATCH"), { params: Promise.resolve({ uuid: hidden.uuid }) });
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(hidden.entityTitle);
    expect(hidden.readAt).toBeNull();
    expect(hidden.archivedAt).toBeNull();
  });

  it("read-all marks only visible notifications", async () => {
    const hidden = add("hidden", "private");
    add("visible", "public");
    fixture.state.projectGroupMember = [];
    const response = await readAllRoute(request("/api/notifications/read-all", "POST"), context);
    expect(response.status).toBe(200);
    expect((await response.json()).data.count).toBe(1);
    expect(hidden.readAt).toBeNull();
  });

  it("rejects unauthenticated reads", async () => {
    requestAuth.current = null;
    expect((await listRoute(request("/api/notifications"), context)).status).toBe(401);
    expect(persistence.findMany).not.toHaveBeenCalled();
  });
});

describe("MCP notifications and checkin share service access filtering", () => {
  type Handler = (params: Record<string, unknown>) => Promise<CallToolResult>;
  function register(context: AgentAuthContext) {
    const handlers: Record<string, Handler> = {};
    const server = {
      registerTool: (name: string, _config: unknown, handler: Handler) => { handlers[name] = handler; },
    } as unknown as McpServer;
    registerPublicTools(server, context);
    return handlers;
  }
  function payload(result: CallToolResult): {
    notifications: notifications.NotificationResponse[]; total: number; unreadCount: number;
  } {
    const content = result.content[0];
    if (content.type !== "text") throw new Error("Expected JSON text");
    return JSON.parse(content.text);
  }
  beforeEach(() => {
    agents.push({ uuid: "agent", companyUuid: "c", ownerUuid: "viewer", roles: [], permissions: ["task:read"] });
  });

  it("MCP lists filled filtered pages with accurate totals and marks only returned unread rows", async () => {
    const recipient = { recipientType: "agent", recipientUuid: "agent" };
    const oldest = add("public-old", "public", recipient);
    const hidden = add("private", "private", recipient);
    const visible = add("public-new", "public", recipient);
    add("private-new", "private", recipient);
    fixture.state.projectGroupMember = [];
    const handlers = register(agentAuth());
    const first = payload(await handlers.chorus_get_notifications({ status: "unread", limit: 1, offset: 0 }));
    expect(first.notifications.map((row) => row.uuid)).toEqual(["public-new"]);
    expect(first.total).toBe(2);
    expect(first.unreadCount).toBe(2); // Pre-mark count, preserving the MCP contract.
    expect(visible.readAt).not.toBeNull();
    expect(oldest.readAt).toBeNull();
    expect(hidden.readAt).toBeNull();
    const next = payload(await handlers.chorus_get_notifications({ status: "unread", limit: 1, offset: 0, autoMarkRead: false }));
    expect(next.notifications.map((row) => row.uuid)).toEqual(["public-old"]);
    expect(next.total).toBe(1);
    expect(next.unreadCount).toBe(1);
    expect(oldest.readAt).toBeNull();
    expect(JSON.stringify(first)).not.toContain("private project title");
  });

  it("MCP mark-all leaves inaccessible rows unread", async () => {
    const recipient = { recipientType: "agent", recipientUuid: "agent" };
    const hidden = add("private", "private", recipient);
    const visible = add("public", "public", recipient);
    fixture.state.projectGroupMember = [];
    const handlers = register(agentAuth());
    await handlers.chorus_mark_notification_read({ all: true });
    expect(visible.readAt).not.toBeNull();
    expect(hidden.readAt).toBeNull();
  });

  it("checkin returns only accessible recent titles and marks only that filtered batch", async () => {
    const recipient = { recipientType: "agent", recipientUuid: "agent" };
    const hidden = add("private", "private", recipient);
    const incapable = add("idea", "public", { ...recipient, entityType: "idea" });
    const visible = Array.from({ length: 6 }, (_, i) => add(`public-${i}`, "public", recipient));
    fixture.state.projectGroupMember = [];
    const result = await buildCheckinResponse(agentAuth());
    expect(result.notifications.recent.map((row) => row.uuid)).toEqual([
      "public-5", "public-4", "public-3", "public-2", "public-1",
    ]);
    expect(result.notifications.unread).toBe(1);
    expect(hidden.readAt).toBeNull();
    expect(incapable.readAt).toBeNull();
    expect(visible[0].readAt).toBeNull();
    expect(visible.slice(1).every((row) => row.readAt !== null)).toBe(true);
    expect(JSON.stringify(result.notifications)).not.toContain("private entity title");
    expect(JSON.stringify(result.notifications)).not.toContain("idea entity title");
  });
});
