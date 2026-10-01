// src/mcp/tools/permission-map.ts
//
// Coverage contract for permission-gated MCP tools.
//
// Tests (src/mcp/__tests__/server.test.ts) use this map to assert that every
// `registerPermissionedTool` call uses the expected Permission. Registration
// keeps that permission inline beside its handler. The central project-access
// wrapper also derives a default project level from this map, with explicit
// overrides below for management, public mutations and company-wide tools.
//
// Most public-namespaced tools in public.ts (read-only discovery, comments,
// session, notifications) are NOT gated and are intentionally absent from this
// map. The exception is `chorus_create_report`, which is public-namespaced
// (no `pm_` prefix per add-idea-completion-report Tech Design §"MCP tool
// contract") but IS gated on `document:write` — it appears here because it
// goes through `registerPermissionedTool`. Session tools (session.ts) remain
// ungated. See Tech Design §5.3.

import type { Permission } from "@/lib/authz/types";

export const TOOL_PERMISSIONS = {
  // ===== pm.ts =====
  // Idea mutations
  chorus_claim_idea: "idea:write",
  chorus_release_idea: "idea:write",
  chorus_move_idea: "idea:write",
  chorus_pm_create_idea: "idea:write",
  chorus_edit_idea: "idea:write",
  // Elaboration (idea:write per §5.3)
  chorus_pm_start_elaboration: "idea:write",
  chorus_pm_skip_elaboration: "idea:write",
  // Resolution is admin-gated (idea:admin) per simplify-elaboration-flow Tech
  // Design §MCP & permissions: only admin_agent can resolve; pm_agent's preset
  // (idea:write) cannot, by design. Exposed under the legacy name
  // `chorus_pm_validate_elaboration` (reused, not a new tool).
  chorus_pm_validate_elaboration: "idea:admin",
  // Idea assignment (MCP surface over the human assign-idea action). Gated
  // idea:admin — a directed reassignment/takeover is an admin-level action,
  // aligning with chorus_pm_validate_elaboration; the pm_agent preset (idea:write)
  // cannot see it, only admin_agent (idea:admin) can.
  chorus_pm_assign_idea: "idea:admin",
  // Proposal writes
  chorus_pm_create_proposal: "proposal:write",
  chorus_pm_validate_proposal: "proposal:write",
  chorus_pm_submit_proposal: "proposal:write",
  chorus_pm_add_document_draft: "proposal:write",
  chorus_pm_add_task_draft: "proposal:write",
  chorus_pm_update_document_draft: "proposal:write",
  chorus_pm_update_task_draft: "proposal:write",
  chorus_pm_remove_document_draft: "proposal:write",
  chorus_pm_remove_task_draft: "proposal:write",
  chorus_pm_reject_proposal: "proposal:write",
  chorus_pm_revoke_proposal: "proposal:write",
  // Document writes
  chorus_pm_create_document: "document:write",
  chorus_pm_update_document: "document:write",
  // Idea-completion report (public-namespaced, gated on document:write).
  // See add-idea-completion-report spec delta `mcp-tool-surface`.
  chorus_create_report: "document:write",
  // Reference artifact writes — reuse the `document` resource (no new bit), per
  // the reference-artifacts Tech Design. Targets idea/proposal/task; read path is
  // inline on chorus_get_idea / chorus_get_proposal / chorus_get_task; no read tool.
  chorus_add_reference: "document:write",
  chorus_update_reference: "document:write",
  chorus_remove_reference: "document:write",
  // Task-editing tools historically on the PM surface.
  // Mapped to proposal:write to preserve 0.6.x dev boundaries (AC4): dev has
  // task:write but not proposal:write, so dev keeps exactly its 0.6.x tool set.
  chorus_pm_assign_task: "proposal:write",

  // ===== developer.ts =====
  chorus_claim_task: "task:write",
  chorus_release_task: "task:write",
  chorus_submit_for_verify: "task:write",
  chorus_report_criteria_self_check: "task:write",
  chorus_report_work: "task:write",

  // ===== admin.ts =====
  // Project write (includes Project and ProjectGroup mutations per §2.3)
  chorus_admin_create_project: "project:write",
  chorus_admin_create_project_group: "project:write",
  chorus_admin_update_project_group: "project:write",
  chorus_admin_delete_project_group: "project:write",
  chorus_admin_move_project_to_group: "project:write",
  // Proposal admin (approve + admin-only close)
  chorus_admin_approve_proposal: "proposal:admin",
  chorus_admin_close_proposal: "proposal:admin",
  // Task admin (verify, reopen, close)
  chorus_admin_verify_task: "task:admin",
  chorus_admin_reopen_task: "task:admin",
  chorus_admin_close_task: "task:admin",
  // Admin-only task tools in 0.6.x (mark_acceptance_criteria, admin_delete_task).
  // Mapped to task:admin so backward-compat AC4 (dev) holds — dev does not have task:admin.
  chorus_mark_acceptance_criteria: "task:admin",
  chorus_admin_delete_task: "task:admin",
  // Admin-only destructive tools in 0.6.x. Mapped to the *:admin permission so pm
  // doesn't inherit them via idea:write / document:write — keeps admin-only surface
  // for these delete operations.
  chorus_admin_delete_idea: "idea:admin",
  chorus_admin_delete_document: "document:admin",
} as const satisfies Record<string, Permission>;

