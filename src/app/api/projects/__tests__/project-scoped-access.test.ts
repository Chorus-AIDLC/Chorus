// Access matrix for every /api/projects/[uuid]/** route (Tech Design D2/D4).
// Uses the REAL project-access.service against an in-memory prisma fixture so
// the decisions exercise the real level resolution; downstream content services
// are stubbed. Member/visibility services are stubbed to call the real access
// checks (their transactional internals are covered by project-member.service tests).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ===== In-memory fixture =====
const db = vi.hoisted(() => ({
  projects: [] as { uuid: string; companyUuid: string; name: string; description: string | null; visibility: string; groupUuid: string | null; createdAt: Date; updatedAt: Date; id: number }[],
  members: [] as { projectUuid: string; userUuid: string; role: string }[],
  proposals: [] as { uuid: string; companyUuid: string; projectUuid: string; inputType?: string; inputUuids?: string[] }[],
  ideas: [] as { uuid: string; companyUuid: string; projectUuid: string }[],
}));

const mockGetAuthContext = vi.hoisted(() => vi.fn());

vi.mock("@/lib/prisma", () => ({
  prisma: {
    project: {
      findFirst: vi.fn(async ({ where }: { where: { uuid: string; companyUuid: string } }) => {
        const p = db.projects.find((x) => x.uuid === where.uuid && x.companyUuid === where.companyUuid);
        return p ? { ...p } : null;
      }),
    },
    projectMember: {
      findUnique: vi.fn(async ({ where }: { where: { projectUuid_userUuid: { projectUuid: string; userUuid: string } } }) => {
        const k = where.projectUuid_userUuid;
        const m = db.members.find((x) => x.projectUuid === k.projectUuid && x.userUuid === k.userUuid);
        return m ? { role: m.role } : null;
      }),
    },
    proposal: {
      findFirst: vi.fn(async ({ where }: { where: { uuid: string; companyUuid: string } }) => {
        const p = db.proposals.find((x) => x.uuid === where.uuid && x.companyUuid === where.companyUuid);
        return p ? { projectUuid: p.projectUuid, inputType: p.inputType ?? "idea", inputUuids: p.inputUuids ?? [] } : null;
      }),
    },
    idea: {
      findFirst: vi.fn(async ({ where }: { where: { uuid: string; companyUuid: string } }) => {
        const i = db.ideas.find((x) => x.uuid === where.uuid && x.companyUuid === where.companyUuid);
        return i ? { projectUuid: i.projectUuid } : null;
      }),
    },
    activity: {
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
    },
  },
}));

vi.mock("@/lib/auth", () => ({
  getAuthContext: (...args: unknown[]) => mockGetAuthContext(...args),
  isUser: (auth: { type: string }) => auth.type === "user",
  isAgent: (auth: { type: string }) => auth.type === "agent",
  hasPermission: (auth: { permissions?: string[] }, perm: string) => auth.permissions?.includes(perm) ?? false,
  checkAgentPermission: () => null,
}));

const now = new Date("2026-10-01T00:00:00Z");

vi.mock("@/services/project.service", () => ({
  getProject: vi.fn(async (_c: string, uuid: string) => ({
    uuid, name: "P", description: null, groupUuid: null, createdAt: now, updatedAt: now,
    _count: { ideas: 0, documents: 0, tasks: 0, proposals: 0, activities: 0 },
  })),
  updateProject: vi.fn(async (_c: string, uuid: string, data: { name?: string }) => ({
    uuid, name: data.name ?? "P", description: null, createdAt: now, updatedAt: now,
  })),
  deleteProject: vi.fn(async () => true),
  getProjectStats: vi.fn(async () => ({})),
}));

