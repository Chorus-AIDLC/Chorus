import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AgentAuthContext } from "@/types/auth";

type Row = Record<string, unknown>;
type Query = {
  where?: Row;
  select?: Record<string, boolean>;
  orderBy?: Record<string, "asc" | "desc">;
  take?: number;
  skip?: number;
};

// Only persistence and peripheral infrastructure are substituted. In particular,
// the MCP gate, owner inheritance and batched recipient filter all run for real.
const fixture = vi.hoisted(() => {
  const rows: Record<string, Row[]> = {};
  const matches = (row: Row, where: Row = {}): boolean =>
    Object.entries(where).every(([field, value]) => {
      if (field === "OR") return (value as Row[]).some((item) => matches(row, item));
      if (field === "AND") {
        return (Array.isArray(value) ? value : [value]).every((item) => matches(row, item));
      }
      if (field === "projectUuid_userUuid") return matches(row, value as Row);
      if (value === undefined) return true;
      if (value === null || typeof value !== "object") return row[field] === value;
      return Object.entries(value).every(([operator, operand]) => {
        if (operator === "mode") return true;
        if (operator === "in") return (operand as unknown[]).includes(row[field]);
        if (operator === "not") return row[field] !== operand;
        if (operator === "contains") {
          if (typeof row[field] !== "string") return false;
          const insensitive = (value as Row).mode === "insensitive";
          const actual = row[field] as string;
          return insensitive
            ? actual.toLowerCase().includes(String(operand).toLowerCase())
            : actual.includes(String(operand));
        }
        throw new Error(`Unsupported fixture predicate: ${field}.${operator}`);
      });
    });
  const select = (row: Row, fields?: Query["select"]): Row =>
    fields
      ? Object.fromEntries(Object.entries(fields).filter(([, include]) => include)
          .map(([field]) => [field, row[field]]))
      : { ...row };
  const find = (name: string, query: Query = {}): Row[] => {
    let found = (rows[name] ?? []).filter((row) => matches(row, query.where));
    if (query.orderBy) {
      const [field, direction] = Object.entries(query.orderBy)[0];
      found = [...found].sort((a, b) => {
        const left = a[field] instanceof Date ? (a[field] as Date).getTime() : String(a[field]);
        const right = b[field] instanceof Date ? (b[field] as Date).getTime() : String(b[field]);
        return (left < right ? -1 : left > right ? 1 : 0) * (direction === "asc" ? 1 : -1);
      });
    }
    return found.slice(query.skip ?? 0, query.take === undefined ? undefined : (query.skip ?? 0) + query.take);
  };
  const model = (name: string) => ({
    findFirst: vi.fn(async (query: Query = {}) => {
      const row = find(name, query)[0];
      return row ? select(row, query.select) : null;
    }),
    findUnique: vi.fn(async (query: Query = {}) => {
      const row = find(name, query)[0];
      return row ? select(row, query.select) : null;
    }),
    findMany: vi.fn(async (query: Query = {}) =>
      find(name, query).map((row) => select(row, query.select))),
    count: vi.fn(async (query: Query = {}) => find(name, query).length),
  });
  const prisma = {
    project: model("project"),
    projectMember: model("projectMember"),
    projectGroupMember: model("projectGroupMember"),
    idea: model("idea"),
    task: model("task"),
    proposal: model("proposal"),
    document: model("document"),
    user: {
      ...model("user"),
      // These explicit-membership cases do not define a first company user.
      findFirst: vi.fn(async (query: Query = {}) => {
        const row = query.where?.uuid ? find("user", query)[0] : undefined;
        return row ? select(row, query.select) : null;
      }),
    },
    agent: model("agent"),
    daemonConnection: model("daemonConnection"),
    daemonExecution: {
      groupBy: vi.fn(async ({ where }: Query) => {
        const counts = new Map<unknown, number>();
        for (const row of find("daemonExecution", { where })) {
          counts.set(row.agentUuid, (counts.get(row.agentUuid) ?? 0) + 1);
        }
        return [...counts].map(([agentUuid, count]) => ({ agentUuid, _count: { _all: count } }));
      }),
    },
    projectAgentCwdPreference: model("projectAgentCwdPreference"),
  };
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
  logger.child.mockReturnValue(logger);
  return {
    rows,
    prisma,
    logger,
    eventBus: { emitPresence: vi.fn(), emitChange: vi.fn(), emitNotification: vi.fn() },
    resolveRootIdea: vi.fn(async () => ({ rootIdeaUuid: null, directIdeaUuid: null })),
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: fixture.prisma }));
vi.mock("@/lib/logger", () => ({
  default: fixture.logger,
  createRequestLogger: () => fixture.logger,
}));
vi.mock("@/lib/event-bus", () => ({
  eventBus: fixture.eventBus,
  controlEventName: (uuid: string) => `control:${uuid}`,
}));
vi.mock("@/services/lineage.service", () => ({ resolveRootIdea: fixture.resolveRootIdea }));
vi.mock("@/services/daemon-connection.service", () => ({
  STALE_THRESHOLD_MS: 90_000,
  listConnectionsForAgent: vi.fn(async () => []),
}));
vi.mock("@/services/daemon-execution.service", () => ({
  ACTIVE_EXECUTION_STATUSES: ["running", "queued"],
}));
vi.mock("@/services/project-agent-cwd.service", () => ({
  resolveProjectAgentCwdTarget: vi.fn(async () => null),
}));

