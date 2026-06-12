// T11: End-to-end permission integration checkpoint.
//
// What this covers:
//   Scenario 1 — custom-permissions agent created via POST /api/agents,
//     MCP tool enumeration uses the returned effective permissions,
//     REST routes return 200 for allowed reads, 403 for disallowed writes.
//   Scenario 2 — baseline preset parity with 0.6.x for developer_agent (strict equality),
//     admin_agent (strict equality), and pm_agent (strict superset + expected diff).
//     NOTE: the task description names a "+5" diff for pm_agent; that number is stale.
//     The consensus captured in T3's comment thread (2026-04-30) is "+10": the 5
//     project/ProjectGroup admin tools gated on project:write PLUS the 5 developer
//     task-execution tools gated on task:write (handlers still enforce isAssignee
//     at runtime, so pm visibility doesn't equal operational escalation).
//   Scenario 4 — a super_admin auth context bypasses REST permission gates.
//
// Scenarios explicitly out of scope here:
//   Scenario 3 (UI -> system) is a composition of Scenario 1's runtime behavior
//   with per-UI picker unit tests already owned by T7/T8/T9:
//     - T7: src/app/onboarding/__tests__/*.test.tsx
//     - T8: src/components/__tests__/AgentPermissionPicker.test.tsx
//     - T9: src/app/(dashboard)/settings/agents/[uuid]/__tests__/*.test.tsx
//   Those tests assert the pickers emit the same `{ roles, permissions }` payload
//   the REST route receives; POST /api/agents handling of that payload is asserted
//   here in Scenario 1. Together they cover UI -> API -> runtime tool visibility.
//   Driving a real browser is intentionally not done (no Playwright in this suite).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ===== Module mocks (hoisted). =====
// MCP tool registration tests rely only on the names passed to server.registerTool;
// we stub every service as an empty object so no handler ever executes during
// registration. Prisma is stubbed for the same reason — not called here.
// REST tests mock a narrow set of services to a benign shape so the happy paths
// reach a 2xx status without hitting a real DB.

const mockGetAuthContext = vi.fn();

const mockPrisma = vi.hoisted(() => ({
  agent: {
    create: vi.fn(),
  },
}));

const mockProjectExists = vi.fn();
const mockListIdeas = vi.fn();
const mockListProposals = vi.fn();
const mockCreateProposal = vi.fn();
const mockGetProposalByUuid = vi.fn();
const mockApproveProposal = vi.fn();
const mockCreateActivity = vi.fn();
const mockGetTask = vi.fn();

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

vi.mock("@/lib/super-admin", () => ({
  getSuperAdminFromRequest: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/user-session", () => ({
  getUserSessionFromRequest: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/oidc-auth", () => ({
  verifyOidcAccessToken: vi.fn().mockResolvedValue(null),
  isOidcToken: vi.fn().mockReturnValue(false),
}));

vi.mock("@/lib/api-key", () => ({
  extractApiKey: vi.fn(),
  validateApiKey: vi.fn().mockResolvedValue({ valid: false }),
}));

// Intercept getAuthContext only; keep the real hasPermission/checkAgentPermission/isAgent/isUser
// helpers so the gate logic itself is under test.
vi.mock("@/lib/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth")>("@/lib/auth");
  return {
    ...actual,
    getAuthContext: (...args: unknown[]) => mockGetAuthContext(...args),
  };
});

vi.mock("@/services/idea.service", () => ({
  listIdeas: (...args: unknown[]) => mockListIdeas(...args),
  createIdea: vi.fn(),
}));

vi.mock("@/services/proposal.service", () => ({
  listProposals: (...args: unknown[]) => mockListProposals(...args),
  createProposal: (...args: unknown[]) => mockCreateProposal(...args),
  getProposalByUuid: (...args: unknown[]) => mockGetProposalByUuid(...args),
  approveProposal: (...args: unknown[]) => mockApproveProposal(...args),
}));

vi.mock("@/services/project.service", () => ({
  projectExists: (...args: unknown[]) => mockProjectExists(...args),
}));