vi.mock("@/services/project-member.service", async () => {
  const access = await import("@/services/project-access.service");
  type Auth = Parameters<typeof access.requireProjectAccess>[0];
  return {
    listMembers: vi.fn(async (auth: Auth, p: string) => {
      await access.requireProjectAccess(auth, p, "viewer");
      return [];
    }),
    addMember: vi.fn(async (auth: Auth, p: string, userUuid: string, role: string) => {
      await access.requireProjectOperation(auth, p, "manage_members");
      return { uuid: "m-new", userUuid, role };
    }),
    updateMemberRole: vi.fn(async (auth: Auth, p: string, userUuid: string, role: string) => {
      await access.requireProjectOperation(auth, p, "manage_members");
      return { uuid: "m-1", userUuid, role };
    }),
    removeMember: vi.fn(async (auth: Auth, p: string, userUuid: string) => {
      await access.requireProjectOperation(auth, p, "manage_members");
      return { uuid: "m-1", userUuid };
    }),
    setVisibility: vi.fn(async (auth: Auth, p: string, visibility: string) => {
      await access.requireProjectOperation(auth, p, "change_visibility");
      return { uuid: p, visibility };
    }),
  };
});

vi.mock("@/services/document.service", () => ({
  listDocuments: vi.fn(async () => ({ documents: [], total: 0 })),
  createDocument: vi.fn(async () => ({ uuid: "d-1" })),
}));
vi.mock("@/services/idea.service", () => ({
  listIdeas: vi.fn(async () => ({ ideas: [], total: 0 })),
  createIdea: vi.fn(async () => ({ uuid: "i-1" })),
  getTrackerGroups: vi.fn(async () => ({})),
}));
vi.mock("@/services/proposal.service", () => ({
  listProposals: vi.fn(async () => ({ proposals: [], total: 0 })),
  createProposal: vi.fn(async () => ({ uuid: "pr-1" })),
  getProjectProposals: vi.fn(async () => []),
  validateProposal: vi.fn(async () => ({ valid: true, issues: [] })),
}));
vi.mock("@/services/task.service", () => ({
  listTasks: vi.fn(async () => ({ tasks: [], total: 0 })),
  createTask: vi.fn(async () => ({ uuid: "t-1" })),
  getProjectTaskDependencies: vi.fn(async () => ({ nodes: [], edges: [] })),
}));
vi.mock("@/services/assignment.service", () => ({
  getAvailableItems: vi.fn(async () => ({ ideas: [], tasks: [] })),
}));
vi.mock("@/services/activity.service", () => ({
  listActivitiesWithActorNames: vi.fn(async () => ({ activities: [] })),
}));
vi.mock("@/services/resource-graph.service", () => ({
  getProjectResourceGraph: vi.fn(async () => ({ nodes: [], edges: [] })),
}));
vi.mock("@/services/project-group.service", () => ({
  moveProjectToGroup: vi.fn(async (_c: string, uuid: string) => ({ uuid, name: "P", groupUuid: null })),
}));
vi.mock("@/services/project-agent-cwd.service", () => ({
  CwdServiceError: class CwdServiceError extends Error {},
  listProjectAgentCwdPreferences: vi.fn(async () => []),
  saveProjectAgentCwdPreference: vi.fn(async () => ({ agentUuid: "a-1" })),
  clearProjectAgentCwdPreference: vi.fn(async () => undefined),
}));

import * as projectRoute from "@/app/api/projects/[uuid]/route";
import * as activityRoute from "@/app/api/projects/[uuid]/activity/route";
import * as agentCwdsRoute from "@/app/api/projects/[uuid]/agent-cwds/route";
import * as availableRoute from "@/app/api/projects/[uuid]/available/route";
import * as documentsRoute from "@/app/api/projects/[uuid]/documents/route";
import * as groupRoute from "@/app/api/projects/[uuid]/group/route";
import * as ideasRoute from "@/app/api/projects/[uuid]/ideas/route";
import * as ideaTrackerRoute from "@/app/api/projects/[uuid]/ideas/tracker/route";
import * as proposalsRoute from "@/app/api/projects/[uuid]/proposals/route";
import * as proposalSummaryRoute from "@/app/api/projects/[uuid]/proposals/summary/route";
import * as validateRoute from "@/app/api/projects/[uuid]/proposals/[proposalUuid]/validate/route";
import * as resourceGraphRoute from "@/app/api/projects/[uuid]/resource-graph/route";
import * as statsRoute from "@/app/api/projects/[uuid]/stats/route";
import * as tasksRoute from "@/app/api/projects/[uuid]/tasks/route";
import * as depsRoute from "@/app/api/projects/[uuid]/tasks/dependencies/route";
import * as membersRoute from "@/app/api/projects/[uuid]/members/route";
import * as memberRoute from "@/app/api/projects/[uuid]/members/[userUuid]/route";