import * as mentionService from "@/services/mention.service";
import { enablePresence } from "@/mcp/tools/presence";
import { registerPublicTools } from "@/mcp/tools/public";

const serviceSpy = vi.spyOn(mentionService, "searchMentionables"); // call-through
const TOOL = "chorus_search_mentionables";
const COMPANY = "company";
const PRIVATE = "private-project";
const PUBLIC = "public-project";
const VIEWER = "viewer-owner";
const EDITOR = "editor-member";
const OUTSIDER = "outsider";
const OWN_AGENTS = ["viewer-agent", "viewer-peer"];
const ENTITY_TYPES = ["idea", "task", "proposal", "document"] as const;
type EntityType = typeof ENTITY_TYPES[number];
type Handler = (params: Record<string, unknown>, extra?: unknown) => Promise<CallToolResult>;
type Config = { inputSchema: z.ZodType<Record<string, unknown>> };

function auth(ownerUuid?: string): AgentAuthContext {
  return {
    type: "agent",
    companyUuid: COMPANY,
    actorUuid: "calling-agent",
    agentName: "Calling Agent",
    ownerUuid,
    permissions: ["project:read", "idea:read", "task:read", "proposal:read", "document:read"],
    roles: [],
  };
}

function register(actor: AgentAuthContext) {
  let config!: Config;
  let handler!: Handler;
  let original!: ReturnType<typeof vi.fn<Handler>>;
  const server = {
    registerTool(name: string, toolConfig: Config, callback: Handler) {
      if (name === TOOL) {
        config = toolConfig;
        handler = callback;
      }
    },
  };
  enablePresence(server as unknown as McpServer, actor);
  const gatedRegister = server.registerTool;
  server.registerTool = (name, toolConfig, callback) => {
    if (name === TOOL) {
      original = vi.fn(callback);
      return gatedRegister(name, toolConfig, original);
    }
    return gatedRegister(name, toolConfig, callback);
  };
  registerPublicTools(server as unknown as McpServer, actor);
  return {
    schema: config.inputSchema,
    original,
    call: (params: Record<string, unknown>) => handler(config.inputSchema.parse(params)),
  };
}

function context(entityType: EntityType, project = PRIVATE) {
  return { entityType, entityUuid: `${entityType}-${project}` };
}

function readResults(result: CallToolResult): mentionService.Mentionable[] {
  expect(result.isError).not.toBe(true);
  const content = result.content[0];
  expect(content.type).toBe("text");
  if (content.type !== "text") throw new Error("Expected JSON text");
  const payload = JSON.parse(content.text);
  expect(payload.total).toBe(payload.results.length);
  return payload.results;
}

function ids(results: mentionService.Mentionable[]): string[] {
  return results.map((result) => result.uuid).sort();
}

function expectNoSearch() {
  expect(serviceSpy).not.toHaveBeenCalled();
  expect(fixture.prisma.user.findMany).not.toHaveBeenCalled();
  expect(fixture.prisma.agent.findMany).not.toHaveBeenCalled();
  expect(fixture.prisma.daemonConnection.findMany).not.toHaveBeenCalled();
  expect(fixture.prisma.daemonExecution.groupBy).not.toHaveBeenCalled();
  expect(fixture.prisma.projectAgentCwdPreference.findMany).not.toHaveBeenCalled();
  expect(fixture.resolveRootIdea).not.toHaveBeenCalled();
  expect(fixture.eventBus.emitPresence).not.toHaveBeenCalled();
}