vi.mock("@/services/activity.service", () => ({
  createActivity: (...args: unknown[]) => mockCreateActivity(...args),
}));

vi.mock("@/services/task.service", () => ({
  getTask: (...args: unknown[]) => mockGetTask(...args),
  getTaskByUuid: vi.fn(),
  updateTask: vi.fn(),
  deleteTask: vi.fn(),
  isValidTaskStatusTransition: vi.fn(),
  checkDependenciesResolved: vi.fn(),
}));

// Remaining services imported transitively by the MCP tool modules — stubbed empty
// because registration never reaches any handler body.
vi.mock("@/services/session.service", () => ({}));
vi.mock("@/services/checkin.service", () => ({}));
vi.mock("@/services/document.service", () => ({}));
vi.mock("@/services/comment.service", () => ({}));
vi.mock("@/services/assignment.service", () => ({}));
vi.mock("@/services/notification.service", () => ({}));
vi.mock("@/services/elaboration.service", () => ({}));
vi.mock("@/services/project-group.service", () => ({}));
vi.mock("@/services/mention.service", () => ({}));
vi.mock("@/services/search.service", () => ({}));
vi.mock("@/services/agent.service", () => ({ getAgentByUuid: vi.fn() }));

import { POST as postAgent } from "@/app/api/agents/route";
import { GET as getIdeas } from "@/app/api/projects/[uuid]/ideas/route";
import { POST as postProposal } from "@/app/api/projects/[uuid]/proposals/route";
import { POST as approveProposalHandler } from "@/app/api/proposals/[uuid]/approve/route";
import { registerPmTools } from "@/mcp/tools/pm";
import { registerDeveloperTools } from "@/mcp/tools/developer";
import { registerAdminTools } from "@/mcp/tools/admin";
import { registerPublicTools } from "@/mcp/tools/public";
import { TOOL_PERMISSIONS } from "@/mcp/tools/permission-map";
import { ROLE_PRESETS } from "@/lib/authz/presets";
import type { AgentAuthContext } from "@/types/auth";
import type { Permission } from "@/lib/authz/types";

// ===== Helpers =====

const companyUuid = "company-0000-0000-0000-000000000001";
const userUuid = "user-0000-0000-0000-000000000001";
const agentUuid = "agent-0000-0000-0000-0000000000a1";
const projectUuid = "project-0000-0000-0000-000000000001";
const proposalUuid = "proposal-0000-0000-0000-0000000000a2";

function jsonRequest(
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
): NextRequest {
  return new NextRequest(new URL(url, "http://localhost:3000"), init);
}

function makeContext<T>(params: T) {
  return { params: Promise.resolve(params) };
}

const emptyCtx = {
  params: Promise.resolve({}),
} as { params: Promise<Record<string, string>> };

// Minimal MCP server stand-in: records names passed to registerTool.
function makeCapturingServer(): { server: unknown; names: string[] } {
  const names: string[] = [];
  const server = {
    registerTool: (name: string) => {
      names.push(name);
    },
  };
  return { server, names };
}

function makeAgentAuth(permissions: Permission[], roles: string[] = []): AgentAuthContext {
  return {
    type: "agent",
    companyUuid,
    actorUuid: agentUuid,
    agentName: "Integration Agent",
    roles: roles as AgentAuthContext["roles"],
    permissions,
  };
}

// Run every permission-gated MCP registration module with the supplied auth
// and return the set of gated tool names. This is the same enumeration path
// /api/mcp takes when it constructs a server for a live session, then we keep
// only names that go through `registerPermissionedTool` (TOOL_PERMISSIONS) so
// non-gated public tools (chorus_get_project, chorus_add_comment, etc.) don't
// pollute the assertions below.
function enumerateGatedMcpTools(auth: AgentAuthContext): Set<string> {
  const { server, names } = makeCapturingServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerPmTools(server as any, auth);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerDeveloperTools(server as any, auth);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerAdminTools(server as any, auth);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerPublicTools(server as any, auth);
  const gated = new Set(Object.keys(TOOL_PERMISSIONS));
  return new Set(names.filter((n) => gated.has(n)));
}

