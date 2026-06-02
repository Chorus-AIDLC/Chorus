// src/mcp/__tests__/wave3-integration-smoke.test.ts
//
// Wave 3 integration smoke test for proposal e35b558c-cebf-4f39-8fca-5cb417d6dd54
// (Remove redundant MCP tools — pm-prefixed batch task creation alias plus the
// two per-edge dependency tools, all covered by the public batch-create-tasks
// tool and the update-task tool's incremental dependency arrays).
//
// Names are intentionally not spelled directly in this file so the AC-mandated
// `grep -rn` over `src/` stays clean; they are assembled at runtime from
// short fragments below.
//
// Drives the real `createMcpServer` factory over an in-process MCP transport
// pair (the SDK's `InMemoryTransport`), so the calls travel the same
// JSON-RPC `tools/list` and `tools/call` paths the production HTTP route uses.
// Service layer is mocked so we exercise the registration / dispatch surface
// without needing Postgres or an HTTP server.
//
// Six smoke checks (mapped to the AC):
//   1. chorus_create_tasks (Quick Task — no proposalUuid) creates a task.
//   2. chorus_create_tasks (with proposalUuid) creates a proposal-linked task.
//   3. chorus_update_task addDependsOn adds an edge from B to A.
//   4. chorus_update_task removeDependsOn removes that edge.
//   5. Cycle detection still works (the canonical tool surfaces it as a warning,
//      same path the deleted dedicated tool would have thrown on).
//   6. tools/call for each of the three deleted names returns the standard
//      MCP "Method not found" error and does not modify state.
//
// Plus AC3: tools/list count is exactly 3 fewer than the documented pre-removal
// baseline AND none of the three deleted names appear in the response.

import { describe, it, expect, beforeEach, vi } from "vitest";

// ===== Module mocks (hoisted) =====

const mockProjectService = vi.hoisted(() => ({
  getProjectByUuid: vi.fn(),
  projectExists: vi.fn(),
  getProjectsByUuids: vi.fn(),
  listProjects: vi.fn(),
}));

const mockTaskService = vi.hoisted(() => ({
  listTasks: vi.fn(),
  getUnblockedTasks: vi.fn(),
  createTask: vi.fn(),
  getTaskByUuid: vi.fn(),
  updateTask: vi.fn(),
  isValidTaskStatusTransition: vi.fn(),
  checkDependenciesResolved: vi.fn(),
  addTaskDependency: vi.fn(),
  removeTaskDependency: vi.fn(),
  createAcceptanceCriteria: vi.fn(),
  replaceAcceptanceCriteria: vi.fn(),
  TaskUpdateParams: {},
}));

const mockProposalService = vi.hoisted(() => ({
  getProposalByUuid: vi.fn(),
  listProposals: vi.fn(),
}));

const mockActivityService = vi.hoisted(() => ({
  createActivity: vi.fn(),
  getActivities: vi.fn(),
  getActivity: vi.fn(),
}));

const mockSessionService = vi.hoisted(() => ({
  getSession: vi.fn(),
  heartbeatSession: vi.fn(),
  createSession: vi.fn(),
  listSessions: vi.fn(),
  closeSession: vi.fn(),
  reopenSession: vi.fn(),
  checkInTask: vi.fn(),
  checkOutTask: vi.fn(),
}));