function expectNoContextLookups() {
  for (const entityType of ENTITY_TYPES) {
    expect(fixture.prisma[entityType].findFirst).not.toHaveBeenCalled();
  }
  expect(fixture.prisma.project.findFirst).not.toHaveBeenCalled();
  expect(fixture.prisma.projectMember.findUnique).not.toHaveBeenCalled();
  expect(fixture.prisma.projectMember.findMany).not.toHaveBeenCalled();
  expect(fixture.resolveRootIdea).not.toHaveBeenCalled();
  expect(fixture.prisma.projectAgentCwdPreference.findMany).not.toHaveBeenCalled();
  expect(fixture.eventBus.emitPresence).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const name of Object.keys(fixture.rows)) delete fixture.rows[name];
  fixture.rows.project = [
    { uuid: PRIVATE, companyUuid: COMPANY, visibility: "private", name: "Confidential" },
    { uuid: PUBLIC, companyUuid: COMPANY, visibility: "public", name: "Public" },
    { uuid: "foreign-project", companyUuid: "other-company", visibility: "public" },
  ];
  fixture.rows.projectMember = [
    { companyUuid: COMPANY, projectUuid: PRIVATE, userUuid: VIEWER, role: "viewer" },
    { companyUuid: COMPANY, projectUuid: PRIVATE, userUuid: EDITOR, role: "editor" },
    // A membership elsewhere must not admit this user to PRIVATE.
    { companyUuid: COMPANY, projectUuid: PUBLIC, userUuid: OUTSIDER, role: "admin" },
  ];
  for (const entityType of ENTITY_TYPES) {
    fixture.rows[entityType] = [
      ...[PRIVATE, PUBLIC].map((projectUuid) => ({
        uuid: `${entityType}-${projectUuid}`, companyUuid: COMPANY, projectUuid,
      })),
      { uuid: `${entityType}-foreign`, companyUuid: "other-company", projectUuid: "foreign-project" },
      { uuid: `${entityType}-foreign-project`, companyUuid: COMPANY, projectUuid: "foreign-project" },
    ];
  }
  fixture.rows.user = [
    { uuid: VIEWER, companyUuid: COMPANY, name: "Visible Viewer", email: "viewer@example.test" },
    // OR/email matching is necessary to retain this member.
    { uuid: EDITOR, companyUuid: COMPANY, name: "Editor", email: "visible.editor@example.test" },
    { uuid: OUTSIDER, companyUuid: COMPANY, name: "Visible Outsider", email: "outsider@example.test" },
    { uuid: "quiet-user", companyUuid: COMPANY, name: "Unrelated", email: "quiet@example.test" },
    { uuid: "foreign-user", companyUuid: "other-company", name: "Visible Foreign", email: "foreign@example.test" },
  ];
  fixture.rows.agent = [
    ...OWN_AGENTS.map((uuid) => ({ uuid, ownerUuid: VIEWER, name: `Visible ${uuid}` })),
    { uuid: "editor-agent", ownerUuid: EDITOR, name: "Visible Editor Agent" },
    { uuid: "outsider-agent", ownerUuid: OUTSIDER, name: "Visible Outsider Agent" },
    { uuid: "orphan-agent", ownerUuid: null, name: "Visible Orphan" },
    { uuid: "quiet-agent", ownerUuid: VIEWER, name: "Unrelated" },
  ].map((row, index) => ({
    ...row, companyUuid: COMPANY, roles: [],
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, index)),
  }));
  fixture.rows.agent.push({
    uuid: "foreign-agent", companyUuid: "other-company", ownerUuid: VIEWER,
    name: "Visible Foreign Agent", roles: [], createdAt: new Date(),
  });
});