const COMPANY = "company-1";
const PRIV = "p-private";
const PUB = "p-public";

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
const h = (fn: unknown) => fn as Handler;
interface Case {
  name: string;
  handler: Handler;
  method: string;
  path: string;
  params?: Record<string, string>;
  body?: (project: string) => unknown;
}

const reads: Case[] = [
  { name: "GET project", handler: h(projectRoute.GET), method: "GET", path: "" },
  { name: "GET activity", handler: h(activityRoute.GET), method: "GET", path: "/activity" },
  { name: "GET agent-cwds", handler: h(agentCwdsRoute.GET), method: "GET", path: "/agent-cwds" },
  { name: "GET available", handler: h(availableRoute.GET), method: "GET", path: "/available" },
  { name: "GET documents", handler: h(documentsRoute.GET), method: "GET", path: "/documents" },
  { name: "GET ideas", handler: h(ideasRoute.GET), method: "GET", path: "/ideas" },
  { name: "GET ideas/tracker", handler: h(ideaTrackerRoute.GET), method: "GET", path: "/ideas/tracker" },
  { name: "GET proposals", handler: h(proposalsRoute.GET), method: "GET", path: "/proposals" },
  { name: "GET proposals/summary", handler: h(proposalSummaryRoute.GET), method: "GET", path: "/proposals/summary" },
  {
    name: "GET proposals/[id]/validate", handler: h(validateRoute.GET), method: "GET",
    path: "/proposals/x/validate", params: { proposalUuid: "__proposal__" },
  },
  { name: "GET resource-graph", handler: h(resourceGraphRoute.GET), method: "GET", path: "/resource-graph" },
  { name: "GET stats", handler: h(statsRoute.GET), method: "GET", path: "/stats" },
  { name: "GET tasks", handler: h(tasksRoute.GET), method: "GET", path: "/tasks" },
  { name: "GET tasks/dependencies", handler: h(depsRoute.GET), method: "GET", path: "/tasks/dependencies" },
  { name: "GET members", handler: h(membersRoute.GET), method: "GET", path: "/members" },
];

const contentWrites: Case[] = [
  { name: "POST documents", handler: h(documentsRoute.POST), method: "POST", path: "/documents", body: () => ({ type: "prd", title: "D" }) },
  { name: "POST ideas", handler: h(ideasRoute.POST), method: "POST", path: "/ideas", body: () => ({ title: "I" }) },
  {
    name: "POST proposals", handler: h(proposalsRoute.POST), method: "POST", path: "/proposals",
    body: () => ({ title: "P", inputType: "idea", inputUuids: ["i-1"] }),
  },
  { name: "POST tasks", handler: h(tasksRoute.POST), method: "POST", path: "/tasks", body: () => ({ title: "T" }) },
  {
    name: "PUT agent-cwds", handler: h(agentCwdsRoute.PUT), method: "PUT", path: "/agent-cwds",
    body: () => ({ agentUuid: "a-1", validationRequestUuid: "v-1" }),
  },
  { name: "DELETE agent-cwds", handler: h(agentCwdsRoute.DELETE), method: "DELETE", path: "/agent-cwds", body: () => ({ agentUuid: "a-1" }) },
];

