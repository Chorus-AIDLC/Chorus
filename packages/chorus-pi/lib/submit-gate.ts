/**
 * submit-gate — optional pre-submit call-order gate (off by default).
 *
 * Scope, stated honestly after review: this is a **call-order reminder**, not a
 * validator. `submitProposal` already runs `validateProposal` and rejects
 * `valid=false`; what it cannot see is whether the agent read the object it is
 * about to submit. The gate only notices "you never looked, or your look predates
 * your last change", and — when the tool result is parseable — "the read itself
 * says the object is not in a submittable state".
 *
 * Contract notes that shaped the rules (verified against this repo):
 *  - `chorus_submit_for_verify` requires `in_progress`
 *    (`src/mcp/tools/developer.ts`), while `chorus_report_work` accepts
 *    `status: "to_verify"`. Reporting `to_verify` and then submitting is the
 *    original failure this gate exists for, so a *status-changing* report counts
 *    as a mutation; a progress-only report does not.
 *  - Moving a task from `to_verify` back to `in_progress` resets acceptance marks
 *    and evidence on both the developer and admin sides
 *    (`src/services/task.service.ts`), so recovery means redoing the Step 7
 *    self-check — the messages say that instead of "just resubmit".
 *  - `chorus_get_my_tasks` / `chorus_claim` / `chorus_reopen_task` do not exist in
 *    the tool catalog; only `chorus_get_task` proves anything about one task, and
 *    list reads credit nothing (a list from another project/page would otherwise
 *    unlock an unrelated task).
 *
 * Receipts are bound to the *request start* of the read, keyed by toolCallId, so
 * a read that started before a mutation cannot certify the state after it — even
 * if its result arrives later. Submitting consumes the receipt and advances the
 * object's mutation sequence, so a second submit needs a fresh read.
 */

export type GateMode = "off" | "warn" | "block";

export const SUBMIT_GATE_ENV = "CHORUS_SUBMIT_GATE";

/** Only an exact per-task read can certify one task. */
const TASK_READ = new Set(["chorus_get_task"]);
/** Transitions that move a task between statuses. */
const TASK_MUTATE = new Set([
  "chorus_claim_task",
  "chorus_update_task",
  "chorus_release_task",
  "chorus_admin_reopen_task",
  "chorus_admin_verify_task",
  "chorus_admin_close_task",
]);
const REPORT_WORK = "chorus_report_work";
const TASK_SUBMIT = "chorus_submit_for_verify";

const PROPOSAL_VALIDATE = "chorus_pm_validate_proposal";
const PROPOSAL_SUBMIT = "chorus_pm_submit_proposal";
const PROPOSAL_DRAFT_MUTATE = new Set([
  "chorus_pm_add_document_draft",
  "chorus_pm_update_document_draft",
  "chorus_pm_remove_document_draft",
  "chorus_pm_add_task_draft",
  "chorus_pm_update_task_draft",
  "chorus_pm_remove_task_draft",
]);

export interface TaskReceipt {
  /** request-start sequence of the read that produced it */
  seq: number;
  /** status reported by that read, when the payload was parseable */
  status?: string;
}

export interface ProposalReceipt {
  seq: number;
  /** `valid` reported by the validate call, when parseable */
  valid?: boolean;
  issues?: string[];
}

export interface PendingRead {
  kind: "task" | "proposal";
  uuid?: string;
  startSeq: number;
}

export interface SubmitGateState {
  seq: number;
  pendingReads: Map<string, PendingRead>;
  taskReceipts: Map<string, TaskReceipt>;
  proposalReceipts: Map<string, ProposalReceipt>;
  /** last status-changing call per task */
  taskMutation: Map<string, { at: number; tool: string; status?: string }>;
  /** last draft change or submit per proposal (when the proposal uuid is known) */
  proposalDraftMutation: Map<string, number>;
  /** last draft change or submit whose proposal could not be identified */
  anyDraftMutation: number;
}

export function newSubmitGateState(): SubmitGateState {
  return {
    seq: 0,
    pendingReads: new Map(),
    taskReceipts: new Map(),
    proposalReceipts: new Map(),
    taskMutation: new Map(),
    proposalDraftMutation: new Map(),
    anyDraftMutation: 0,
  };
}