describe("chorus_search_mentionables registered schema", () => {
  it.each(ENTITY_TYPES)("accepts and preserves optional %s context", (entityType) => {
    const tool = register(auth(VIEWER));
    expect(tool.schema.parse({ query: "visible", ...context(entityType) })).toEqual({
      query: "visible", limit: 10, ...context(entityType),
    });
  });

  it.each([
    {},
    { entityType: "idea" },
    { entityUuid: "idea-private-project" },
  ])("accepts legacy or incomplete context %j", (params) => {
    expect(register(auth()).schema.parse({ query: "", ...params })).toEqual({
      query: "", limit: 10, ...params,
    });
  });

  it.each(["project", "comment", "user", "agent", "Idea", "unknown"])(
    "rejects unsupported entityType %s", (entityType) => {
      expect(register(auth()).schema.safeParse({
        query: "visible", entityType, entityUuid: "entity",
      }).success).toBe(false);
      expectNoSearch();
    },
  );

  it.each([
    { entityType: null }, { entityType: 1 },
    { entityUuid: null }, { entityUuid: 1 }, { entityUuid: "" },
  ])(
    "rejects invalid optional context %j", (params) => {
      expect(register(auth()).schema.safeParse({ query: "visible", ...params }).success).toBe(false);
      expectNoSearch();
    },
  );
});