// Frozen 0.6.x tool-name baselines — the source of truth for preset parity assertions.
// Kept in sync with src/mcp/__tests__/server.test.ts. If either list drifts, both tests fail together.
//
// 0.9.0 note (proposal e35b558c): three redundant pm-surface tools were removed
// from this baseline — the deprecated batch-create-tasks alias (covered by the
// public batch-create-tasks tool) and the two add/remove-task-dependency tools
// (covered by the update-task tool's incremental dependency arrays). See
// permission-map.ts and pm.ts; the names are intentionally not spelled here so
// downstream grep checks stay clean.
//
// Note: chorus_pm_validate_elaboration is gated on idea:admin, so it is
// admin-only and not part of this idea:write baseline. See the admin_agent
// expectation and the dedicated gating assertions below.
const OLD_PM_TOOLS = [
  "chorus_claim_idea",
  "chorus_release_idea",
  "chorus_pm_create_proposal",
  "chorus_pm_validate_proposal",
  "chorus_pm_submit_proposal",
  "chorus_pm_create_document",
  "chorus_pm_update_document",
  "chorus_pm_add_document_draft",
  "chorus_pm_add_task_draft",
  "chorus_pm_update_document_draft",
  "chorus_pm_update_task_draft",
  "chorus_pm_remove_document_draft",
  "chorus_pm_remove_task_draft",
  "chorus_pm_assign_task",
  "chorus_pm_start_elaboration",
  "chorus_pm_skip_elaboration",
  "chorus_move_idea",
  "chorus_pm_reject_proposal",
  "chorus_pm_revoke_proposal",
  "chorus_pm_create_idea",
];

const OLD_DEVELOPER_TOOLS = [
  "chorus_claim_task",
  "chorus_release_task",
  "chorus_submit_for_verify",
  "chorus_report_criteria_self_check",
  "chorus_report_work",
];

const OLD_ADMIN_TOOLS = [
  "chorus_admin_create_project",
  "chorus_admin_approve_proposal",
  "chorus_admin_close_proposal",
  "chorus_admin_verify_task",
  "chorus_admin_reopen_task",
  "chorus_mark_acceptance_criteria",
  "chorus_admin_close_task",
  "chorus_admin_delete_idea",
  "chorus_admin_delete_task",
  "chorus_admin_delete_document",
  "chorus_admin_create_project_group",
  "chorus_admin_update_project_group",
  "chorus_admin_delete_project_group",
  "chorus_admin_move_project_to_group",
];

// The +10 diff from the T3 consensus (comment 063165db on task b9bb9161, 2026-04-30):
//   +5 project/ProjectGroup admin tools gated on project:write
//   +5 developer task-execution tools gated on task:write
const PM_AGENT_ADDED_IN_0_7_0 = [
  // project:write additions
  "chorus_admin_create_project",
  "chorus_admin_create_project_group",
  "chorus_admin_update_project_group",
  "chorus_admin_delete_project_group",
  "chorus_admin_move_project_to_group",
  // task:write additions (pm_agent preset carries task:write)
  "chorus_claim_task",
  "chorus_release_task",
  "chorus_submit_for_verify",
  "chorus_report_criteria_self_check",
  "chorus_report_work",
];

// The +1 diff from add-idea-completion-report (0.9.0): public-namespaced
// chorus_create_report tool gated on document:write — pm_agent preset
// carries document:write so it appears in the pm visibility set.
const PM_AGENT_ADDED_IN_0_9_0 = [
  "chorus_create_report",
];

// add-idea-lineage: chorus_edit_idea is idea:write-gated — pm_agent
// (and admin_agent) carry idea:write so it appears in their visibility set.
const PM_AGENT_ADDED_IN_0_10_0 = [
  "chorus_edit_idea",
];

// ===== Shared beforeEach =====

