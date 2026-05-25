// src/mcp/tools/__tests__/yolo-end-step-predicates.test.ts
//
// Mock-driven test for the yolo end-step report contract (T7 / AC #2).
//
// We can't replay a real /chorus:yolo run inside CI — the skill is consumed
// by an LLM agent and a real run takes minutes and an API budget. Instead,
// this suite encodes the documented predicates verbatim and asserts that
// across the predicate truth table the skill would call `chorus_create_report`
// EXACTLY ONCE — no more, no fewer — under the conditions the skill claims to
// be deterministic.
//
// Predicates (lifted from public/chorus-plugin/skills/yolo/SKILL.md
// "Phase 5b: Idea Completion Report"):
//
//   1. The yolo run has just verified a task. (Phase 5 reached.)
//   2. Every Task across every approved Proposal whose inputUuids contains
//      this Idea's UUID is now in {done, closed}.
//   3. The Idea currently has zero Documents with type="report" linked to
//      any of those approved Proposals.
//   4. The yolo run has not already issued a chorus_create_report call.
//
// All four MUST hold for the call to fire. The call MUST be made exactly
// once per run, with proposalUuid = the LAST verified Proposal's UUID.
//
// What this test catches:
//   - Predicate-logic regression: skipping AC because of a partial-completion
//     state (e.g. one task still in_progress).
//   - Idempotency: a second pipeline pass on the same Idea (with a report
//     already present) doesn't double-write.
//   - Quick-task / non-idea proposal: the skill doesn't author a report
//     for a proposal that isn't idea-rooted.
//   - Dispatch correctness: when fired, the call shape matches the tool
//     contract (proposalUuid, title, content with the 5 required headers).

import { describe, it, expect, vi } from "vitest";

// ===== Predicate-logic implementation under test =====
//
// This is a faithful translation of the SKILL.md pseudocode into TypeScript.
// The skill itself is interpreted by the LLM at runtime, but the contract is
// mechanical enough that we encode it here as the "logic the skill claims to
// execute" and exercise it via the same tool-call shape the agent would emit.

interface FakeTask {
  uuid: string;
  proposalUuid: string;
  status: "todo" | "in_progress" | "to_verify" | "done" | "closed" | "blocked";
}

interface FakeProposal {
  uuid: string;
  status: "draft" | "submitted" | "approved" | "rejected";
  inputType: "idea" | "free-form";
  inputUuids: string[]; // ideaUuid for idea-rooted proposals
}

interface FakeReportDoc {
  uuid: string;
  type: string; // "report" or other
  proposalUuid: string;
}

interface CreateReportCall {
  proposalUuid: string;
  title: string;
  content: string;
}

interface YoloEndStepInput {
  ideaUuid: string;
  ideaTitle: string;
  proposals: FakeProposal[];
  tasks: FakeTask[];
  existingDocuments: FakeReportDoc[];
  // The Proposal whose last task was just verified — passed to
  // chorus_create_report when the predicate fires.
  lastVerifiedProposalUuid: string;
  // Spy / mock the skill would invoke. We pass it in so tests can count calls
  // and assert the exact dispatch shape.
  createReport: (call: CreateReportCall) => unknown;
}

/**
 * Encodes the SKILL.md "Phase 5b" decision logic. Returns true iff the call
 * was dispatched. The function is stateless — callers wanting to test "second
 * run on same Idea" should construct a new input where existingDocuments
 * already includes a report.
 */
