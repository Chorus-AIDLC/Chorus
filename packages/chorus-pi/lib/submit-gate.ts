/**
 * submit-gate — optional pre-submit read-back checks (off by default).
 *
 * Two failures are guaranteed by the current API contract, and both are hard to
 * diagnose from the error alone:
 *
 *  1. `chorus_submit_for_verify` requires `in_progress`
 *     (src/mcp/tools/developer.ts: `if (task.status !== "in_progress")`), while
 *     `chorus_report_work` accepts `status: "to_verify"`. Reporting `to_verify`
 *     first therefore makes the submit fail with
 *     `Can only submit for verification from in_progress status`.
 *  2. `chorus_pm_validate_proposal` is documented as "call this before
 *     chorus_pm_submit_proposal", but `submitProposal` does not enforce it, so a
 *     proposal with a dangling dependency or a missing implementation task can be
 *     submitted as-is.
 *
 * This module only holds state + decisions; the extension decides whether to
 * block (`CHORUS_SUBMIT_GATE=block`) or just notify (`warn`). Default is `off`, so
 * enabling it is an explicit choice and no host changes behaviour silently.
 *
 * Nothing here reads or writes Chorus; it is a pure state machine so it can be
 * unit-tested without a session.
 */

export type GateMode = "off" | "warn" | "block";

export const SUBMIT_GATE_ENV = "CHORUS_SUBMIT_GATE";

/** Task tools. */
const TASK_SUBMIT = "chorus_submit_for_verify";
const TASK_READ = new Set(["chorus_get_task", "chorus_get_my_tasks", "chorus_list_tasks"]);
const TASK_MUTATE = new Set([
  "chorus_claim_task",
  "chorus_claim",
  "chorus_update_task",
  "chorus_release_task",
  "chorus_reopen_task",
]);

/** Proposal tools. */
const PROPOSAL_SUBMIT = "chorus_pm_submit_proposal";
const PROPOSAL_VALIDATE = "chorus_pm_validate_proposal";
const PROPOSAL_DRAFT_MUTATE = new Set([
  "chorus_pm_add_document_draft",
  "chorus_pm_update_document_draft",
  "chorus_pm_remove_document_draft",
  "chorus_pm_add_task_draft",
  "chorus_pm_update_task_draft",
  "chorus_pm_remove_task_draft",
]);

export interface SubmitGateState {
  seq: number;
  /** task uuid -> last state-changing call */
  taskMutation: Map<string, { at: number; tool: string; status?: string }>;
  /** task uuid -> seq of the last successful status read */
  taskRead: Map<string, number>;
  /** seq of the last successful task-list read (no uuid in the call) */
  taskListRead: number;
  /** proposal uuid -> last draft change */
  draftMutation: Map<string, number>;
  draftMutationAny: number;
  /** proposal uuid -> last successful validate */
  validateRead: Map<string, number>;
  validateReadAny: number;
}

export function newSubmitGateState(): SubmitGateState {
  return {
    seq: 0,
    taskMutation: new Map(),
    taskRead: new Map(),
    taskListRead: 0,
    draftMutation: new Map(),
    draftMutationAny: 0,
    validateRead: new Map(),
    validateReadAny: 0,
  };
}

/** `off` unless explicitly enabled; unknown values fall back to `off`. */
export function resolveGateMode(env: Record<string, string | undefined> = process.env): GateMode {
  const raw = (env[SUBMIT_GATE_ENV] || "").trim().toLowerCase();
  return raw === "warn" || raw === "block" ? raw : "off";
}

function uuidOf(args: unknown, key: string): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value.toLowerCase() : undefined;
}

function statusOf(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const value = (args as Record<string, unknown>).status;
  return typeof value === "string" ? value.toLowerCase() : undefined;
}

export interface GateVerdict {
  reason: string;
}

/**
 * Decide at call time. Mutating calls are recorded here (before execution), so a
 * failed mutation still invalidates an older read — conservative on purpose.
 */
export function evaluateGate(
  state: SubmitGateState,
  nativeTool: string,
  args: unknown,
): GateVerdict | undefined {
  state.seq += 1;
  const at = state.seq;

  if (nativeTool === TASK_SUBMIT) {
    const uuid = uuidOf(args, "taskUuid");
    if (!uuid) return undefined; // unknown shape: do not guess
    const mut = state.taskMutation.get(uuid);
    const fresh = (state.taskRead.get(uuid) ?? 0) > (mut?.at ?? 0) || state.taskListRead > (mut?.at ?? 0);
    if (fresh) return undefined;
    if (mut?.status === "to_verify") {
      return {
        reason:
          `task ${uuid} was reported with status "to_verify" and never read back. ` +
          `chorus_submit_for_verify is the in_progress -> to_verify transition, so this submit will be ` +
          `rejected with "Can only submit for verification from in_progress status". ` +
          `Read it first (chorus_get_task); if it already sits in to_verify, move it back with ` +
          `chorus_update_task({status: "in_progress"}) before submitting.`,
      };
    }
    return {
      reason:
        `task ${uuid} has no fresh status read before submit. Call chorus_get_task (or chorus_get_my_tasks) ` +
        `and confirm status is in_progress first; submitting from a stale assumption is what produces ` +
        `"Can only submit for verification from in_progress status".`,
    };
  }

  if (nativeTool === PROPOSAL_SUBMIT) {
    const uuid = uuidOf(args, "proposalUuid");
    const draftAt = uuid ? (state.draftMutation.get(uuid) ?? 0) : 0;
    const freshForAny = state.validateReadAny > state.draftMutationAny;
    const freshForUuid = !uuid || (state.validateRead.get(uuid) ?? 0) > draftAt;
    if (freshForAny && freshForUuid) return undefined;
    return {
      reason:
        `proposal ${uuid ?? "(unknown)"} has no validate receipt newer than its last draft change. ` +
        `Call chorus_pm_validate_proposal first: errors must be fixed, warnings fixed or justified, ` +
        `and any later draft edit invalidates the receipt and needs a re-validate.`,
    };
  }

  if (TASK_MUTATE.has(nativeTool)) {
    const uuid = uuidOf(args, "taskUuid");
    if (uuid) state.taskMutation.set(uuid, { at, tool: nativeTool, status: statusOf(args) });
    return undefined;
  }

  if (PROPOSAL_DRAFT_MUTATE.has(nativeTool)) {
    const uuid = uuidOf(args, "proposalUuid");
    state.draftMutationAny = at;
    if (uuid) state.draftMutation.set(uuid, at);
    return undefined;
  }

  return undefined;
}

/** Record successful reads at tool_result time. */
export function recordGateResult(
  state: SubmitGateState,
  nativeTool: string,
  args: unknown,
  isError: boolean,
): void {
  if (isError) return;
  if (TASK_READ.has(nativeTool)) {
    const uuid = uuidOf(args, "taskUuid");
    if (uuid) state.taskRead.set(uuid, state.seq);
    else state.taskListRead = state.seq;
    return;
  }
  if (nativeTool === PROPOSAL_VALIDATE) {
    const uuid = uuidOf(args, "proposalUuid");
    state.validateReadAny = state.seq;
    if (uuid) state.validateRead.set(uuid, state.seq);
  }
}