const manageProject: Case[] = [
  { name: "PATCH project settings", handler: h(projectRoute.PATCH), method: "PATCH", path: "", body: () => ({ name: "Renamed" }) },
  { name: "DELETE project", handler: h(projectRoute.DELETE), method: "DELETE", path: "" },
  { name: "PATCH group", handler: h(groupRoute.PATCH), method: "PATCH", path: "/group", body: () => ({ groupUuid: null }) },
];

const adminOnly: Case[] = [
  {
    name: "PATCH visibility", handler: h(projectRoute.PATCH), method: "PATCH", path: "",
    body: (p) => ({ visibility: p === PRIV ? "public" : "private" }),
  },
  { name: "POST members", handler: h(membersRoute.POST), method: "POST", path: "/members", body: () => ({ userUuid: "u-new", role: "viewer" }) },
  {
    name: "PATCH member role", handler: h(memberRoute.PATCH), method: "PATCH", path: "/members/u-viewer",
    params: { userUuid: "u-viewer" }, body: () => ({ role: "editor" }),
  },
  {
    name: "DELETE member", handler: h(memberRoute.DELETE), method: "DELETE", path: "/members/u-viewer",
    params: { userUuid: "u-viewer" },
  },
];

let currentUser = "u-out";

async function call(c: Case, project: string): Promise<Response> {
  const body = c.body?.(project);
  const req = new NextRequest(new URL(`/api/projects/${project}${c.path}`, "http://localhost:3000"), {
    method: c.method,
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
  });
  const params: Record<string, string> = { uuid: project, ...(c.params ?? {}) };
  if (params.proposalUuid === "__proposal__") params.proposalUuid = `prop-${project}`;
  return c.handler(req, { params: Promise.resolve(params) });
}

function seed() {
  const base = { companyUuid: COMPANY, description: null, groupUuid: null, createdAt: now, updatedAt: now };
  db.projects = [
    { ...base, id: 1, uuid: PRIV, name: "Private", visibility: "private" },
    { ...base, id: 2, uuid: PUB, name: "Public", visibility: "public" },
  ];
  db.members = [
    { projectUuid: PRIV, userUuid: "u-admin", role: "admin" },
    { projectUuid: PRIV, userUuid: "u-editor", role: "editor" },
    { projectUuid: PRIV, userUuid: "u-viewer", role: "viewer" },
    { projectUuid: PUB, userUuid: "u-admin", role: "admin" },
  ];
  db.proposals = [
    { uuid: `prop-${PRIV}`, companyUuid: COMPANY, projectUuid: PRIV },
    { uuid: `prop-${PUB}`, companyUuid: COMPANY, projectUuid: PUB },
  ];
  db.ideas = [
    { uuid: "i-1", companyUuid: COMPANY, projectUuid: PUB }, // visible to every company member
    { uuid: "i-secret", companyUuid: COMPANY, projectUuid: PRIV },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  seed();
  currentUser = "u-out";
  // Fresh auth object per request, like production (access cache is per auth object).
  mockGetAuthContext.mockImplementation(async () => ({ type: "user", companyUuid: COMPANY, actorUuid: currentUser }));
});

const allCases = [...reads, ...contentWrites, ...manageProject, ...adminOnly];
const writes = [...contentWrites, ...manageProject, ...adminOnly];

