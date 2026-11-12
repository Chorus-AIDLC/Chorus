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

for (const scenario of [
  { kind: "task", read: "chorus_get_task", submit: "chorus_submit_for_verify", key: "taskUuid", uuid: TASK, other: TASK_B, before: { status: "in_progress" }, after: { status: "to_verify" } },
  { kind: "proposal", read: "chorus_pm_validate_proposal", submit: "chorus_pm_submit_proposal", key: "proposalUuid", uuid: PROPOSAL, other: PROPOSAL_B, before: { valid: true }, after: { status: "pending" } },
]) {
  test(`${scenario.kind}: a delayed pre-submit read cannot restore the consumed receipt`, () => {
    const s = newSubmitGateState();
    const args = { [scenario.key]: scenario.uuid };
    const otherArgs = { [scenario.key]: scenario.other };
    const result = JSON.stringify(scenario.before);
    const first = nextId();
    evaluateGate(s, scenario.read, args, first);
    recordGateResult(s, scenario.read, args, false, first, result);

    const delayed = nextId();
    const other = nextId();
    evaluateGate(s, scenario.read, args, delayed);
    evaluateGate(s, scenario.read, otherArgs, other);
    const submit = nextId();
    expect(evaluateGate(s, scenario.submit, args, submit)).toBeUndefined();
    recordGateResult(s, scenario.submit, args, false, submit, JSON.stringify(scenario.after));
    recordGateResult(s, scenario.read, args, false, delayed, result);
    expect(evaluateGate(s, scenario.submit, args)).toBeDefined();

    // Submitting A must leave an in-flight read for B usable.
    recordGateResult(s, scenario.read, otherArgs, false, other, result);
    expect(evaluateGate(s, scenario.submit, otherArgs)).toBeUndefined();

    // A new read after the submit can certify the object again.
    const fresh = nextId();
    evaluateGate(s, scenario.read, args, fresh);
    recordGateResult(s, scenario.read, args, false, fresh, result);
    expect(evaluateGate(s, scenario.submit, args)).toBeUndefined();
  });
}

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

describe("submit-attempt invalidation", () => {
  for (const scenario of [
    { kind: "task", read: "chorus_get_task", submit: "chorus_submit_for_verify", mutate: "chorus_update_task", key: "taskUuid", uuid: TASK, other: TASK_B, good: { status: "in_progress" }, bad: { status: "done" }, missing: "no fresh status read", stale: "no fresh status read", invalid: 'reported status "done"' },
    { kind: "proposal", read: "chorus_pm_validate_proposal", submit: "chorus_pm_submit_proposal", mutate: "chorus_pm_update_task_draft", key: "proposalUuid", uuid: PROPOSAL, other: PROPOSAL_B, good: { valid: true }, bad: { valid: false }, missing: "no chorus_pm_validate_proposal receipt", stale: "edited after its last validate", invalid: "valid:false" },
  ]) {
    for (const receiptState of ["missing", "stale", "invalid", "valid"] as const) {
      test(`${scenario.kind}: ${receiptState} receipt cannot be revived after a submit attempt`, () => {
        const state = newSubmitGateState();
        const args = { [scenario.key]: scenario.uuid };
        const otherArgs = { [scenario.key]: scenario.other };
        const goodResult = JSON.stringify(scenario.good);
        if (receiptState !== "missing") {
          const initial = nextId();
          evaluateGate(state, scenario.read, args, initial);
          recordGateResult(state, scenario.read, args, false, initial,
            JSON.stringify(receiptState === "invalid" ? scenario.bad : scenario.good));
        }
        if (receiptState === "missing" || receiptState === "stale") {
          evaluateGate(state, scenario.mutate, { ...args, status: "in_progress" });
        }
        const delayed = nextId();
        const other = nextId();
        evaluateGate(state, scenario.read, args, delayed);
        evaluateGate(state, scenario.read, otherArgs, other);

        const verdict = evaluateGate(state, scenario.submit, args);
        const submitSeq = state.seq;
        if (receiptState === "valid") expect(verdict).toBeUndefined();
        else expect(verdict?.reason).toContain(scenario[receiptState]);

        recordGateResult(state, scenario.read, args, false, delayed, goodResult);
        expect(evaluateGate(state, scenario.submit, args)).toBeDefined();
        const receipts = scenario.kind === "task" ? state.taskReceipts : state.proposalReceipts;
        expect(receipts.has(scenario.uuid)).toBe(false);
        const mutationSeq = scenario.kind === "task"
          ? state.taskMutation.get(scenario.uuid)?.at
          : state.proposalDraftMutation.get(scenario.uuid);
        expect(mutationSeq).toBe(state.seq);
        expect(mutationSeq).toBeGreaterThan(submitSeq);

        recordGateResult(state, scenario.read, otherArgs, false, other, goodResult);
        expect(evaluateGate(state, scenario.submit, otherArgs)).toBeUndefined();
        const fresh = nextId();
        evaluateGate(state, scenario.read, args, fresh);
        recordGateResult(state, scenario.read, args, false, fresh, goodResult);
        expect(evaluateGate(state, scenario.submit, args)).toBeUndefined();
        expect(evaluateGate(state, scenario.submit, args)).toBeDefined();
      });
    }
  }

  for (const receiptState of ["missing", "stale", "invalid", "valid"] as const) {
    test(`proposal without UUID: ${receiptState} receipt still invalidates globally`, () => {
      const state = newSubmitGateState();
      if (receiptState !== "missing") {
        readProposal(state, PROPOSAL, { valid: true });
        readProposal(state, PROPOSAL_B, { valid: receiptState !== "invalid" });
      }
      if (receiptState === "stale") evaluateGate(state, "chorus_pm_update_task_draft", {});
      readTask(state, TASK);
      const pending = [{ proposalUuid: PROPOSAL }, { proposalUuid: PROPOSAL_B }, {}].map((args) => {
        const callId = nextId();
        evaluateGate(state, "chorus_pm_validate_proposal", args, callId);
        return { args, callId };
      });

      const verdict = evaluateGate(state, "chorus_pm_submit_proposal", {});
      if (receiptState === "valid") expect(verdict).toBeUndefined();
      else expect(verdict?.reason).toContain({
        missing: "no chorus_pm_validate_proposal receipt",
        stale: "edited after its last validate",
        invalid: "valid:false",
      }[receiptState]);
      expect(state.proposalReceipts.size).toBe(0);
      expect(state.anyDraftMutation).toBe(state.seq);
      for (const { args, callId } of pending) {
        recordGateResult(state, "chorus_pm_validate_proposal", args, false, callId, '{"valid":true}');
      }
      expect(state.proposalReceipts.size).toBe(0);
      expect(evaluateGate(state, "chorus_pm_submit_proposal", { proposalUuid: PROPOSAL })).toBeDefined();
      expect(evaluateGate(state, "chorus_pm_submit_proposal", { proposalUuid: PROPOSAL_B })).toBeDefined();
      expect(evaluateGate(state, "chorus_pm_submit_proposal", {})).toBeDefined();
      expect(evaluateGate(state, "chorus_submit_for_verify", { taskUuid: TASK })).toBeUndefined();

      readProposal(state, PROPOSAL, { valid: true });
      expect(evaluateGate(state, "chorus_pm_submit_proposal", {})).toBeUndefined();
      expect(evaluateGate(state, "chorus_pm_submit_proposal", {})).toBeDefined();
    });
  }
});

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
