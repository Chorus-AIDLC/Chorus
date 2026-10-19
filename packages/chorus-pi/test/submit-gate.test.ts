import { describe, expect, test } from "bun:test";
import {
  SUBMIT_GATE_ENV,
  evaluateGate,
  newSubmitGateState,
  parseJsonPayload,
  recordGateResult,
  resolveGateMode,
  type SubmitGateState,
} from "../lib/submit-gate.js";

const TASK = "b495ba86-8307-4d29-83da-76c674f8ec47";
const TASK_B = "54df0eaf-0b19-4995-b731-7bb9ed8451db";
const PROPOSAL = "6ea98a99-9c91-48ff-8c17-130efb300ced";
const PROPOSAL_B = "1fbaca69-97da-48ca-963f-3faf48ef704f";

let idSeq = 0;
const nextId = () => `tc-${++idSeq}`;

/** Drive one successful read of a task and return its receipt in place. */
function readTask(state: SubmitGateState, taskUuid: string, status = "in_progress"): void {
  const id = nextId();
  evaluateGate(state, "chorus_get_task", { taskUuid }, id);
  recordGateResult(state, "chorus_get_task", { taskUuid }, false, id, JSON.stringify({ status }));
}

function readProposal(state: SubmitGateState, proposalUuid: string, payload: object): void {
  const id = nextId();
  evaluateGate(state, "chorus_pm_validate_proposal", { proposalUuid }, id);
  recordGateResult(state, "chorus_pm_validate_proposal", { proposalUuid }, false, id, JSON.stringify(payload));
}

describe("mode", () => {
  test("off unless explicitly warn or block", () => {
    expect(resolveGateMode({})).toBe("off");
    expect(resolveGateMode({ [SUBMIT_GATE_ENV]: "0" })).toBe("off");
    expect(resolveGateMode({ [SUBMIT_GATE_ENV]: "yes" })).toBe("off");
    expect(resolveGateMode({ [SUBMIT_GATE_ENV]: "warn" })).toBe("warn");
    expect(resolveGateMode({ [SUBMIT_GATE_ENV]: "BLOCK" })).toBe("block");
  });
});

describe("task submit", () => {
  test("no read before submit is flagged", () => {
    const s = newSubmitGateState();
    expect(evaluateGate(s, "chorus_submit_for_verify", { taskUuid: TASK })?.reason).toContain(
      "no fresh status read",
    );
  });

  // Review case 1: the original failure is report_work(status=to_verify) → submit.
  test("a status-changing report_work invalidates the read receipt", () => {
    const s = newSubmitGateState();
    readTask(s, TASK);
    evaluateGate(s, "chorus_report_work", { taskUuid: TASK, report: "done", status: "to_verify" });
    const verdict = evaluateGate(s, "chorus_submit_for_verify", { taskUuid: TASK });
    expect(verdict?.reason).toContain("to_verify");
    expect(verdict?.reason).toContain("in_progress");
  });

  test("a progress-only report_work does not invalidate the receipt", () => {
    const s = newSubmitGateState();
    readTask(s, TASK);
    evaluateGate(s, "chorus_report_work", { taskUuid: TASK, report: "half way" });
    expect(evaluateGate(s, "chorus_submit_for_verify", { taskUuid: TASK })).toBeUndefined();
  });

  test("re-reading after the report clears it", () => {
    const s = newSubmitGateState();
    readTask(s, TASK);
    evaluateGate(s, "chorus_report_work", { taskUuid: TASK, status: "in_progress" });
    readTask(s, TASK);
    expect(evaluateGate(s, "chorus_submit_for_verify", { taskUuid: TASK })).toBeUndefined();
  });

  // Review case 2: a list read must not certify an unrelated task.
  test("list-style reads never unlock a task", () => {
    for (const tool of ["chorus_list_tasks", "chorus_get_available_tasks", "chorus_get_unblocked_tasks"]) {
      const s = newSubmitGateState();
      const id = nextId();
      evaluateGate(s, tool, { status: "in_progress" }, id);
      recordGateResult(s, tool, {}, false, id, JSON.stringify({ tasks: [{ uuid: TASK }] }));
      expect(evaluateGate(s, "chorus_submit_for_verify", { taskUuid: TASK })?.reason).toContain(
        "no fresh status read",
      );
    }
  });

  // Review case 3 (task side): a read that says to_verify blocks on its own.
  test("a read reporting to_verify blocks the submit with the status message", () => {
    const s = newSubmitGateState();
    readTask(s, TASK, "to_verify");
    const verdict = evaluateGate(s, "chorus_submit_for_verify", { taskUuid: TASK });
    expect(verdict?.reason).toContain('reported status "to_verify"');
  });

  // Review case 4: a read that started before a mutation cannot certify after it.
  test("a read spanning a mutation is discarded even if the result arrives later", () => {
    const s = newSubmitGateState();
    const id = nextId();
    evaluateGate(s, "chorus_get_task", { taskUuid: TASK }, id); // read starts
    evaluateGate(s, "chorus_update_task", { taskUuid: TASK, status: "in_progress" }); // mutation
    recordGateResult(s, "chorus_get_task", { taskUuid: TASK }, false, id, JSON.stringify({ status: "in_progress" }));
    expect(evaluateGate(s, "chorus_submit_for_verify", { taskUuid: TASK })?.reason).toContain(
      "no fresh status read",
    );
  });

  // Review case 5: submitting consumes the receipt.
  test("a second submit needs a fresh read", () => {
    const s = newSubmitGateState();
    readTask(s, TASK);
    expect(evaluateGate(s, "chorus_submit_for_verify", { taskUuid: TASK })).toBeUndefined();
    expect(evaluateGate(s, "chorus_submit_for_verify", { taskUuid: TASK })?.reason).toContain(
      "no fresh status read",
    );
  });

  test("a failed read records nothing", () => {
    const s = newSubmitGateState();
    const id = nextId();
    evaluateGate(s, "chorus_get_task", { taskUuid: TASK }, id);
    recordGateResult(s, "chorus_get_task", { taskUuid: TASK }, true, id, "boom");
    expect(evaluateGate(s, "chorus_submit_for_verify", { taskUuid: TASK })).toBeDefined();
  });

  test("unknown call shape is not judged", () => {
    const s = newSubmitGateState();
    expect(evaluateGate(s, "chorus_submit_for_verify", {})).toBeUndefined();
  });

  test("receipts are per task", () => {
    const s = newSubmitGateState();
    readTask(s, TASK_B);
    expect(evaluateGate(s, "chorus_submit_for_verify", { taskUuid: TASK })).toBeDefined();
  });
});