describe("chorus_search_mentionables central project gate", () => {
  const denied = ENTITY_TYPES.flatMap((entityType) => [
    { entityType, kind: "nonmember", owner: OUTSIDER, entityUuid: `${entityType}-${PRIVATE}` },
    { entityType, kind: "ownerless", owner: undefined, entityUuid: `${entityType}-${PRIVATE}` },
    { entityType, kind: "missing", owner: VIEWER, entityUuid: `${entityType}-missing` },
    { entityType, kind: "foreign entity", owner: VIEWER, entityUuid: `${entityType}-foreign` },
    { entityType, kind: "foreign project", owner: VIEWER, entityUuid: `${entityType}-foreign-project` },
  ]);

  it.each(denied)("hides $entityType $kind before handler, candidates and presence", async ({
    entityType, owner, entityUuid,
  }) => {
    const tool = register(auth(owner));
    expect(await tool.call({ query: "visible", entityType, entityUuid })).toEqual({
      content: [{ type: "text", text: `${entityType[0].toUpperCase()}${entityType.slice(1)} not found` }],
      isError: true,
    });
    expect(tool.original).not.toHaveBeenCalled();
    expectNoSearch();
    expect(fixture.prisma[entityType].findFirst).toHaveBeenCalledWith({
      where: { companyUuid: COMPANY, uuid: entityUuid },
      select: { projectUuid: true },
    });
  });

  it.each(ENTITY_TYPES)("permits Viewer reads and forwards %s context to the real service", async (entityType) => {
    const tool = register(auth(VIEWER));
    const results = readResults(await tool.call({ query: "VISIBLE", limit: 20, ...context(entityType) }));
    expect(ids(results)).toEqual([...OWN_AGENTS, VIEWER, EDITOR].sort());
    expect(serviceSpy).toHaveBeenCalledExactlyOnceWith({
      companyUuid: COMPANY, actorType: "agent", actorUuid: "calling-agent",
      ownerUuid: VIEWER, query: "VISIBLE", limit: 20, ...context(entityType),
    });
    expect(tool.original).toHaveBeenCalledOnce();
    expect(fixture.prisma.projectMember.findUnique).toHaveBeenCalledWith({
      where: { companyUuid: COMPANY, projectUuid_userUuid: { projectUuid: PRIVATE, userUuid: VIEWER } },
      select: { role: true },
    });
    expect(fixture.prisma.projectMember.findMany).toHaveBeenCalledWith({
      where: { projectUuid: PRIVATE, companyUuid: COMPANY },
      select: { userUuid: true },
    });
    expect(fixture.prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        companyUuid: COMPANY, uuid: { in: [VIEWER, EDITOR] },
      }),
      take: 20,
    }));
    expect(fixture.prisma.agent.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ companyUuid: COMPANY, ownerUuid: VIEWER }),
      take: 20,
    }));
    expect(fixture.prisma.projectMember.findMany).toHaveBeenCalledWith({
      where: { companyUuid: COMPANY, projectUuid: PRIVATE, userUuid: { in: [VIEWER, EDITOR] } },
      select: { userUuid: true },
    });
    expect(fixture.resolveRootIdea).toHaveBeenCalledWith(COMPANY, entityType, context(entityType).entityUuid);
    expect(fixture.eventBus.emitPresence).toHaveBeenCalledExactlyOnceWith({
      companyUuid: COMPANY, projectUuid: PRIVATE,
      entityType, entityUuid: context(entityType).entityUuid,
      agentUuid: "calling-agent", agentName: "Calling Agent", action: "view",
      timestamp: expect.any(Number),
    });
    expect(fixture.prisma.projectMember.findUnique.mock.invocationCallOrder[0])
      .toBeLessThan(fixture.eventBus.emitPresence.mock.invocationCallOrder[0]);
    expect(fixture.eventBus.emitPresence.mock.invocationCallOrder[0])
      .toBeLessThan(tool.original.mock.invocationCallOrder[0]);
    for (const candidate of results.filter((result) => result.type === "agent")) {
      expect(candidate).toMatchObject({ online: false, activeCount: 0 });
    }
  });

  it("allows empty-query Viewer search through the real filtered service", async () => {
    const results = readResults(await register(auth(VIEWER)).call({ query: "", ...context("task") }));
    expect(ids(results)).toEqual([...OWN_AGENTS, "quiet-agent"].sort());
    expect(results.every((result) => result.type === "agent")).toBe(true);
    expect(fixture.prisma.user.findMany).not.toHaveBeenCalled();
    expect(fixture.prisma.projectMember.findMany).toHaveBeenCalledWith({
      where: { projectUuid: PRIVATE, companyUuid: COMPANY },
      select: { userUuid: true },
    });
    expect(fixture.prisma.projectMember.findMany).toHaveBeenCalledWith({
      where: { companyUuid: COMPANY, projectUuid: PRIVATE, userUuid: { in: [VIEWER] } },
      select: { userUuid: true },
    });
    expect(fixture.eventBus.emitPresence).toHaveBeenCalledOnce();
  });

  it("returns private members even when matching outsiders precede the query limit", async () => {
    fixture.rows.user = [
      ...Array.from({ length: 12 }, (_, index) => ({
        uuid: `crowding-user-${index}`, companyUuid: COMPANY,
        name: "Member Match Outsider", email: `crowding-${index}@example.test`,
      })),
      ...fixture.rows.user.filter((row) => [VIEWER, EDITOR].includes(row.uuid as string))
        .map((row) => ({ ...row, name: `Member Match ${row.uuid}` })),
    ];
    const results = readResults(await register(auth(VIEWER)).call({
      query: "member match", limit: 2, ...context("task"),
    }));
    expect(ids(results)).toEqual([VIEWER, EDITOR].sort());
    expect(results.every((result) => result.type === "user")).toBe(true);
    expect(fixture.prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        companyUuid: COMPANY, uuid: { in: [VIEWER, EDITOR] },
      }),
      take: 2,
    }));
  });

  it("denies a revoked owner using a fresh auth context before any new search or presence", async () => {
    const firstAuth = auth(VIEWER);
    readResults(await register(firstAuth).call({ query: "visible", ...context("proposal") }));
    fixture.rows.projectMember = fixture.rows.projectMember.filter((row) => row.userUuid !== VIEWER);
    vi.clearAllMocks();
    const nextAuth = auth(VIEWER);
    expect(nextAuth).not.toBe(firstAuth);
    const tool = register(nextAuth);
    expect(await tool.call({ query: "visible", ...context("proposal") })).toEqual({
      content: [{ type: "text", text: "Proposal not found" }], isError: true,
    });
    expect(fixture.prisma.projectMember.findUnique).toHaveBeenCalledOnce();
    expect(tool.original).not.toHaveBeenCalled();
    expectNoSearch();
  });
});