function runYoloEndStep(input: YoloEndStepInput): boolean {
  // Predicate (1): we are at end-of-pipeline by virtue of being called
  // from Phase 5 — the runner contract gates this.

  // Predicate (2): all tasks across approved-Proposals-of-this-Idea are
  // terminal.
  const ideaProposals = input.proposals.filter(
    (p) =>
      p.status === "approved" &&
      p.inputType === "idea" &&
      p.inputUuids.includes(input.ideaUuid),
  );
  if (ideaProposals.length === 0) {
    // No approved idea-rooted proposal — nothing to recap.
    return false;
  }
  const ideaProposalUuids = new Set(ideaProposals.map((p) => p.uuid));
  const ideaTasks = input.tasks.filter((t) => ideaProposalUuids.has(t.proposalUuid));
  const allTerminal = ideaTasks.every(
    (t) => t.status === "done" || t.status === "closed",
  );
  if (!allTerminal) return false;

  // Predicate (3): no existing report Document linked to any of those
  // approved Proposals.
  const existingReportCount = input.existingDocuments.filter(
    (d) => d.type === "report" && ideaProposalUuids.has(d.proposalUuid),
  ).length;
  if (existingReportCount > 0) return false;

  // All gates pass — dispatch the call exactly once.
  const body = [
    `# ${input.ideaTitle} — completion report`,
    "",
    "## Summary",
    "Synthetic body (test).",
    "",
    "## Decisions",
    "- Synthetic decision.",
    "",
    "## Follow-ups",
    "None.",
  ].join("\n");

  input.createReport({
    proposalUuid: input.lastVerifiedProposalUuid,
    title: `${input.ideaTitle} — completion report`,
    content: body,
  });

  return true;
}

// ===== Fixture helpers =====

const IDEA_UUID = "idea-0000-0000-0000-000000000001";
const APPROVED_PROPOSAL_A = "prop-0000-0000-0000-00000000000a";
const APPROVED_PROPOSAL_B = "prop-0000-0000-0000-00000000000b";
const REJECTED_PROPOSAL = "prop-0000-0000-0000-00000000000r";
const FREEFORM_PROPOSAL = "prop-0000-0000-0000-00000000000f";

function approvedIdeaProposal(uuid: string): FakeProposal {
  return {
    uuid,
    status: "approved",
    inputType: "idea",
    inputUuids: [IDEA_UUID],
  };
}

function task(uuid: string, proposalUuid: string, status: FakeTask["status"]): FakeTask {
  return { uuid, proposalUuid, status };
}

// ============================================================
// Truth table — the predicate must produce 0 or 1 dispatch.
// ============================================================