/** `off` unless explicitly enabled; unknown values fall back to `off`. */
export function resolveGateMode(env: Record<string, string | undefined> = process.env): GateMode {
  const raw = (env[SUBMIT_GATE_ENV] || "").trim().toLowerCase();
  return raw === "warn" || raw === "block" ? raw : "off";
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function uuidOf(args: unknown, key: "taskUuid" | "proposalUuid"): string | undefined {
  const value = asObject(args)?.[key];
  if (typeof value !== "string") return undefined;
  const m = value.match(UUID_RE);
  return m ? m[0].toLowerCase() : undefined;
}

function statusOf(args: unknown): string | undefined {
  const value = asObject(args)?.status;
  return typeof value === "string" ? value.toLowerCase() : undefined;
}

/** Tolerant JSON extraction from a tool result's text blocks. */
export function parseJsonPayload(text: string): Record<string, unknown> | undefined {
  if (!text) return undefined;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return asObject(JSON.parse(text.slice(start, end + 1)));
  } catch {
    return undefined;
  }
}

export interface GateVerdict {
  reason: string;
}

const RECOVERY_NOTE =
  "恢复时注意：把任务从 to_verify 改回 in_progress 会清空开发侧与管理侧的验收标记和证据" +
  "（task.service.updateTask），所以要重做 Step 7 自检并恢复证据，再走提交。";

/**
 * Decide at call time. Reads are only registered (their receipt is stamped when
 * the result arrives, using the request-start sequence). Mutations are recorded
 * here, before execution, so a failed mutation still invalidates older receipts.
 */
export function evaluateGate(
  state: SubmitGateState,
  nativeTool: string,
  args: unknown,
  toolCallId?: string,
): GateVerdict | undefined {
  state.seq += 1;
  const at = state.seq;

  if (TASK_READ.has(nativeTool)) {
    const uuid = uuidOf(args, "taskUuid");
    if (toolCallId) state.pendingReads.set(toolCallId, { kind: "task", uuid, startSeq: at });
    return undefined;
  }

  if (nativeTool === PROPOSAL_VALIDATE) {
    const uuid = uuidOf(args, "proposalUuid");
    if (toolCallId) state.pendingReads.set(toolCallId, { kind: "proposal", uuid, startSeq: at });
    return undefined;
  }

  if (nativeTool === TASK_SUBMIT) {
    const uuid = uuidOf(args, "taskUuid");
    if (!uuid) return undefined;
    const mutation = state.taskMutation.get(uuid);
    const receipt = state.taskReceipts.get(uuid);
    let verdict: GateVerdict | undefined;
    if (!receipt || receipt.seq <= (mutation?.at ?? 0)) {
      if (mutation?.status === "to_verify" || receipt?.status === "to_verify") {
        verdict = {
          reason:
            `task ${uuid} was reported with status "to_verify" and never read back afterwards. ` +
            `chorus_submit_for_verify is the in_progress -> to_verify transition, so this submit will be ` +
            `rejected with "Can only submit for verification from in_progress status". ` +
            `Read it with chorus_get_task first; if it already sits in to_verify, move it back with ` +
            `chorus_update_task({status: "in_progress"}) before submitting. ${RECOVERY_NOTE}`,
        };
      } else {
        verdict = {
          reason:
            `task ${uuid} has no fresh status read before submit. Call chorus_get_task and confirm ` +
            `status is in_progress first; submitting from a stale assumption is what produces ` +
            `"Can only submit for verification from in_progress status".`,
        };
      }
    } else if (receipt.status && receipt.status !== "in_progress") {
      verdict = {
        reason:
          `chorus_get_task reported status "${receipt.status}" for task ${uuid}; submit requires ` +
          `in_progress. Move it back with chorus_update_task({status: "in_progress"}) if that is the ` +
          `intent. ${RECOVERY_NOTE}`,
      };
    }
    state.taskReceipts.delete(uuid); // a submit consumes the receipt
    state.taskMutation.set(uuid, { at, tool: nativeTool });
    return verdict;
  }

  if (nativeTool === PROPOSAL_SUBMIT) {
    const uuid = uuidOf(args, "proposalUuid");
    const receipt = uuid
      ? state.proposalReceipts.get(uuid)
      : [...state.proposalReceipts.values()].sort((a, b) => b.seq - a.seq)[0];
    const draftAt = uuid ? (state.proposalDraftMutation.get(uuid) ?? 0) : 0;
    let verdict: GateVerdict | undefined;
    if (!receipt) {
      verdict = {
        reason:
          `proposal ${uuid ?? "(unknown)"} has no chorus_pm_validate_proposal receipt. ` +
          `Call validate first: errors block submission, warnings need a disposition, and any later ` +
          `draft edit invalidates the receipt.`,
      };
    } else if (receipt.seq <= draftAt || receipt.seq <= state.anyDraftMutation) {
      verdict = {
        reason:
          `proposal ${uuid ?? "(unknown)"} was edited after its last validate receipt; ` +
          `re-run chorus_pm_validate_proposal before submitting.`,
      };
    } else if (receipt.valid === false) {
      const detail = (receipt.issues ?? []).slice(0, 3).join("; ");
      verdict = {
        reason:
          `the last chorus_pm_validate_proposal reported valid:false` +
          (detail ? ` (${detail})` : "") +
          `; fix the issues and re-validate before submitting.`,
      };
    }
    if (uuid) {
      state.proposalReceipts.delete(uuid);
      state.proposalDraftMutation.set(uuid, at);
    } else {
      state.proposalReceipts.clear();
      state.anyDraftMutation = at;
    }
    return verdict;
  }

  if (TASK_MUTATE.has(nativeTool)) {
    const uuid = uuidOf(args, "taskUuid");
    if (uuid) state.taskMutation.set(uuid, { at, tool: nativeTool, status: statusOf(args) });
    return undefined;
  }

  if (nativeTool === REPORT_WORK) {
    // Only a report that asks for a status change moves the task; a progress
    // report is not a mutation and must not invalidate a fresh read.
    const uuid = uuidOf(args, "taskUuid");
    const status = statusOf(args);
    if (uuid && status) state.taskMutation.set(uuid, { at, tool: nativeTool, status });
    return undefined;
  }

  if (PROPOSAL_DRAFT_MUTATE.has(nativeTool)) {
    const uuid = uuidOf(args, "proposalUuid");
    if (uuid) state.proposalDraftMutation.set(uuid, at);
    else state.anyDraftMutation = at;
    return undefined;
  }

  return undefined;
}