describe("real mention service recipient membership filtering", () => {
  it.each(ENTITY_TYPES)("filters a broad %s candidate pool by user membership and agent owner", async (entityType) => {
    const results = await mentionService.searchMentionables({
      companyUuid: COMPANY, actorType: "agent", actorUuid: "calling-agent",
      query: "visible", limit: 20, ...context(entityType),
    });
    expect(ids(results)).toEqual([...OWN_AGENTS, "editor-agent", VIEWER, EDITOR].sort());
    expect(fixture.prisma.agent.findMany).toHaveBeenCalledWith({
      where: {
        companyUuid: COMPANY, name: { contains: "visible", mode: "insensitive" },
        ownerUuid: { in: [VIEWER, EDITOR] },
      },
      select: { uuid: true, name: true, roles: true },
      take: 20,
    });
    expect(fixture.prisma.agent.findMany).toHaveBeenCalledWith({
      where: { companyUuid: COMPANY, uuid: { in: [...OWN_AGENTS, "editor-agent"] } },
      select: { uuid: true, ownerUuid: true },
    });
    expect(fixture.prisma.daemonConnection.findMany).toHaveBeenCalledWith({
      where: { companyUuid: COMPANY, agentUuid: { in: [...OWN_AGENTS, "editor-agent"] } },
      select: { agentUuid: true, status: true, lastSeenAt: true },
    });
  });

  it("filters a nonmember owner's empty-query agent pool to nothing", async () => {
    expect(await mentionService.searchMentionables({
      companyUuid: COMPANY, actorType: "agent", actorUuid: "calling-agent",
      ownerUuid: OUTSIDER, query: "", ...context("task"),
    })).toEqual([]);
    expect(fixture.prisma.agent.findMany).not.toHaveBeenCalled();
    expect(fixture.prisma.projectMember.findMany).toHaveBeenCalledWith({
      where: { projectUuid: PRIVATE, companyUuid: COMPANY },
      select: { userUuid: true },
    });
    expect(fixture.prisma.daemonConnection.findMany).not.toHaveBeenCalled();
  });

  it("returns member-owned agents even when outsider agents precede the query limit", async () => {
    fixture.rows.user = [];
    fixture.rows.agent.unshift(...Array.from({ length: 12 }, (_, index) => ({
      uuid: `crowding-agent-${index}`, companyUuid: COMPANY, ownerUuid: OUTSIDER,
      name: "Visible Outsider Agent", roles: [], createdAt: new Date(),
    })));
    const results = await mentionService.searchMentionables({
      companyUuid: COMPANY, actorType: "agent", actorUuid: "calling-agent",
      query: "visible", limit: 2, ...context("task"),
    });
    expect(ids(results)).toEqual([...OWN_AGENTS].sort());
    expect(results.every((result) => result.type === "agent")).toBe(true);
    expect(fixture.prisma.agent.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ ownerUuid: { in: [VIEWER, EDITOR] } }),
      take: 2,
    }));
  });

  it("intersects a fixed nonmember owner with the private membership scope", async () => {
    const results = await mentionService.searchMentionables({
      companyUuid: COMPANY, actorType: "agent", actorUuid: "calling-agent",
      ownerUuid: OUTSIDER, query: "visible", limit: 20, ...context("task"),
    });
    expect(ids(results)).toEqual([VIEWER, EDITOR].sort());
    expect(results.every((result) => result.type === "user")).toBe(true);
    expect(fixture.prisma.agent.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ companyUuid: COMPANY, ownerUuid: { in: [] } }),
      take: 20,
    }));
    expect(fixture.prisma.daemonConnection.findMany).not.toHaveBeenCalled();
  });

  it("removes a candidate revoked after the membership-scoped query was prepared", async () => {
    const readMembers = fixture.prisma.projectMember.findMany.getMockImplementation()!;
    fixture.prisma.projectMember.findMany.mockImplementationOnce(async (query: Query = {}) => {
      const members = await readMembers(query);
      fixture.rows.projectMember = fixture.rows.projectMember
        .filter((row) => row.userUuid !== EDITOR);
      return members;
    });
    const results = readResults(await register(auth(VIEWER)).call({
      query: "visible", limit: 20, ...context("task"),
    }));
    expect(ids(results)).toEqual([...OWN_AGENTS, VIEWER].sort());
    expect(fixture.prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ uuid: { in: [VIEWER, EDITOR] } }),
    }));
    expect(fixture.prisma.projectMember.findMany).toHaveBeenCalledWith({
      where: { companyUuid: COMPANY, projectUuid: PRIVATE, userUuid: { in: [VIEWER, EDITOR] } },
      select: { userUuid: true },
    });
  });
});