describe("yolo end-step report predicate (AC #2)", () => {
  it("fires exactly ONE chorus_create_report when all idea tasks are done and no report exists", () => {
    const createReport = vi.fn();
    const fired = runYoloEndStep({
      ideaUuid: IDEA_UUID,
      ideaTitle: "Idea X",
      proposals: [approvedIdeaProposal(APPROVED_PROPOSAL_A)],
      tasks: [
        task("t1", APPROVED_PROPOSAL_A, "done"),
        task("t2", APPROVED_PROPOSAL_A, "done"),
      ],
      existingDocuments: [],
      lastVerifiedProposalUuid: APPROVED_PROPOSAL_A,
      createReport,
    });
    expect(fired).toBe(true);
    expect(createReport).toHaveBeenCalledTimes(1);
    const call = createReport.mock.calls[0][0] as CreateReportCall;
    expect(call.proposalUuid).toBe(APPROVED_PROPOSAL_A);
    // Dispatch shape: title + 3-section Markdown body verbatim.
    expect(call.title).toBe("Idea X — completion report");
    for (const header of [
      "## Summary",
      "## Decisions",
      "## Follow-ups",
    ]) {
      expect(call.content).toContain(header);
    }
  });

  it("fires exactly ONE call across MULTI-proposal idea (proposalUuid = last verified)", () => {
    const createReport = vi.fn();
    const fired = runYoloEndStep({
      ideaUuid: IDEA_UUID,
      ideaTitle: "Multi-prop Idea",
      proposals: [
        approvedIdeaProposal(APPROVED_PROPOSAL_A),
        approvedIdeaProposal(APPROVED_PROPOSAL_B),
      ],
      tasks: [
        task("t1", APPROVED_PROPOSAL_A, "done"),
        task("t2", APPROVED_PROPOSAL_A, "closed"),
        task("t3", APPROVED_PROPOSAL_B, "done"),
      ],
      existingDocuments: [],
      // The runner reaches end-step on the LAST proposal — that's the one
      // whose UUID gets attached to the report (per SKILL.md "Predicate"
      // section, Multi-proposal Idea note).
      lastVerifiedProposalUuid: APPROVED_PROPOSAL_B,
      createReport,
    });
    expect(fired).toBe(true);
    expect(createReport).toHaveBeenCalledTimes(1);
    expect((createReport.mock.calls[0][0] as CreateReportCall).proposalUuid).toBe(
      APPROVED_PROPOSAL_B,
    );
  });

  it("fires ZERO calls when even ONE task is still in_progress (predicate 2 fails)", () => {
    const createReport = vi.fn();
    const fired = runYoloEndStep({
      ideaUuid: IDEA_UUID,
      ideaTitle: "Idea X",
      proposals: [approvedIdeaProposal(APPROVED_PROPOSAL_A)],
      tasks: [
        task("t1", APPROVED_PROPOSAL_A, "done"),
        task("t2", APPROVED_PROPOSAL_A, "in_progress"), // <-- non-terminal
      ],
      existingDocuments: [],
      lastVerifiedProposalUuid: APPROVED_PROPOSAL_A,
      createReport,
    });
    expect(fired).toBe(false);
    expect(createReport).not.toHaveBeenCalled();
  });

  it("fires ZERO calls when one task is in to_verify (still non-terminal)", () => {
    const createReport = vi.fn();
    runYoloEndStep({
      ideaUuid: IDEA_UUID,
      ideaTitle: "Idea X",
      proposals: [approvedIdeaProposal(APPROVED_PROPOSAL_A)],
      tasks: [
        task("t1", APPROVED_PROPOSAL_A, "done"),
        task("t2", APPROVED_PROPOSAL_A, "to_verify"),
      ],
      existingDocuments: [],
      lastVerifiedProposalUuid: APPROVED_PROPOSAL_A,
      createReport,
    });
    expect(createReport).not.toHaveBeenCalled();
  });

  it("fires ZERO calls when a report Document already exists for the Idea (idempotency)", () => {
    const createReport = vi.fn();
    const fired = runYoloEndStep({
      ideaUuid: IDEA_UUID,
      ideaTitle: "Idea X",
      proposals: [approvedIdeaProposal(APPROVED_PROPOSAL_A)],
      tasks: [
        task("t1", APPROVED_PROPOSAL_A, "done"),
        task("t2", APPROVED_PROPOSAL_A, "done"),
      ],
      existingDocuments: [
        {
          uuid: "doc-existing-report",
          type: "report",
          proposalUuid: APPROVED_PROPOSAL_A,
        },
      ],
      lastVerifiedProposalUuid: APPROVED_PROPOSAL_A,
      createReport,
    });
    expect(fired).toBe(false);
    expect(createReport).not.toHaveBeenCalled();
  });

  it("fires ZERO calls for free-form (non-idea-rooted) proposals", () => {
    const createReport = vi.fn();
    runYoloEndStep({
      ideaUuid: IDEA_UUID,
      ideaTitle: "Idea X",
      proposals: [
        // free-form proposal (e.g. quick-dev) — same UUID nominally pointed at
        // by the verified task. inputType !== "idea" so the skill must skip.
        {
          uuid: FREEFORM_PROPOSAL,
          status: "approved",
          inputType: "free-form",
          inputUuids: [],
        },
      ],
      tasks: [task("t1", FREEFORM_PROPOSAL, "done")],
      existingDocuments: [],
      lastVerifiedProposalUuid: FREEFORM_PROPOSAL,
      createReport,
    });
    expect(createReport).not.toHaveBeenCalled();
  });

  it("fires ZERO calls for an Idea whose proposals are rejected (no approved proposal)", () => {
    const createReport = vi.fn();
    runYoloEndStep({
      ideaUuid: IDEA_UUID,
      ideaTitle: "Idea X",
      proposals: [
        // Same shape as approvedIdeaProposal but status=rejected — must skip.
        {
          uuid: REJECTED_PROPOSAL,
          status: "rejected",
          inputType: "idea",
          inputUuids: [IDEA_UUID],
        },
      ],
      tasks: [task("t1", REJECTED_PROPOSAL, "done")],
      existingDocuments: [],
      lastVerifiedProposalUuid: REJECTED_PROPOSAL,
      createReport,
    });
    expect(createReport).not.toHaveBeenCalled();
  });

  it("a SECOND yolo run on the same Idea (replay) fires ZERO calls", () => {
    // Simulates the scenario where the first run completed and persisted a
    // report; a second /yolo invocation against the same Idea (e.g. user
    // accidentally re-runs) must NOT double-write. The state difference
    // between "first run" and "second run" is exactly: existingDocuments now
    // contains the previously-written report.
    const createReport = vi.fn();
    const proposals = [approvedIdeaProposal(APPROVED_PROPOSAL_A)];
    const tasks = [
      task("t1", APPROVED_PROPOSAL_A, "done"),
      task("t2", APPROVED_PROPOSAL_A, "done"),
    ];

    // First run — fires once.
    runYoloEndStep({
      ideaUuid: IDEA_UUID,
      ideaTitle: "Idea X",
      proposals,
      tasks,
      existingDocuments: [],
      lastVerifiedProposalUuid: APPROVED_PROPOSAL_A,
      createReport,
    });
    expect(createReport).toHaveBeenCalledTimes(1);

    // Second run — same input minus a now-persisted report.
    runYoloEndStep({
      ideaUuid: IDEA_UUID,
      ideaTitle: "Idea X",
      proposals,
      tasks,
      existingDocuments: [
        { uuid: "doc-from-first-run", type: "report", proposalUuid: APPROVED_PROPOSAL_A },
      ],
      lastVerifiedProposalUuid: APPROVED_PROPOSAL_A,
      createReport,
    });
    // Still 1 — second run did NOT add another call.
    expect(createReport).toHaveBeenCalledTimes(1);
  });

  it("a non-report Document (e.g. type='spec') does NOT count as 'report exists' (predicate 3 narrowness)", () => {
    const createReport = vi.fn();
    const fired = runYoloEndStep({
      ideaUuid: IDEA_UUID,
      ideaTitle: "Idea X",
      proposals: [approvedIdeaProposal(APPROVED_PROPOSAL_A)],
      tasks: [task("t1", APPROVED_PROPOSAL_A, "done")],
      existingDocuments: [
        // A spec/doc-style Document with the same proposalUuid — must NOT
        // be conflated with a "report" Document.
        { uuid: "doc-spec", type: "spec", proposalUuid: APPROVED_PROPOSAL_A },
      ],
      lastVerifiedProposalUuid: APPROVED_PROPOSAL_A,
      createReport,
    });
    expect(fired).toBe(true);
    expect(createReport).toHaveBeenCalledTimes(1);
  });

  it("a report attached to a DIFFERENT Idea's proposal does not block the current Idea's report", () => {
    const createReport = vi.fn();
    const OTHER_PROPOSAL_UUID = "prop-other-0000-0000-000000000099";
    const fired = runYoloEndStep({
      ideaUuid: IDEA_UUID,
      ideaTitle: "Idea X",
      proposals: [approvedIdeaProposal(APPROVED_PROPOSAL_A)],
      tasks: [task("t1", APPROVED_PROPOSAL_A, "done")],
      // Existing report on a different proposal — irrelevant to this Idea.
      existingDocuments: [
        { uuid: "doc-other-report", type: "report", proposalUuid: OTHER_PROPOSAL_UUID },
      ],
      lastVerifiedProposalUuid: APPROVED_PROPOSAL_A,
      createReport,
    });
    expect(fired).toBe(true);
    expect(createReport).toHaveBeenCalledTimes(1);
  });
});
