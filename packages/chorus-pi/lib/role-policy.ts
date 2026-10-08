export type ChorusRole = "reviewer" | "worker";

const REVIEWER_TOOLS = new Set([
  "chorus_list_tasks",
  "chorus_list_projects",
  "chorus_search",
  "chorus_checkin",
  "chorus_add_comment",
]);

const WORKER_TOOLS = new Set([
  "chorus_claim_task",
  "chorus_release_task",
  "chorus_update_task",
  "chorus_report_work",
  "chorus_report_criteria_self_check",
  "chorus_submit_for_verify",
  "chorus_session_checkin_task",
  "chorus_session_checkout_task",
]);

export function isRoleToolAllowed(role: ChorusRole, name: string): boolean {
  if (role !== "reviewer" && role !== "worker") return false;
  return /^chorus_get_[a-z][a-z0-9_]*$/.test(name) || REVIEWER_TOOLS.has(name) ||
    (role === "worker" && WORKER_TOOLS.has(name));
}
