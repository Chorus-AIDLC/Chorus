import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== Module mocks (hoisted) =====
// The tests only care about which tool names get registered; handler behavior is
// not exercised, so we stub every service as an empty object. Prisma is also
// stubbed — none of its methods are called during registration.

vi.mock("@/lib/prisma", () => ({
  prisma: {},
}));

vi.mock("@/services/project.service", () => ({}));
vi.mock("@/services/task.service", () => ({}));
vi.mock("@/services/proposal.service", () => ({}));
vi.mock("@/services/activity.service", () => ({}));
vi.mock("@/services/session.service", () => ({}));
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

import type { AgentAuthContext } from "@/types/auth";
import type { Permission } from "@/lib/authz/types";
import { ROLE_PRESETS } from "@/lib/authz/presets";
import { registerPmTools } from "@/mcp/tools/pm";
import { registerDeveloperTools } from "@/mcp/tools/developer";
import { registerAdminTools } from "@/mcp/tools/admin";
import { TOOL_PERMISSIONS } from "@/mcp/tools/permission-map";

// Minimal McpServer stand-in: records every tool name that gets registered.
function makeCapturingServer() {
  const names: string[] = [];
  const server = {
    registerTool: (name: string) => {
      names.push(name);
    },
  };
  return { server, names };
}

function makeAuth(permissions: Permission[]): AgentAuthContext {
  return {
    type: "agent",
    companyUuid: "co-1",
    actorUuid: "agent-1",
    agentName: "Test Agent",
    roles: [],
    permissions,
  };
}

// Register all three gated tool modules with the given permissions and return
// the set of registered tool names (names only, deterministic order doesn't matter).
function registeredFor(permissions: Permission[]): Set<string> {
  const { server, names } = makeCapturingServer();
  const auth = makeAuth(permissions);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerPmTools(server as any, auth);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerDeveloperTools(server as any, auth);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerAdminTools(server as any, auth);
  return new Set(names);
}

// 0.6.x tool lists captured from pm.ts / developer.ts / admin.ts before this
// refactor. Used for strict-equality / superset assertions.
//
// 0.9.0 note (proposal e35b558c): three redundant pm-surface tools were removed
// from this baseline — the deprecated batch-create-tasks alias (covered by the
// public batch-create-tasks tool) and the two add/remove-task-dependency tools
// (covered by the update-task tool's incremental dependency arrays). See
// permission-map.ts and pm.ts; the names are intentionally not spelled here so
// downstream grep checks stay clean.
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
  "chorus_pm_validate_elaboration",
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

describe("MCP tool permission wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("permission-map coverage (AC2)", () => {
    it("maps every gated tool that pm/developer/admin register", () => {
      // Gather the full set of tools registered when the agent holds every permission.
      const allPerms: Permission[] = [...ROLE_PRESETS.admin_agent];
      const registered = registeredFor(allPerms);
      const mapped = new Set(Object.keys(TOOL_PERMISSIONS));
      expect(registered).toEqual(mapped);
    });
  });

  describe("backward-compat: developer_agent preset (AC4)", () => {
    it("developer_agent with empty custom permissions sees exactly the 0.6.x developer tool set", () => {
      const registered = registeredFor([...ROLE_PRESETS.developer_agent]);
      expect(registered).toEqual(new Set(OLD_DEVELOPER_TOOLS));
    });
  });

  describe("backward-compat+: pm_agent preset (AC5)", () => {
    it("pm_agent is a strict superset of the 0.6.x pm tool set (no previously-visible tool is removed)", () => {
      const registered = registeredFor([...ROLE_PRESETS.pm_agent]);
      for (const old of OLD_PM_TOOLS) {
        expect(registered.has(old)).toBe(true);
      }
    });

    it("pm_agent gains the 5 project:write tools introduced in 0.7.0", () => {
      const registered = registeredFor([...ROLE_PRESETS.pm_agent]);
      for (const newTool of [
        "chorus_admin_create_project",
        "chorus_admin_create_project_group",
        "chorus_admin_update_project_group",
        "chorus_admin_delete_project_group",
        "chorus_admin_move_project_to_group",
      ]) {
        expect(registered.has(newTool)).toBe(true);
      }
    });

    it("pm_agent does not see any admin-only tool (proposal:admin / task:admin / *:admin)", () => {
      const registered = registeredFor([...ROLE_PRESETS.pm_agent]);
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
      ]) {
        expect(registered.has(adminOnly)).toBe(false);
      }
    });
  });

  describe("backward-compat: admin_agent preset (AC6)", () => {
    it("admin_agent sees exactly the union of 0.6.x admin + pm + developer tool sets", () => {
      const registered = registeredFor([...ROLE_PRESETS.admin_agent]);
      const expected = new Set([
        ...OLD_ADMIN_TOOLS,
        ...OLD_PM_TOOLS,
        ...OLD_DEVELOPER_TOOLS,
      ]);
      expect(registered).toEqual(expected);
    });
  });

  describe("fine-grained custom permissions (AC7)", () => {
    it("a permissions:['task:read'] agent sees no gated tool (read-only tools live in public.ts)", () => {
      const registered = registeredFor(["task:read"]);
      expect(registered.size).toBe(0);
    });

    it("adding task:write exposes exactly the 5 developer.ts tools", () => {
      const registered = registeredFor(["task:read", "task:write"]);
      expect(registered).toEqual(new Set(OLD_DEVELOPER_TOOLS));
    });
  });

  describe("permission-map semantic assertions (AC8)", () => {
    it("admin proposal tools require proposal:admin", () => {
      expect(TOOL_PERMISSIONS.chorus_admin_approve_proposal).toBe("proposal:admin");
      expect(TOOL_PERMISSIONS.chorus_admin_close_proposal).toBe("proposal:admin");
    });

    it("admin task state tools require task:admin", () => {
      expect(TOOL_PERMISSIONS.chorus_admin_verify_task).toBe("task:admin");
      expect(TOOL_PERMISSIONS.chorus_admin_reopen_task).toBe("task:admin");
      expect(TOOL_PERMISSIONS.chorus_admin_close_task).toBe("task:admin");
    });

    it("proposal create and all draft tools require proposal:write", () => {
      expect(TOOL_PERMISSIONS.chorus_pm_create_proposal).toBe("proposal:write");
      expect(TOOL_PERMISSIONS.chorus_pm_add_document_draft).toBe("proposal:write");
      expect(TOOL_PERMISSIONS.chorus_pm_add_task_draft).toBe("proposal:write");
      expect(TOOL_PERMISSIONS.chorus_pm_update_document_draft).toBe("proposal:write");
      expect(TOOL_PERMISSIONS.chorus_pm_update_task_draft).toBe("proposal:write");
      expect(TOOL_PERMISSIONS.chorus_pm_remove_document_draft).toBe("proposal:write");
      expect(TOOL_PERMISSIONS.chorus_pm_remove_task_draft).toBe("proposal:write");
    });

    it("admin_create_project and ProjectGroup mutations require project:write", () => {
      expect(TOOL_PERMISSIONS.chorus_admin_create_project).toBe("project:write");
      expect(TOOL_PERMISSIONS.chorus_admin_create_project_group).toBe("project:write");
      expect(TOOL_PERMISSIONS.chorus_admin_update_project_group).toBe("project:write");
      expect(TOOL_PERMISSIONS.chorus_admin_delete_project_group).toBe("project:write");
      expect(TOOL_PERMISSIONS.chorus_admin_move_project_to_group).toBe("project:write");
    });
  });
});
