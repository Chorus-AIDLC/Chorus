// src/mcp/tools/permission-map.ts
//
// Coverage contract for permission-gated MCP tools.
//
// This map is the *source of truth for tests* (src/mcp/__tests__/server.test.ts):
// it lets the suite assert that every tool gated via `registerPermissionedTool`
// is registered under the expected Permission, and catches drift when someone
// adds a new tool without a gate. Production tool registration uses
// `registerPermissionedTool` with its Permission inlined at the call site — the
// map is intentionally not consulted at runtime so the permission for each tool
// stays visible next to the handler.
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
  // Elaboration (idea:write per §5.3)
  chorus_pm_start_elaboration: "idea:write",
  chorus_pm_validate_elaboration: "idea:write",
  chorus_pm_skip_elaboration: "idea:write",
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