describe("private project", () => {
  describe("non-member gets 404 on every route", () => {
    it.each(allCases.map((c) => [c.name, c] as const))("%s", async (_n, c) => {
      currentUser = "u-out";
      const res = await call(c, PRIV);
      expect(res.status).toBe(404);
    });
  });

  describe("viewer", () => {
    it.each(reads.map((c) => [c.name, c] as const))("200 on %s", async (_n, c) => {
      currentUser = "u-viewer";
      expect((await call(c, PRIV)).status).toBe(200);
    });
    it.each(writes.map((c) => [c.name, c] as const))("403 on %s", async (_n, c) => {
      currentUser = "u-viewer";
      expect((await call(c, PRIV)).status).toBe(403);
    });
  });

  describe("editor", () => {
    it.each(contentWrites.map((c) => [c.name, c] as const))("200 on %s", async (_n, c) => {
      currentUser = "u-editor";
      expect((await call(c, PRIV)).status).toBe(200);
    });
    it.each([...manageProject, ...adminOnly].map((c) => [c.name, c] as const))("403 on %s", async (_n, c) => {
      currentUser = "u-editor";
      expect((await call(c, PRIV)).status).toBe(403);
    });
  });

  describe("admin", () => {
    it.each(allCases.map((c) => [c.name, c] as const))("200 on %s", async (_n, c) => {
      currentUser = "u-admin";
      expect((await call(c, PRIV)).status).toBe(200);
    });
  });
});

describe("public project", () => {
  describe("any company member (non-member)", () => {
    it.each([...reads, ...contentWrites, ...manageProject].map((c) => [c.name, c] as const))(
      "200 on %s",
      async (_n, c) => {
        currentUser = "u-out";
        expect((await call(c, PUB)).status).toBe(200);
      },
    );
    it.each(adminOnly.map((c) => [c.name, c] as const))("403 on %s", async (_n, c) => {
      currentUser = "u-out";
      expect((await call(c, PUB)).status).toBe(403);
    });
  });

  describe("explicit admin", () => {
    it.each(adminOnly.map((c) => [c.name, c] as const))("200 on %s", async (_n, c) => {
      currentUser = "u-admin";
      expect((await call(c, PUB)).status).toBe(200);
    });
  });
});

describe("response shapes", () => {
  it("GET project exposes visibility + caller accessLevel and no serial id", async () => {
    currentUser = "u-viewer";
    const res = await call(reads[0], PRIV);
    const body = await res.json();
    expect(body.data).toMatchObject({ uuid: PRIV, visibility: "private", accessLevel: "viewer" });
    expect(body.data).not.toHaveProperty("id");

    currentUser = "u-out";
    const pub = await (await call(reads[0], PUB)).json();
    expect(pub.data).toMatchObject({ visibility: "public", accessLevel: "editor" });
  });

  it("PATCH visibility returns the new visibility", async () => {
    currentUser = "u-admin";
    const body = await (await call(adminOnly[0], PUB)).json();
    expect(body.data).toMatchObject({ uuid: PUB, visibility: "private" });
    expect(body.data).not.toHaveProperty("id");
  });

  it("PATCH with unchanged visibility only needs manage_project", async () => {
    currentUser = "u-out";
    const c: Case = { ...adminOnly[0], body: () => ({ name: "X", visibility: "public" }) };
    const res = await call(c, PUB);
    expect(res.status).toBe(200);
  });

  it("PATCH settings + visibility is rejected up front (no partial update) for non-admins", async () => {
    const { updateProject } = await import("@/services/project.service");
    currentUser = "u-out";
    const c: Case = { ...adminOnly[0], body: () => ({ name: "X", visibility: "private" }) };
    expect((await call(c, PUB)).status).toBe(403);
    expect(updateProject).not.toHaveBeenCalled();
  });

  it("PATCH rejects an invalid visibility value", async () => {
    currentUser = "u-admin";
    const c: Case = { ...adminOnly[0], body: () => ({ visibility: "secret" }) };
    expect((await call(c, PUB)).status).toBe(422);
  });

  it("members POST validates role", async () => {
    currentUser = "u-admin";
    const c: Case = { ...adminOnly[1], body: () => ({ userUuid: "u-new", role: "owner" }) };
    expect((await call(c, PRIV)).status).toBe(422);
    const missing: Case = { ...adminOnly[1], body: () => ({ role: "viewer" }) };
    expect((await call(missing, PRIV)).status).toBe(422);
  });

  it("members PATCH validates role", async () => {
    currentUser = "u-admin";
    const c: Case = { ...adminOnly[2], body: () => ({ role: "superuser" }) };
    expect((await call(c, PRIV)).status).toBe(422);
  });

  it("members POST returns the member DTO", async () => {
    currentUser = "u-admin";
    const body = await (await call(adminOnly[1], PRIV)).json();
    expect(body.data).toEqual({ uuid: "m-new", userUuid: "u-new", role: "viewer" });
  });

  it("validate 404s when the proposal belongs to another project", async () => {
    currentUser = "u-admin";
    const c: Case = { ...reads[9], params: { proposalUuid: `prop-${PUB}` } };
    const res = await call(c, PRIV);
    expect(res.status).toBe(404);
    const { validateProposal } = await import("@/services/proposal.service");
    expect(validateProposal).not.toHaveBeenCalled();
  });

  it("validate 404s for a non-member even when the proposal is in the path project", async () => {
    currentUser = "u-out";
    expect((await call(reads[9], PRIV)).status).toBe(404);
  });
});