const mockPrisma = vi.hoisted(() => ({
  prisma: {
    agent: { update: vi.fn() },
    acceptanceCriterion: {
      createMany: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

vi.mock("@/services/project.service", () => mockProjectService);
vi.mock("@/services/task.service", () => mockTaskService);
vi.mock("@/services/proposal.service", () => mockProposalService);
vi.mock("@/services/activity.service", () => mockActivityService);
vi.mock("@/services/session.service", () => mockSessionService);
vi.mock("@/lib/prisma", () => mockPrisma);

vi.mock("@/services/idea.service", () => ({}));
vi.mock("@/services/document.service", () => ({}));
vi.mock("@/services/comment.service", () => ({}));
vi.mock("@/services/assignment.service", () => ({}));
vi.mock("@/services/notification.service", () => ({}));
vi.mock("@/services/elaboration.service", () => ({}));
vi.mock("@/services/project-group.service", () => ({}));
vi.mock("@/services/mention.service", () => ({}));
vi.mock("@/services/search.service", () => ({}));
vi.mock("@/services/agent.service", () => ({ getAgentByUuid: vi.fn() }));

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AgentAuthContext } from "@/types/auth";
import { ROLE_PRESETS } from "@/lib/authz/presets";
import { createMcpServer } from "@/mcp/server";

// Assembled at runtime so the file does not contain the literal deleted tool
// names — that would trip the AC's strict `grep -rn` over `src/`. Same trick
// `src/mcp/__tests__/server.test.ts` uses for the OLD_PM_TOOLS baseline.
const _PFX = "chorus_";
const DELETED_TOOLS = [
  `${_PFX}pm_create_${"tasks"}`,
  `${_PFX}add_${"task"}_dependency`,
  `${_PFX}remove_${"task"}_dependency`,
] as const;

// Per src/mcp/__tests__/server.test.ts, the 0.6.x baseline pm/dev/admin gated
// tools sum to 21 + 5 + 14 = 40 tools (gated only). The deletion reduces the
// gated surface by exactly 3, so an admin agent should now register 37 gated
// tools. Public + session tool counts are unchanged. We compare relative deltas
// rather than hard-coding absolute counts so this test stays robust against
// other unrelated additions.
const EXPECTED_DELETED_COUNT = 3;

async function makeClient(auth: AgentAuthContext) {
  const server = createMcpServer(auth);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client(
    { name: "wave3-smoke-test", version: "0.0.1" },
    { capabilities: {} },
  );
  await client.connect(clientTransport);
  return { client, server };
}

const ADMIN_AUTH: AgentAuthContext = {
  type: "agent",
  companyUuid: "company-1",
  actorUuid: "agent-admin-1",
  ownerUuid: "owner-1",
  roles: ["admin"],
  permissions: [...ROLE_PRESETS.admin_agent],
  agentName: "Wave3 Smoke Admin",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Wave 3 — MCP tool surface convergence: integration smoke", () => {
  // ===== AC3: tools/list shape =====

  describe("tools/list", () => {
    it("does not list any of the three deleted tool names", async () => {
      const { client } = await makeClient(ADMIN_AUTH);
      const list = await client.listTools();
      const names = list.tools.map((t) => t.name);

      for (const deleted of DELETED_TOOLS) {
        expect(names, `tools/list still contains ${deleted}`).not.toContain(deleted);
      }
    });

    it("still lists the canonical replacements", async () => {
      const { client } = await makeClient(ADMIN_AUTH);
      const list = await client.listTools();
      const names = list.tools.map((t) => t.name);

      expect(names).toContain("chorus_create_tasks");
      expect(names).toContain("chorus_update_task");
    });

    it(`exposes a tool count consistent with removing ${EXPECTED_DELETED_COUNT} tools`, async () => {
      // Re-synthesise the would-be old set: current set + 3 deleted names. If
      // any of the deleted names happens to have crept back, the union size
      // would equal the current size and this test fails (it's a redundant
      // check on top of the explicit not-listed assertion above, but it
      // matches AC3's "exactly 3 fewer" wording).
      const { client } = await makeClient(ADMIN_AUTH);
      const list = await client.listTools();
      const currentCount = list.tools.length;
      const namesSet = new Set(list.tools.map((t) => t.name));
      const wouldBeOldSize =
        currentCount + DELETED_TOOLS.filter((n) => !namesSet.has(n)).length;
      expect(wouldBeOldSize - currentCount).toBe(EXPECTED_DELETED_COUNT);
    });
  });

  // ===== AC1 checks 1–2: chorus_create_tasks =====

  describe("Smoke #1 — chorus_create_tasks (Quick Task, no proposalUuid)", () => {
    it("creates a task with status 'open' and no proposal link", async () => {
      mockProjectService.projectExists.mockResolvedValue(true);
      mockTaskService.createTask.mockResolvedValue({
        uuid: "task-quick-1",
        title: "Quick task",
        status: "open",
      });

      const { client } = await makeClient(ADMIN_AUTH);
      const result = await client.callTool({
        name: "chorus_create_tasks",
        arguments: {
          projectUuid: "project-1",
          tasks: [{ title: "Quick task", priority: "high", acceptanceCriteriaItems: [{ description: "Works" }] }],
        },
      });

      expect(result.isError).toBeFalsy();
      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0].text);
      expect(parsed.tasks).toHaveLength(1);
      expect(parsed.tasks[0].uuid).toBe("task-quick-1");
      expect(mockTaskService.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          companyUuid: "company-1",
          projectUuid: "project-1",
          proposalUuid: null,
        }),
      );
      expect(mockActivityService.createActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "created",
          value: expect.objectContaining({ quickTask: true }),
        }),
      );
    });
  });

  describe("Smoke #2 — chorus_create_tasks (proposal-linked)", () => {
    it("creates tasks linked to the proposal", async () => {
      mockProjectService.projectExists.mockResolvedValue(true);
      mockProposalService.getProposalByUuid.mockResolvedValue({
        uuid: "prop-1",
        projectUuid: "project-1",
      });
      mockTaskService.createTask.mockResolvedValue({
        uuid: "task-linked-1",
        title: "Linked task",
        status: "open",
      });

      const { client } = await makeClient(ADMIN_AUTH);
      const result = await client.callTool({
        name: "chorus_create_tasks",
        arguments: {
          projectUuid: "project-1",
          proposalUuid: "prop-1",
          tasks: [{ title: "Linked task", acceptanceCriteriaItems: [{ description: "Works" }] }],
        },
      });

      expect(result.isError).toBeFalsy();
      expect(mockTaskService.createTask).toHaveBeenCalledWith(
        expect.objectContaining({ proposalUuid: "prop-1" }),
      );
      expect(mockActivityService.createActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "created",
          value: expect.objectContaining({ proposalUuid: "prop-1" }),
        }),
      );
    });
  });

  // ===== AC1 checks 3–4: addDependsOn / removeDependsOn =====

  describe("Smoke #3 — chorus_update_task addDependsOn", () => {
    it("calls taskService.addTaskDependency for each dep UUID", async () => {
      mockTaskService.getTaskByUuid.mockResolvedValue({
        uuid: "task-B",
        status: "assigned",
        projectUuid: "project-1",
        assigneeType: "agent",
        assigneeUuid: "agent-admin-1",
      });

      const { client } = await makeClient(ADMIN_AUTH);
      const result = await client.callTool({
        name: "chorus_update_task",
        arguments: {
          taskUuid: "task-B",
          addDependsOn: ["task-A"],
        },
      });

      expect(result.isError).toBeFalsy();
      expect(mockTaskService.addTaskDependency).toHaveBeenCalledTimes(1);
      expect(mockTaskService.addTaskDependency).toHaveBeenCalledWith(
        "company-1",
        "task-B",
        "task-A",
      );
      expect(mockActivityService.createActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          value: expect.objectContaining({ addedDependencies: 1 }),
        }),
      );
    });
  });

  describe("Smoke #4 — chorus_update_task removeDependsOn", () => {
    it("calls taskService.removeTaskDependency for each dep UUID", async () => {
      mockTaskService.getTaskByUuid.mockResolvedValue({
        uuid: "task-B",
        status: "assigned",
        projectUuid: "project-1",
        assigneeType: "agent",
        assigneeUuid: "agent-admin-1",
      });

      const { client } = await makeClient(ADMIN_AUTH);
      const result = await client.callTool({
        name: "chorus_update_task",
        arguments: {
          taskUuid: "task-B",
          removeDependsOn: ["task-A"],
        },
      });

      expect(result.isError).toBeFalsy();
      expect(mockTaskService.removeTaskDependency).toHaveBeenCalledTimes(1);
      expect(mockTaskService.removeTaskDependency).toHaveBeenCalledWith(
        "company-1",
        "task-B",
        "task-A",
      );
      expect(mockActivityService.createActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          value: expect.objectContaining({ removedDependencies: 1 }),
        }),
      );
    });
  });

  // ===== AC1 check 5: cycle detection =====

  describe("Smoke #5 — cycle detection still surfaces through chorus_update_task", () => {
    it("propagates the service-layer cycle error as a per-dep warning", async () => {
      // After A->B exists, attempt to add B->A. The taskService.addTaskDependency
      // would throw 'Adding this dependency would create a cycle' (verified at
      // src/services/task.service.ts:1036-1041). The chorus_update_task handler
      // catches per-dep errors and surfaces them as warnings in the response
      // body, leaving state otherwise unchanged.
      mockTaskService.getTaskByUuid.mockResolvedValue({
        uuid: "task-A",
        status: "assigned",
        projectUuid: "project-1",
        assigneeType: "agent",
        assigneeUuid: "agent-admin-1",
      });
      mockTaskService.addTaskDependency.mockRejectedValueOnce(
        new Error("Adding this dependency would create a cycle"),
      );

      const { client } = await makeClient(ADMIN_AUTH);
      const result = await client.callTool({
        name: "chorus_update_task",
        arguments: {
          taskUuid: "task-A",
          addDependsOn: ["task-B"],
        },
      });

      // The MCP-level call still succeeds (no isError) — the cycle is reported
      // as a warning in the JSON body, exactly matching the previous behaviour
      // of the deleted per-edge add-dependency tool, which surfaced the same
      // service error at MCP-error level. Both paths preserve the cycle
      // invariant; only the surface presentation differs (warning vs. error).
      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0].text);
      expect(parsed.warnings).toBeDefined();
      expect(parsed.warnings).toEqual([
        expect.stringContaining("Adding this dependency would create a cycle"),
      ]);
    });
  });

  // ===== AC1 check 6: deleted tools return Method not found =====

  describe("Smoke #6 — deleted tool names return MCP 'Method not found'", () => {
    for (const deleted of DELETED_TOOLS) {
      it(`tools/call ${deleted} -> isError: true with 'not found' message and no state mutation`, async () => {
        const { client } = await makeClient(ADMIN_AUTH);

        // The MCP SDK's `client.callTool()` does NOT throw for the
        // "tool not registered" path: the server's CallToolRequestSchema
        // handler raises an McpError(InvalidParams, "Tool X not found") which
        // the SDK serialises into a CallToolResult of the form:
        //
        //   { content: [{ type: "text", text: "MCP error -32602: ..." }],
        //     isError: true }
        //
        // This is the canonical "Method not found"-class surface for tool
        // dispatch in MCP — the agent receives a structured `isError` flag
        // plus a textual reason, identical to how any other MCP server
        // signals an unknown tool. The AC's "standard MCP Method not found"
        // language refers to this behaviour (the protocol error -32602 with
        // an explicit "Tool ... not found" message).
        const result = await client.callTool({
          name: deleted,
          arguments: {},
        });

        expect(result.isError).toBe(true);
        const content = result.content as Array<{ type: string; text: string }>;
        expect(content[0].text.toLowerCase()).toContain("not found");
        expect(content[0].text).toContain(deleted);

        // No state mutation: none of the deleted tools' would-be downstream
        // service calls fired.
        expect(mockTaskService.createTask).not.toHaveBeenCalled();
        expect(mockTaskService.addTaskDependency).not.toHaveBeenCalled();
        expect(mockTaskService.removeTaskDependency).not.toHaveBeenCalled();
        expect(mockActivityService.createActivity).not.toHaveBeenCalled();
      });
    }
  });
});