describe("chorus_search_mentionables public and legacy scope", () => {
  it.each([VIEWER, OUTSIDER, undefined])("keeps public company users and owner scope for owner %s", async (owner) => {
    const results = readResults(await register(auth(owner)).call({
      query: "visible", limit: 20, ...context("document", PUBLIC),
    }));
    const agents = owner === VIEWER ? OWN_AGENTS : owner === OUTSIDER
      ? ["outsider-agent"] : [...OWN_AGENTS, "editor-agent", "outsider-agent", "orphan-agent"];
    expect(ids(results)).toEqual([...agents, VIEWER, EDITOR, OUTSIDER].sort());
    expect(fixture.prisma.projectMember.findMany).not.toHaveBeenCalled();
    expect(fixture.eventBus.emitPresence).toHaveBeenCalledWith(expect.objectContaining({
      projectUuid: PUBLIC, entityType: "document", action: "view",
    }));
  });

  it.each([VIEWER, OUTSIDER, undefined])("keeps no-context company search and owner scope for owner %s", async (owner) => {
    const results = readResults(await register(auth(owner)).call({ query: "visible", limit: 20 }));
    const agents = owner === VIEWER ? OWN_AGENTS : owner === OUTSIDER
      ? ["outsider-agent"] : [...OWN_AGENTS, "editor-agent", "outsider-agent", "orphan-agent"];
    expect(ids(results)).toEqual([...agents, VIEWER, EDITOR, OUTSIDER].sort());
    expect(fixture.prisma.agent.findMany).toHaveBeenCalledExactlyOnceWith({
      where: {
        companyUuid: COMPANY, name: { contains: "visible", mode: "insensitive" },
        ...(owner ? { ownerUuid: owner } : {}),
      },
      select: { uuid: true, name: true, roles: true },
      take: 20,
    });
    expectNoContextLookups();
  });

  it.each([VIEWER, undefined])("preserves legacy empty-query behavior for owner %s", async (owner) => {
    const results = readResults(await register(auth(owner)).call({ query: "" }));
    expect(ids(results)).toEqual(owner ? [...OWN_AGENTS, "quiet-agent"].sort() : []);
    expect(fixture.prisma.user.findMany).not.toHaveBeenCalled();
    expectNoContextLookups();
  });

  it.each([
    { entityType: "idea" },
    { entityUuid: "task-private-project" },
  ])("matches real service fallback for incomplete context %j", async (partial) => {
    // This caller could not read PRIVATE if the context were complete.
    const actor = auth(OUTSIDER);
    const tool = register(actor);
    const result = readResults(await tool.call({ query: "visible", limit: 20, ...partial }));
    expect(ids(result)).toEqual([VIEWER, EDITOR, OUTSIDER, "outsider-agent"].sort());
    expect(serviceSpy).toHaveBeenCalledExactlyOnceWith({
      companyUuid: COMPANY, actorType: "agent", actorUuid: actor.actorUuid,
      ownerUuid: OUTSIDER, query: "visible", limit: 20, ...partial,
      ...(partial.entityType === undefined ? { entityType: undefined } : {}),
      ...(partial.entityUuid === undefined ? { entityUuid: undefined } : {}),
    });
    const direct = await mentionService.searchMentionables({
      companyUuid: COMPANY, actorType: "agent", actorUuid: actor.actorUuid,
      ownerUuid: OUTSIDER, query: "visible", limit: 20,
      ...partial as Partial<mentionService.SearchMentionablesParams>,
    });
    expect(ids(result)).toEqual(ids(direct));
    expectNoContextLookups();
  });
});

describe("chorus_search_mentionables SDK registration", () => {
  it("rejects invalid context before authorization and preserves valid context over the SDK transport", async () => {
    const server = new McpServer({ name: "mentionable-access-test", version: "1" });
    const actor = auth(VIEWER);
    enablePresence(server, actor);
    registerPublicTools(server, actor);
    const client = new Client({ name: "mentionable-test-client", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const invalid = await client.callTool({
        name: TOOL, arguments: { query: "visible", entityType: "comment", entityUuid: "comment" },
      });
      expect(invalid.isError).toBe(true);
      expectNoSearch();
      expectNoContextLookups();
      const valid = await client.callTool({
        name: TOOL, arguments: { query: "visible", ...context("task") },
      }) as CallToolResult;
      expect(ids(readResults(valid))).toEqual([...OWN_AGENTS, VIEWER, EDITOR].sort());
      expect(serviceSpy).toHaveBeenCalledExactlyOnceWith({
        companyUuid: COMPANY, actorType: "agent", actorUuid: "calling-agent",
        ownerUuid: VIEWER, query: "visible", limit: 10, ...context("task"),
      });
      expect(fixture.eventBus.emitPresence).toHaveBeenCalledOnce();
    } finally {
      await client.close();
      await server.close();
    }
  });
});