describe("client-supplied references to hidden private entities", () => {
  it("POST proposals 404s when an input idea is in a private project the caller cannot see", async () => {
    currentUser = "u-out";
    const c: Case = { ...contentWrites[2], body: () => ({ title: "P", inputType: "idea", inputUuids: ["i-1", "i-secret"] }) };
    expect(c.name).toBe("POST proposals");
    const res = await call(c, PUB);
    expect(res.status).toBe(404);
    expect((await res.json()).error.message).toBe("Idea not found");
    const { createProposal } = await import("@/services/proposal.service");
    expect(createProposal).not.toHaveBeenCalled();
  });

  it("POST proposals accepts inputs the caller can see", async () => {
    currentUser = "u-editor";
    const c: Case = { ...contentWrites[2], body: () => ({ title: "P", inputType: "idea", inputUuids: ["i-secret"] }) };
    expect((await call(c, PRIV)).status).toBe(200);
  });

  it("POST ideas with a hidden private parent looks exactly like a missing parent", async () => {
    currentUser = "u-out";
    const hidden = await call({ ...contentWrites[1], body: () => ({ title: "I", parentUuid: "i-secret" }) }, PUB);
    const missing = await call({ ...contentWrites[1], body: () => ({ title: "I", parentUuid: "i-nope" }) }, PUB);
    expect(hidden.status).toBe(400);
    expect((await hidden.json()).error.message).toBe("Parent idea not found");
    expect(missing.status).toBe(400);
    expect((await missing.json()).error.message).toBe("Parent idea not found");
    const { createIdea } = await import("@/services/idea.service");
    expect(createIdea).not.toHaveBeenCalled();
  });
});

describe("stored proposal inputs that became hidden", () => {
  it("validate 404s (and never runs validateProposal) when a stored input idea is now hidden", async () => {
    // Created legitimately in a public project while the input was visible; the
    // caller has since lost access to the input's private project.
    db.proposals.push({ uuid: "prop-stale", companyUuid: COMPANY, projectUuid: PUB, inputType: "idea", inputUuids: ["i-secret"] });
    currentUser = "u-out";
    const c: Case = { ...reads[9], params: { proposalUuid: "prop-stale" } };
    const res = await call(c, PUB);
    expect(res.status).toBe(404);
    expect((await res.json()).error.message).toBe("Idea not found");
    const { validateProposal } = await import("@/services/proposal.service");
    expect(validateProposal).not.toHaveBeenCalled();
  });

  it("validate still works for a caller who can see every stored input", async () => {
    db.proposals.push({ uuid: "prop-stale", companyUuid: COMPANY, projectUuid: PUB, inputType: "idea", inputUuids: ["i-1", "i-secret"] });
    currentUser = "u-viewer";
    const c: Case = { ...reads[9], params: { proposalUuid: "prop-stale" } };
    expect((await call(c, PUB)).status).toBe(200);
  });
});