export type ManagedToolName = keyof typeof TOOL_PERMISSIONS;

export type ToolProjectAccessPolicy =
  | { scope: "resource"; required: "viewer" | "editor" | "manage_project" }
  | { scope: "company" | "filtered" };

// Exceptions are explicit: company tools do not touch project content, while
// filtered tools delegate the accessible-project intersection to their service.
// Public tool names alone do not tell us whether a call reads or writes.
export const TOOL_PROJECT_ACCESS_OVERRIDES = {
  chorus_get_project: { scope: "resource", required: "viewer" },
  chorus_get_ideas: { scope: "resource", required: "viewer" },
  chorus_get_documents: { scope: "resource", required: "viewer" },
  chorus_get_document: { scope: "resource", required: "viewer" },
  chorus_get_activity: { scope: "resource", required: "viewer" },
  chorus_get_task: { scope: "resource", required: "viewer" },
  chorus_list_tasks: { scope: "resource", required: "viewer" },
  chorus_get_proposals: { scope: "resource", required: "viewer" },
  chorus_get_available_ideas: { scope: "resource", required: "viewer" },
  chorus_get_available_tasks: { scope: "resource", required: "viewer" },
  chorus_get_idea: { scope: "resource", required: "viewer" },
  chorus_get_proposal: { scope: "resource", required: "viewer" },
  chorus_get_unblocked_tasks: { scope: "resource", required: "viewer" },
  chorus_get_comments: { scope: "resource", required: "viewer" },
  chorus_get_elaboration: { scope: "resource", required: "viewer" },
  chorus_search_mentionables: { scope: "resource", required: "viewer" },
  chorus_add_comment: { scope: "resource", required: "editor" },
  chorus_answer_elaboration: { scope: "resource", required: "editor" },
  chorus_create_tasks: { scope: "resource", required: "editor" },
  chorus_update_task: { scope: "resource", required: "editor" },
  chorus_get_session: { scope: "resource", required: "viewer" },
  chorus_close_session: { scope: "resource", required: "editor" },
  chorus_reopen_session: { scope: "resource", required: "editor" },
  chorus_session_heartbeat: { scope: "resource", required: "editor" },
  chorus_session_checkin_task: { scope: "resource", required: "editor" },
  chorus_session_checkout_task: { scope: "resource", required: "editor" },
  chorus_admin_move_project_to_group: { scope: "resource", required: "manage_project" },
  chorus_admin_delete_project_group: { scope: "resource", required: "manage_project" },

  chorus_list_projects: { scope: "filtered" },
  chorus_search: { scope: "filtered" },
  chorus_get_my_assignments: { scope: "filtered" },
  chorus_checkin: { scope: "filtered" },
  chorus_get_project_groups: { scope: "filtered" },
  chorus_get_project_group: { scope: "filtered" },
  chorus_get_group_dashboard: { scope: "filtered" },

  chorus_get_notifications: { scope: "company" },
  chorus_mark_notification_read: { scope: "company" },
  chorus_list_sessions: { scope: "company" },
  chorus_create_session: { scope: "company" },
  chorus_admin_create_project: { scope: "company" },
  chorus_admin_create_project_group: { scope: "company" },
  chorus_admin_update_project_group: { scope: "company" },
} as const satisfies Record<string, ToolProjectAccessPolicy>;

/** Fail registration when a new tool has no reviewed access policy. */
export function getToolProjectAccessPolicy(name: string): ToolProjectAccessPolicy {
  if (Object.hasOwn(TOOL_PROJECT_ACCESS_OVERRIDES, name)) {
    return TOOL_PROJECT_ACCESS_OVERRIDES[name as keyof typeof TOOL_PROJECT_ACCESS_OVERRIDES];
  }
  if (Object.hasOwn(TOOL_PERMISSIONS, name)) {
    const [resource, action] = TOOL_PERMISSIONS[name as ManagedToolName].split(":");
    return {
      scope: "resource",
      required: action === "read" ? "viewer" : resource === "project" ? "manage_project" : "editor",
    };
  }
  throw new Error(`MCP tool missing explicit project access classification: ${name}`);
}