/**
 * Record a read receipt at tool_result time. The receipt carries the sequence the
 * read *started* at, and is dropped when a mutation on the same object happened
 * after that start — the result may describe the pre-mutation state.
 */
export function recordGateResult(
  state: SubmitGateState,
  nativeTool: string,
  args: unknown,
  isError: boolean,
  toolCallId: string | undefined,
  contentText: string,
): void {
  if (!toolCallId) return;
  const pending = state.pendingReads.get(toolCallId);
  if (!pending) return;
  state.pendingReads.delete(toolCallId);
  if (isError) return;

  if (pending.kind === "task") {
    if (!pending.uuid) return;
    const mutation = state.taskMutation.get(pending.uuid);
    if (pending.startSeq <= (mutation?.at ?? 0)) return; // spanned a mutation
    const payload = parseJsonPayload(contentText);
    const status = typeof payload?.status === "string" ? payload.status.toLowerCase() : undefined;
    state.taskReceipts.set(pending.uuid, { seq: pending.startSeq, status });
    return;
  }

  const draftAt = pending.uuid ? (state.proposalDraftMutation.get(pending.uuid) ?? 0) : 0;
  if (pending.startSeq <= draftAt || pending.startSeq <= state.anyDraftMutation) return;
  const payload = parseJsonPayload(contentText);
  const valid = typeof payload?.valid === "boolean" ? payload.valid : undefined;
  const rawIssues = Array.isArray(payload?.issues) ? payload.issues : [];
  const issues = rawIssues
    .slice(0, 3)
    .map((issue) => {
      const obj = asObject(issue);
      if (!obj) return "";
      const level = typeof obj.level === "string" ? obj.level : "";
      const message = typeof obj.message === "string" ? obj.message : "";
      return [level, message].filter(Boolean).join(": ");
    })
    .filter(Boolean);
  const receipt: ProposalReceipt = { seq: pending.startSeq, valid, issues };
  if (pending.uuid) state.proposalReceipts.set(pending.uuid, receipt);
  else state.proposalReceipts.set(`__any__:${pending.startSeq}`, receipt);
}
