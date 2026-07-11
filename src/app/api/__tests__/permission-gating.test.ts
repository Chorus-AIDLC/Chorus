// Integration tests for T4: REST API permission gating (AC4-AC7)
// Verifies that agents are gated by their effective permission set,
// that super_admin bypasses gating, and that admin-only endpoints are gated by the admin bit.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetAuthContext = vi.fn();
const mockGetSuperAdminFromRequest = vi.fn();

// Service mocks — return benign shapes so the happy paths reach a 2xx status
const mockListIdeas = vi.fn();
const mockCreateIdea = vi.fn();
const mockProjectExists = vi.fn();
const mockListProposals = vi.fn();
const mockCreateProposal = vi.fn();
const mockGetProposalByUuid = vi.fn();
const mockApproveProposal = vi.fn();
const mockCreateActivity = vi.fn();
const mockGetTask = vi.fn();

vi.mock("@/lib/super-admin", () => ({
  getSuperAdminFromRequest: (...args: unknown[]) => mockGetSuperAdminFromRequest(...args),
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

// Intercept getAuthContext to fully control the auth shape passed into handlers.
// Keep the real checkAgentPermission/hasPermission/etc. so we exercise the real gate logic.
vi.mock("@/lib/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth")>("@/lib/auth");
  return {
    ...actual,
    getAuthContext: (...args: unknown[]) => mockGetAuthContext(...args),
  };
});

vi.mock("@/services/idea.service", () => ({
  listIdeas: (...args: unknown[]) => mockListIdeas(...args),
  createIdea: (...args: unknown[]) => mockCreateIdea(...args),
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

// Reference-artifact service — benign shapes so happy paths reach 2xx. The
// gating tests below assert these are NOT called when the gate rejects.
const mockListReferences = vi.fn();
const mockCreateReference = vi.fn();
const mockGetReference = vi.fn();
const mockUpdateReference = vi.fn();
const mockDeleteReference = vi.fn();

vi.mock("@/services/reference-artifact.service", () => ({
  listReferences: (...args: unknown[]) => mockListReferences(...args),
  createReference: (...args: unknown[]) => mockCreateReference(...args),
  getReference: (...args: unknown[]) => mockGetReference(...args),
  updateReference: (...args: unknown[]) => mockUpdateReference(...args),
  deleteReference: (...args: unknown[]) => mockDeleteReference(...args),
  // The route imports these constants for target-type validation.
  REFERENCE_TYPES: ["docs", "repo", "issue_pr", "paper_blog"],
  REFERENCE_TARGET_TYPES: ["proposal", "task"],
}));

import { GET as getIdeas, POST as postIdea } from "@/app/api/projects/[uuid]/ideas/route";
import { GET as getProposals, POST as postProposal } from "@/app/api/projects/[uuid]/proposals/route";
import { POST as approveProposalHandler } from "@/app/api/proposals/[uuid]/approve/route";
import { GET as getTaskHandler } from "@/app/api/tasks/[uuid]/route";
import { GET as getReferences, POST as postReference } from "@/app/api/references/route";
import {
  GET as getReference,
  PATCH as patchReference,
  DELETE as deleteReference,
} from "@/app/api/references/[uuid]/route";

const companyUuid = "company-0000-0000-0000-000000000001";
const projectUuid = "project-0000-0000-0000-000000000001";
const proposalUuid = "proposal-0000-0000-0000-0000000000a1";
const taskUuid = "task-0000-0000-0000-00000000000a";

function makeRequest(
  url: string,
  init?: { method?: string; body?: BodyInit; headers?: HeadersInit },
): NextRequest {
  return new NextRequest(new URL(url, "http://localhost:3000"), init);
}

function makeContext<T>(params: T) {
  return { params: Promise.resolve(params) };
}

function readAuth(
  overrides: Partial<{ type: string; roles: string[]; permissions: string[] }> = {},
) {
  return {
    type: "agent" as const,
    companyUuid,
    actorUuid: "agent-read-only",
    agentName: "Read-only Agent",
    roles: overrides.roles ?? [],
    permissions: overrides.permissions ?? ["idea:read"],
  };
}

describe("T4: REST API permission gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSuperAdminFromRequest.mockResolvedValue(null);
    mockProjectExists.mockResolvedValue(true);
    mockListIdeas.mockResolvedValue({ ideas: [], total: 0 });
    mockCreateIdea.mockResolvedValue({ uuid: "idea-new" });
    mockListProposals.mockResolvedValue({ proposals: [], total: 0 });
    mockCreateProposal.mockResolvedValue({ uuid: "proposal-new" });
    mockGetProposalByUuid.mockResolvedValue({
      uuid: proposalUuid,
      projectUuid,
      status: "pending",
    });
    mockApproveProposal.mockResolvedValue({ uuid: proposalUuid, status: "approved" });
    mockGetTask.mockResolvedValue({ uuid: taskUuid, title: "t" });
    mockListReferences.mockResolvedValue([]);
    mockCreateReference.mockResolvedValue({ uuid: "ref-new" });
    mockGetReference.mockResolvedValue({ uuid: "ref-1" });
    mockUpdateReference.mockResolvedValue({ uuid: "ref-1", title: "updated" });
    mockDeleteReference.mockResolvedValue(undefined);
  });

  // AC4: agent with idea:read only — GET ideas allowed, POST idea forbidden
  describe("AC4: agent with permissions=['idea:read'] and roles=[]", () => {
    it("can GET /api/projects/[uuid]/ideas (read is allowed)", async () => {
      mockGetAuthContext.mockResolvedValue(readAuth({ permissions: ["idea:read"] }));

      const response = await getIdeas(
        makeRequest(`/api/projects/${projectUuid}/ideas`),
        makeContext({ uuid: projectUuid }),
      );

      expect(response.status).toBe(200);
      expect(mockListIdeas).toHaveBeenCalled();
    });

    it("gets 403 on POST /api/projects/[uuid]/ideas (no idea:write)", async () => {
      mockGetAuthContext.mockResolvedValue(readAuth({ permissions: ["idea:read"] }));

      const response = await postIdea(
        makeRequest(`/api/projects/${projectUuid}/ideas`, {
          method: "POST",
          body: JSON.stringify({ title: "new idea" }),
          headers: { "content-type": "application/json" },
        }),
        makeContext({ uuid: projectUuid }),
      );

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.success).toBe(false);
      expect(mockCreateIdea).not.toHaveBeenCalled();
    });
  });

  // AC5: pm_agent can POST proposal, but 403 on approve (approve needs proposal:admin)
  describe("AC5: agent with roles=['pm_agent']", () => {
    const pmPermissions = [
      "idea:read", "idea:write",
      "proposal:read", "proposal:write",
      "document:read", "document:write",
      "task:read", "task:write",
      "project:read", "project:write",
    ];

    it("can POST /api/projects/[uuid]/proposals (has proposal:write)", async () => {
      mockGetAuthContext.mockResolvedValue({
        type: "agent",
        companyUuid,
        actorUuid: "agent-pm",
        agentName: "PM Agent",
        roles: ["pm_agent"],
        permissions: pmPermissions,
      });

      const response = await postProposal(
        makeRequest(`/api/projects/${projectUuid}/proposals`, {
          method: "POST",
          body: JSON.stringify({
            title: "Proposal",
            inputType: "idea",
            inputUuids: ["idea-x"],
          }),
          headers: { "content-type": "application/json" },
        }),
        makeContext({ uuid: projectUuid }),
      );

      expect(response.status).toBe(200);
      expect(mockCreateProposal).toHaveBeenCalled();
    });

    it("gets 403 on POST /api/proposals/[uuid]/approve (no proposal:admin)", async () => {
      mockGetAuthContext.mockResolvedValue({
        type: "agent",
        companyUuid,
        actorUuid: "agent-pm",
        agentName: "PM Agent",
        roles: ["pm_agent"],
        permissions: pmPermissions,
      });

      const response = await approveProposalHandler(
        makeRequest(`/api/proposals/${proposalUuid}/approve`, {
          method: "POST",
          body: JSON.stringify({}),
          headers: { "content-type": "application/json" },
        }),
        makeContext({ uuid: proposalUuid }),
      );

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error.message).toContain("proposal:admin");
      expect(mockApproveProposal).not.toHaveBeenCalled();
    });
  });

  // AC6: super_admin bypasses the agent-permission gate
  describe("AC6: super_admin bypasses permission checks", () => {
    it("super_admin request passes the gate on a read endpoint", async () => {
      // Routes that use the inline checkAgentPermission helper read auth via
      // getAuthContext. super_admin is a distinct session type — it is not
      // a bearer-only path. A user-typed auth with super_admin bypass cookie
      // would be returned by getUserSessionFromRequest; here we stub getAuthContext
      // directly returning a super_admin-like context that is neither "agent" nor "user".
      mockGetAuthContext.mockResolvedValue({
        type: "super_admin",
        // super_admin doesn't carry companyUuid; routes will still query with undefined.
        // For this gate-only test, a stub project/idea mock tolerates it.
        companyUuid: companyUuid,
      });

      const response = await getIdeas(
        makeRequest(`/api/projects/${projectUuid}/ideas`),
        makeContext({ uuid: projectUuid }),
      );

      // The gate must not 403 super_admin; we reach listIdeas.
      expect(response.status).not.toBe(403);
      expect(mockListIdeas).toHaveBeenCalled();
    });
  });

  // AC7: admin_agent has proposal:admin → can call approve endpoint
  describe("AC7: agent with roles=['admin_agent'] can call admin endpoints", () => {
    const adminPermissions = [
      "idea:read", "idea:write", "idea:admin",
      "proposal:read", "proposal:write", "proposal:admin",
      "document:read", "document:write", "document:admin",
      "task:read", "task:write", "task:admin",
      "project:read", "project:write", "project:admin",
    ];

    it("can POST /api/proposals/[uuid]/approve", async () => {
      mockGetAuthContext.mockResolvedValue({
        type: "agent",
        companyUuid,
        actorUuid: "agent-admin",
        agentName: "Admin Agent",
        roles: ["admin_agent"],
        permissions: adminPermissions,
      });

      const response = await approveProposalHandler(
        makeRequest(`/api/proposals/${proposalUuid}/approve`, {
          method: "POST",
          body: JSON.stringify({ reviewNote: "ok" }),
          headers: { "content-type": "application/json" },
        }),
        makeContext({ uuid: proposalUuid }),
      );

      expect(response.status).toBe(200);
      expect(mockApproveProposal).toHaveBeenCalled();
    });
  });

  // Reference artifacts reuse the `document` permission resource (no new bit):
  // reads gate on document:read, mutations on document:write.
  describe("reference artifacts: document:read / document:write gating", () => {
    const referenceUuid = "reference-0000-0000-0000-00000000000a";

    // An agent with document:read but NOT document:write.
    const readOnlyDocPerms = ["document:read"];
    // An agent with both document:read and document:write.
    const writeDocPerms = ["document:read", "document:write"];

    it("allows GET /api/references with document:read", async () => {
      mockGetAuthContext.mockResolvedValue(readAuth({ permissions: readOnlyDocPerms }));

      const response = await getReferences(
        makeRequest(`/api/references?targetType=proposal&targetUuid=${proposalUuid}`),
        makeContext({}),
      );

      expect(response.status).toBe(200);
      expect(mockListReferences).toHaveBeenCalled();
    });

    it("gets 403 on GET /api/references without document:read", async () => {
      mockGetAuthContext.mockResolvedValue(readAuth({ permissions: ["idea:read"] }));

      const response = await getReferences(
        makeRequest(`/api/references?targetType=proposal&targetUuid=${proposalUuid}`),
        makeContext({}),
      );

      expect(response.status).toBe(403);
      expect(mockListReferences).not.toHaveBeenCalled();
    });

    it("gets 403 on POST /api/references with document:read but NOT document:write", async () => {
      mockGetAuthContext.mockResolvedValue(readAuth({ permissions: readOnlyDocPerms }));

      const response = await postReference(
        makeRequest(`/api/references`, {
          method: "POST",
          body: JSON.stringify({
            targetType: "proposal",
            targetUuid: proposalUuid,
            type: "repo",
            url: "https://example.com",
            title: "Ref",
          }),
          headers: { "content-type": "application/json" },
        }),
        makeContext({}),
      );

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error.message).toContain("document:write");
      expect(mockCreateReference).not.toHaveBeenCalled();
    });

    it("allows POST /api/references with document:write", async () => {
      mockGetAuthContext.mockResolvedValue(readAuth({ permissions: writeDocPerms }));

      const response = await postReference(
        makeRequest(`/api/references`, {
          method: "POST",
          body: JSON.stringify({
            targetType: "task",
            targetUuid: taskUuid,
            type: "docs",
            url: "https://example.com/docs",
            title: "Docs",
          }),
          headers: { "content-type": "application/json" },
        }),
        makeContext({}),
      );

      expect(response.status).toBe(200);
      expect(mockCreateReference).toHaveBeenCalledWith(
        expect.objectContaining({
          targetType: "task",
          targetUuid: taskUuid,
          type: "docs",
          createdByType: "agent",
          createdByUuid: "agent-read-only",
        }),
      );
    });

    it("gets 403 on PATCH /api/references/[uuid] without document:write", async () => {
      mockGetAuthContext.mockResolvedValue(readAuth({ permissions: readOnlyDocPerms }));

      const response = await patchReference(
        makeRequest(`/api/references/${referenceUuid}`, {
          method: "PATCH",
          body: JSON.stringify({ title: "new" }),
          headers: { "content-type": "application/json" },
        }),
        makeContext({ uuid: referenceUuid }),
      );

      expect(response.status).toBe(403);
      expect(mockUpdateReference).not.toHaveBeenCalled();
    });

    it("gets 403 on DELETE /api/references/[uuid] without document:write", async () => {
      mockGetAuthContext.mockResolvedValue(readAuth({ permissions: readOnlyDocPerms }));

      const response = await deleteReference(
        makeRequest(`/api/references/${referenceUuid}`, { method: "DELETE" }),
        makeContext({ uuid: referenceUuid }),
      );

      expect(response.status).toBe(403);
      expect(mockDeleteReference).not.toHaveBeenCalled();
    });

    it("returns 404 on GET /api/references/[uuid] when the row is absent/cross-tenant", async () => {
      mockGetAuthContext.mockResolvedValue(readAuth({ permissions: readOnlyDocPerms }));
      mockGetReference.mockResolvedValue(null);

      const response = await getReference(
        makeRequest(`/api/references/${referenceUuid}`),
        makeContext({ uuid: referenceUuid }),
      );

      expect(response.status).toBe(404);
    });
  });

  // Extra coverage: agent with no permissions at all cannot read.
  describe("agent with permissions=[] and roles=[]", () => {
    it("gets 403 on GET /api/tasks/[uuid] (no task:read)", async () => {
      mockGetAuthContext.mockResolvedValue({
        type: "agent",
        companyUuid,
        actorUuid: "agent-empty",
        agentName: "Empty Agent",
        roles: [],
        permissions: [],
      });

      const response = await getTaskHandler(
        makeRequest(`/api/tasks/${taskUuid}`),
        makeContext({ uuid: taskUuid }),
      );

      expect(response.status).toBe(403);
      expect(mockGetTask).not.toHaveBeenCalled();
    });
  });
});