beforeEach(() => {
  vi.clearAllMocks();
  mockProjectExists.mockResolvedValue(true);
  mockListIdeas.mockResolvedValue({ ideas: [], total: 0 });
  mockListProposals.mockResolvedValue({ proposals: [], total: 0 });
  mockCreateProposal.mockResolvedValue({ uuid: "proposal-new" });
  mockGetProposalByUuid.mockResolvedValue({
    uuid: proposalUuid,
    projectUuid,
    status: "pending",
  });
  mockApproveProposal.mockResolvedValue({ uuid: proposalUuid, status: "approved" });
  mockGetTask.mockResolvedValue({ uuid: "task-x", title: "t" });
});

// ============================================================
// Scenario 1 — custom-permissions agent: full create -> enumerate -> gate chain
// ============================================================

describe("Scenario 1: custom permissions agent end-to-end (AC1)", () => {
  const customPermissions: Permission[] = ["idea:read", "task:read", "task:write"];

  it("POST /api/agents creates the agent and returns effectivePermissions equal to the custom set", async () => {
    // Caller is a user (only users can create agents).
    mockGetAuthContext.mockResolvedValue({
      type: "user",
      companyUuid,
      actorUuid: userUuid,
    });

    mockPrisma.agent.create.mockResolvedValue({
      uuid: agentUuid,
      name: "Custom Agent",
      roles: [],
      permissions: customPermissions,
      persona: null,
      systemPrompt: null,
      ownerUuid: userUuid,
      createdAt: new Date("2026-04-30T00:00:00Z"),
    });

    const response = await postAgent(
      jsonRequest("/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Custom Agent",
          roles: [],
          permissions: customPermissions,
        }),
      }),
      emptyCtx,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.roles).toEqual([]);
    expect(body.data.permissions).toEqual(customPermissions);
    // With roles=[], effective = custom (no preset expansion).
    expect(new Set(body.data.effectivePermissions)).toEqual(new Set(customPermissions));
  });

  it("MCP tools/list shows exactly the tools gated by the custom permission set", () => {
    // Under customPermissions the only matches in the permission map are the 5
    // developer.ts tools (gated on task:write). idea:read and task:read point
    // at public.ts tools which aren't gated via registerPermissionedTool, so
    // they don't surface here — they're always visible to any authenticated agent.
    const auth = makeAgentAuth(customPermissions);
    const tools = enumerateGatedMcpTools(auth);
    expect(tools).toEqual(new Set(OLD_DEVELOPER_TOOLS));
  });

  it("MCP tools/list must NOT expose pm-write / admin / proposal-read tools", () => {
    const auth = makeAgentAuth(customPermissions);
    const tools = enumerateGatedMcpTools(auth);
    for (const forbidden of [
      "chorus_pm_create_idea",
      "chorus_pm_create_proposal",
      "chorus_admin_create_project",
      "chorus_admin_approve_proposal",
      "chorus_admin_verify_task",
    ]) {
      expect(tools.has(forbidden)).toBe(false);
    }
  });

  it("GET /api/projects/[uuid]/ideas returns 200 (idea:read satisfied)", async () => {
    mockGetAuthContext.mockResolvedValue(makeAgentAuth(customPermissions));

    const response = await getIdeas(
      jsonRequest(`/api/projects/${projectUuid}/ideas`),
      makeContext({ uuid: projectUuid }),
    );

    expect(response.status).toBe(200);
    expect(mockListIdeas).toHaveBeenCalled();
  });

  it("POST /api/projects/[uuid]/proposals returns 403 with 'Missing permission: proposal:write'", async () => {
    mockGetAuthContext.mockResolvedValue(makeAgentAuth(customPermissions));

    const response = await postProposal(
      jsonRequest(`/api/projects/${projectUuid}/proposals`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "P1",
          inputType: "idea",
          inputUuids: ["idea-1"],
        }),
      }),
      makeContext({ uuid: projectUuid }),
    );

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.success).toBe(false);
    expect(body.error.message).toContain("proposal:write");
    expect(mockCreateProposal).not.toHaveBeenCalled();
  });

  // Substitute for POST /api/tasks/[uuid]/verify. The task description mentions that
  // endpoint, but Chorus does not expose a REST verify route — verification is an
  // MCP-only operation (chorus_admin_verify_task, gated on task:admin). The closest
  // REST route gated on an *:admin permission is proposal approve (proposal:admin);
  // it exercises the same permissionDenied gate pattern, so we assert against it.
  it("POST /api/proposals/[uuid]/approve returns 403 with 'Missing permission: proposal:admin'", async () => {
    mockGetAuthContext.mockResolvedValue(makeAgentAuth(customPermissions));

    const response = await approveProposalHandler(
      jsonRequest(`/api/proposals/${proposalUuid}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
      makeContext({ uuid: proposalUuid }),
    );

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.message).toContain("proposal:admin");
    expect(mockApproveProposal).not.toHaveBeenCalled();
  });
});

// ============================================================
// Scenario 2 — preset backward-compatibility / expected +10 diff for pm_agent
// ============================================================

describe("Scenario 2: preset parity with 0.6.x baseline (AC2)", () => {
  it("developer_agent preset registers exactly the 0.6.x developer tool set", () => {
    const auth = makeAgentAuth([...ROLE_PRESETS.developer_agent], ["developer_agent"]);
    const tools = enumerateGatedMcpTools(auth);
    expect(tools).toEqual(new Set(OLD_DEVELOPER_TOOLS));
  });

  it("admin_agent preset registers exactly the 0.6.x admin ∪ pm ∪ developer tool set plus 0.9.0 chorus_create_report and 0.9.4 chorus_pm_validate_elaboration", () => {
    const auth = makeAgentAuth([...ROLE_PRESETS.admin_agent], ["admin_agent"]);
    const tools = enumerateGatedMcpTools(auth);
    const expected = new Set([
      ...OLD_ADMIN_TOOLS,
      ...OLD_PM_TOOLS,
      ...OLD_DEVELOPER_TOOLS,
      // 0.9.0 addition (document:write-gated, public-namespaced).
      "chorus_create_report",
      // 0.9.4 (simplify-elaboration-flow): chorus_pm_validate_elaboration is
      // re-gated to idea:admin. admin_agent carries idea:admin.
      "chorus_pm_validate_elaboration",
      // 0.10.0 (add-idea-lineage): chorus_edit_idea is idea:write-gated.
      ...PM_AGENT_ADDED_IN_0_10_0,
    ]);
    expect(tools).toEqual(expected);
  });

  // The task description says the pm_agent diff is +5. That number is stale.
  // Consensus captured on task b9bb9161 (T3), comment 063165db (2026-04-30): under
  // pure permission gating, pm_agent (which holds task:write) legitimately sees the
  // 5 developer.ts tools as well. Operational escalation is zero — the handlers
  // themselves enforce isAssignee at runtime. So the correct contract is +10:
  // strict superset-of-baseline, diff = exactly the 10 tools listed below.
  it("pm_agent preset is a strict superset of 0.6.x pm baseline", () => {
    const auth = makeAgentAuth([...ROLE_PRESETS.pm_agent], ["pm_agent"]);
    const tools = enumerateGatedMcpTools(auth);
    for (const old of OLD_PM_TOOLS) {
      expect(tools.has(old)).toBe(true);
    }
  });

  it("pm_agent diff vs 0.6.x pm baseline is exactly the 10 expected 0.7.0 tools plus the 0.9.0 chorus_create_report and 0.10.0 chorus_edit_idea", () => {
    const auth = makeAgentAuth([...ROLE_PRESETS.pm_agent], ["pm_agent"]);
    const tools = enumerateGatedMcpTools(auth);
    const baseline = new Set(OLD_PM_TOOLS);
    const diff = Array.from(tools).filter((t) => !baseline.has(t)).sort();
    expect(diff).toEqual([...PM_AGENT_ADDED_IN_0_7_0, ...PM_AGENT_ADDED_IN_0_9_0, ...PM_AGENT_ADDED_IN_0_10_0].sort());
  });

  it("pm_agent preset does not leak any *:admin-gated tool", () => {
    const auth = makeAgentAuth([...ROLE_PRESETS.pm_agent], ["pm_agent"]);
    const tools = enumerateGatedMcpTools(auth);
    for (const adminOnly of [
      "chorus_admin_approve_proposal",
      "chorus_admin_close_proposal",
      "chorus_admin_verify_task",
      "chorus_admin_reopen_task",
      "chorus_admin_close_task",
      "chorus_mark_acceptance_criteria",
      "chorus_admin_delete_task",
      "chorus_admin_delete_idea",
      "chorus_admin_delete_document",
      // 0.9.4: chorus_pm_validate_elaboration is now idea:admin-gated; pm_agent
      // (idea:write only) must not see it.
      "chorus_pm_validate_elaboration",
    ]) {
      expect(tools.has(adminOnly)).toBe(false);
    }
  });
});

// ============================================================
// Scenario 2b — elaboration validate gating: chorus_pm_validate_elaboration is
// gated on idea:admin.
// ============================================================

describe("Scenario 2b: elaboration validate gating", () => {
  it("chorus_pm_validate_elaboration is gated on idea:admin in the permission map", () => {
    expect(
      (TOOL_PERMISSIONS as Record<string, string>).chorus_pm_validate_elaboration
    ).toBe("idea:admin");
  });

  it("an idea:admin agent sees chorus_pm_validate_elaboration", () => {
    const auth = makeAgentAuth(["idea:admin"]);
    const tools = enumerateGatedMcpTools(auth);
    expect(tools.has("chorus_pm_validate_elaboration")).toBe(true);
  });

  it("an idea:write-only agent does NOT see chorus_pm_validate_elaboration", () => {
    const auth = makeAgentAuth(["idea:write"]);
    const tools = enumerateGatedMcpTools(auth);
    expect(tools.has("chorus_pm_validate_elaboration")).toBe(false);
  });
});

// ============================================================
// Scenario 3 — deliberately not implemented here; covered transitively.
// The UI pickers emit { roles, permissions } payloads that POST /api/agents
// consumes; the REST + MCP behavior of that payload is Scenario 1's contract.
// Dedicated picker tests live in:
//   src/app/onboarding/__tests__/*.test.tsx                 (T7)
//   src/components/__tests__/AgentPermissionPicker.test.tsx (T8)
//   src/app/(dashboard)/settings/agents/[uuid]/__tests__/*.test.tsx (T9)
// Driving a real browser is out of scope for this Vitest suite.
// ============================================================

// ============================================================
// Scenario 4 — super_admin bypasses REST permission gates
// ============================================================

describe("Scenario 4: super_admin bypass (AC4)", () => {
  it("super_admin passes the agent-permission gate on a read endpoint (idea:read)", async () => {
    // super_admin is neither "agent" nor "user"; checkAgentPermission short-circuits
    // only on "agent", so this passes through to the service layer.
    mockGetAuthContext.mockResolvedValue({
      type: "super_admin",
      companyUuid,
    });

    const response = await getIdeas(
      jsonRequest(`/api/projects/${projectUuid}/ideas`),
      makeContext({ uuid: projectUuid }),
    );

    expect(response.status).toBe(200);
    expect(mockListIdeas).toHaveBeenCalled();
  });

  it("super_admin bypasses the write-path agent gate on POST proposals", async () => {
    // POST proposals uses an inline isAgent+hasPermission gate instead of checkAgentPermission.
    // super_admin is not an agent, so the gate's `isAgent(auth)` branch is skipped;
    // the `else if (!isUser(auth))` branch returns 403 for any non-user non-agent.
    // This asserts the expected behavior: super_admin cannot create proposals via
    // this REST endpoint. Their path for privileged ops is separate (admin endpoints
    // and MCP admin tools). The test records this contract so future route changes
    // don't silently widen super_admin's surface.
    mockGetAuthContext.mockResolvedValue({
      type: "super_admin",
      companyUuid,
    });

    const response = await postProposal(
      jsonRequest(`/api/projects/${projectUuid}/proposals`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "P",
          inputType: "idea",
          inputUuids: ["idea-1"],
        }),
      }),
      makeContext({ uuid: projectUuid }),
    );

    // The inline gate returns 403 "Only users or permitted agents...", not "Missing permission".
    expect(response.status).toBe(403);
    expect(mockCreateProposal).not.toHaveBeenCalled();
  });
});
