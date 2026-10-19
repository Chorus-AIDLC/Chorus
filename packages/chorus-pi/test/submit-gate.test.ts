import { describe, expect, test } from "bun:test";
import {
  SUBMIT_GATE_ENV,
  evaluateGate,
  newSubmitGateState,
  recordGateResult,
  resolveGateMode,
} from "../lib/submit-gate.js";

const TASK = "516b3164-768a-4800-8bab-2f8017985a38";
const PROPOSAL = "6ea98a99-9c91-48ff-8c17-130efb300ced";

/** Record a successful read the way the extension's tool_result handler does. */
function read(state: ReturnType<typeof newSubmitGateState>, tool: string, args: object) {
  evaluateGate(state, tool, args); // reads are not gated, this only advances seq
  recordGateResult(state, tool, args, false);
}

describe("mode", () => {
  test("off unless explicitly warn or block", () => {
    expect(resolveGateMode({})).toBe("off");
    expect(resolveGateMode({ [SUBMIT_GATE_ENV]: "" })).toBe("off");
    expect(resolveGateMode({ [SUBMIT_GATE_ENV]: "0" })).toBe("off");
    expect(resolveGateMode({ [SUBMIT_GATE_ENV]: "yes" })).toBe("off");
    expect(resolveGateMode({ [SUBMIT_GATE_ENV]: "warn" })).toBe("warn");
    expect(resolveGateMode({ [SUBMIT_GATE_ENV]: "BLOCK" })).toBe("block");
  });
});

describe("task submit", () => {
  test("no read before submit is flagged", () => {
    const s = newSubmitGateState();
    const v = evaluateGate(s, "chorus_submit_for_verify", { taskUuid: TASK });
    expect(v?.reason).toContain("no fresh status read");
  });

  test("a successful read after the last mutation clears the gate", () => {
    const s = newSubmitGateState();
    evaluateGate(s, "chorus_claim_task", { taskUuid: TASK });
    read(s, "chorus_get_task", { taskUuid: TASK });
    expect(evaluateGate(s, "chorus_submit_for_verify", { taskUuid: TASK })).toBeUndefined();
  });

  test("a mutation after the read re-opens it", () => {
    const s = newSubmitGateState();
    read(s, "chorus_get_task", { taskUuid: TASK });
    evaluateGate(s, "chorus_update_task", { taskUuid: TASK, status: "in_progress" });
    expect(evaluateGate(s, "chorus_submit_for_verify", { taskUuid: TASK })?.reason).toContain(
      "no fresh status read",
    );
  });

  test("reporting to_verify first is called out specifically", () => {
    const s = newSubmitGateState();
    evaluateGate(s, "chorus_update_task", { taskUuid: TASK, status: "to_verify" });
    const v = evaluateGate(s, "chorus_submit_for_verify", { taskUuid: TASK });
    expect(v?.reason).toContain("reported with status");
    expect(v?.reason).toContain("in_progress");
  });

  test("a task-list read also counts, and a failed read does not", () => {
    const s = newSubmitGateState();
    evaluateGate(s, "chorus_update_task", { taskUuid: TASK, status: "in_progress" });
    evaluateGate(s, "chorus_get_my_tasks", {});
    recordGateResult(s, "chorus_get_my_tasks", {}, false);
    expect(evaluateGate(s, "chorus_submit_for_verify", { taskUuid: TASK })).toBeUndefined();

    const t = newSubmitGateState();
    evaluateGate(t, "chorus_update_task", { taskUuid: TASK, status: "in_progress" });
    evaluateGate(t, "chorus_get_task", { taskUuid: TASK });
    recordGateResult(t, "chorus_get_task", { taskUuid: TASK }, true); // failed read
    expect(evaluateGate(t, "chorus_submit_for_verify", { taskUuid: TASK })).toBeDefined();
  });

  test("unknown call shape is not guessed at", () => {
    const s = newSubmitGateState();
    expect(evaluateGate(s, "chorus_submit_for_verify", {})).toBeUndefined();
  });

  test("state is per task", () => {
    const s = newSubmitGateState();
    const other = "11111111-2222-3333-4444-555555555555";
    evaluateGate(s, "chorus_claim_task", { taskUuid: other });
    read(s, "chorus_get_task", { taskUuid: other });
    expect(evaluateGate(s, "chorus_submit_for_verify", { taskUuid: TASK })).toBeDefined();
  });
});

describe("proposal submit", () => {
  test("no validate before submit is flagged", () => {
    const s = newSubmitGateState();
    const v = evaluateGate(s, "chorus_pm_submit_proposal", { proposalUuid: PROPOSAL });
    expect(v?.reason).toContain("no validate receipt");
  });

  test("validate clears it", () => {
    const s = newSubmitGateState();
    evaluateGate(s, "chorus_pm_add_task_draft", { proposalUuid: PROPOSAL, title: "impl" });
    evaluateGate(s, "chorus_pm_validate_proposal", { proposalUuid: PROPOSAL });
    recordGateResult(s, "chorus_pm_validate_proposal", { proposalUuid: PROPOSAL }, false);
    expect(evaluateGate(s, "chorus_pm_submit_proposal", { proposalUuid: PROPOSAL })).toBeUndefined();
  });

  test("editing a draft after validate invalidates the receipt", () => {
    const s = newSubmitGateState();
    evaluateGate(s, "chorus_pm_validate_proposal", { proposalUuid: PROPOSAL });
    recordGateResult(s, "chorus_pm_validate_proposal", { proposalUuid: PROPOSAL }, false);
    evaluateGate(s, "chorus_pm_update_task_draft", { proposalUuid: PROPOSAL });
    expect(evaluateGate(s, "chorus_pm_submit_proposal", { proposalUuid: PROPOSAL })).toBeDefined();
  });

  test("a draft change without proposalUuid still invalidates globally", () => {
    const s = newSubmitGateState();
    evaluateGate(s, "chorus_pm_validate_proposal", { proposalUuid: PROPOSAL });
    recordGateResult(s, "chorus_pm_validate_proposal", { proposalUuid: PROPOSAL }, false);
    evaluateGate(s, "chorus_pm_update_task_draft", { draftUuid: "deadbeef-0000-0000-0000-000000000000" });
    expect(evaluateGate(s, "chorus_pm_submit_proposal", { proposalUuid: PROPOSAL })).toBeDefined();
  });

  test("a failed validate does not count as a receipt", () => {
    const s = newSubmitGateState();
    evaluateGate(s, "chorus_pm_validate_proposal", { proposalUuid: PROPOSAL });
    recordGateResult(s, "chorus_pm_validate_proposal", { proposalUuid: PROPOSAL }, true);
    expect(evaluateGate(s, "chorus_pm_submit_proposal", { proposalUuid: PROPOSAL })).toBeDefined();
  });

  test("the task and proposal tracks do not interfere", () => {
    const s = newSubmitGateState();
    read(s, "chorus_get_task", { taskUuid: TASK });
    expect(evaluateGate(s, "chorus_pm_submit_proposal", { proposalUuid: PROPOSAL })).toBeDefined();
  });
});