describe("proposal submit", () => {
  test("no validate receipt is flagged", () => {
    const s = newSubmitGateState();
    expect(evaluateGate(s, "chorus_pm_submit_proposal", { proposalUuid: PROPOSAL })?.reason).toContain(
      "no chorus_pm_validate_proposal receipt",
    );
  });

  test("validate clears it and submit consumes it", () => {
    const s = newSubmitGateState();
    readProposal(s, PROPOSAL, { valid: true, issues: [] });
    expect(evaluateGate(s, "chorus_pm_submit_proposal", { proposalUuid: PROPOSAL })).toBeUndefined();
    expect(evaluateGate(s, "chorus_pm_submit_proposal", { proposalUuid: PROPOSAL })).toBeDefined();
  });

  // Review case 6: editing a *different* proposal must not invalidate A's receipt.
  test("a draft edit in another proposal leaves this receipt valid", () => {
    const s = newSubmitGateState();
    readProposal(s, PROPOSAL, { valid: true, issues: [] });
    evaluateGate(s, "chorus_pm_update_task_draft", { proposalUuid: PROPOSAL_B, draftUuid: "d-1" });
    expect(evaluateGate(s, "chorus_pm_submit_proposal", { proposalUuid: PROPOSAL })).toBeUndefined();
  });

  test("editing this proposal invalidates its receipt", () => {
    const s = newSubmitGateState();
    readProposal(s, PROPOSAL, { valid: true, issues: [] });
    evaluateGate(s, "chorus_pm_update_task_draft", { proposalUuid: PROPOSAL });
    expect(evaluateGate(s, "chorus_pm_submit_proposal", { proposalUuid: PROPOSAL })?.reason).toContain(
      "edited after its last validate",
    );
  });

  test("an unattributable draft edit still invalidates (conservative fallback)", () => {
    const s = newSubmitGateState();
    readProposal(s, PROPOSAL, { valid: true, issues: [] });
    evaluateGate(s, "chorus_pm_update_task_draft", { draftUuid: "deadbeef-0000-0000-0000-000000000000" });
    expect(evaluateGate(s, "chorus_pm_submit_proposal", { proposalUuid: PROPOSAL })).toBeDefined();
  });

  // Review case 7: valid:false must not unlock submission.
  test("a validate that reported valid:false blocks, listing issues", () => {
    const s = newSubmitGateState();
    readProposal(s, PROPOSAL, {
      valid: false,
      issues: [{ level: "error", message: "E2: no implementation task" }],
    });
    const verdict = evaluateGate(s, "chorus_pm_submit_proposal", { proposalUuid: PROPOSAL });
    expect(verdict?.reason).toContain("valid:false");
    expect(verdict?.reason).toContain("E2: no implementation task");
  });

  test("the task and proposal tracks do not interfere", () => {
    const s = newSubmitGateState();
    readTask(s, TASK);
    expect(evaluateGate(s, "chorus_pm_submit_proposal", { proposalUuid: PROPOSAL })).toBeDefined();
  });
});

describe("payload parsing", () => {
  test("tolerates prose around the JSON and malformed input", () => {
    expect(parseJsonPayload('prefix {"status":"to_verify"} suffix')?.status).toBe("to_verify");
    expect(parseJsonPayload("no json here")).toBeUndefined();
    expect(parseJsonPayload("{broken")).toBeUndefined();
  });
});
