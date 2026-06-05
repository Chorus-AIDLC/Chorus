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
vi.mock("@/services/checkin.service", () => ({}));
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
import { registerPublicTools } from "@/mcp/tools/public";
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

// Register every gated tool module (pm/developer/admin and the public-namespaced
// gated tools in public.ts) with the given permissions, then keep only the names
// that appear in TOOL_PERMISSIONS — i.e. tools that go through
// `registerPermissionedTool`. Non-gated public.ts tools (chorus_get_project,
// chorus_add_comment, etc.) are intentionally filtered out so the assertions
// below stay focused on the gated surface.
function registeredFor(permissions: Permission[]): Set<string> {
  const { server, names } = makeCapturingServer();
  const auth = makeAuth(permissions);
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

// 0.6.x tool lists captured from pm.ts / developer.ts / admin.ts before this
// refactor. Used for strict-equality / superset assertions.
//
// 0.9.0 note (proposal e35b558c): three redundant pm-surface tools were removed
// from this baseline — the deprecated batch-create-tasks alias (covered by the
// public batch-create-tasks tool) and the two add/remove-task-dependency tools
// (covered by the update-task tool's incremental dependency arrays). See
// permission-map.ts and pm.ts; the names are intentionally not spelled here so
// downstream grep checks stay clean.
//
// Note: chorus_pm_validate_elaboration is gated on idea:admin, so it is NOT a
// pm-surface (idea:write) tool and intentionally does not appear in this
// idea:write baseline. It surfaces only for admin_agent; see the admin_agent
// expectation and the dedicated validate assertions below.
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
    it("admin_agent sees exactly the union of 0.6.x admin + pm + developer tool sets plus 0.9.0 chorus_create_report and 0.9.4 chorus_pm_validate_elaboration", () => {
      const registered = registeredFor([...ROLE_PRESETS.admin_agent]);
      const expected = new Set([
        ...OLD_ADMIN_TOOLS,
        ...OLD_PM_TOOLS,
        ...OLD_DEVELOPER_TOOLS,
        // 0.9.0: public-namespaced, document:write-gated. admin_agent carries
        // document:write so the tool is visible to admin presets.
        "chorus_create_report",
        // 0.9.4 (simplify-elaboration-flow): chorus_pm_validate_elaboration is
        // now idea:admin-gated (the simplified resolve action). admin_agent
        // carries idea:admin; pm_agent (idea:write only) does not.
        "chorus_pm_validate_elaboration",
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

    it("chorus_create_report is gated on document:write (AC2 of add-idea-completion-report)", () => {
      expect(TOOL_PERMISSIONS.chorus_create_report).toBe("document:write");
    });
  });

  // chorus_pm_validate_elaboration marks an Idea's elaboration complete and is
  // gated on idea:admin (admin-only).
  describe("elaboration validate tool wiring", () => {
    it("chorus_pm_validate_elaboration is registered for an idea:admin agent", () => {
      const registered = registeredFor(["idea:admin"]);
      expect(registered.has("chorus_pm_validate_elaboration")).toBe(true);
    });

    it("chorus_pm_validate_elaboration is NOT registered for an idea:write-only agent", () => {
      const registered = registeredFor(["idea:write"]);
      expect(registered.has("chorus_pm_validate_elaboration")).toBe(false);
    });

    it("chorus_pm_validate_elaboration is mapped to idea:admin in the permission map", () => {
      expect(
        (TOOL_PERMISSIONS as Record<string, string>).chorus_pm_validate_elaboration
      ).toBe("idea:admin");
    });
  });
});
