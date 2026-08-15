// cli/__tests__/prompts.test.mjs
// Unit tests for buildBatchPrompt (add-daemon-wake-coalescing, tech design §C2).
// Written TDD-first, BEFORE the implementation.
//
// buildBatchPrompt merges the same-session wakes that piled up while the agent was
// busy into ONE prompt:
//   - size 1  → byte-identical to buildPrompt(n) (the single-event path is unchanged);
//   - size >1 → the headless preamble ONCE, then a short backlog preamble, then one
//               labeled block per event in arrival order, reusing the per-action body;
//   - events sharing (action, entityUuid) collapse into one block noting the count and
//     showing the NEWEST message — EXCEPT human_instruction, which is NEVER collapsed
//     (its text lives only on the turn, not re-fetchable, so collapsing would drop chat);
//   - events whose per-action body is null (empty human_instruction, non-wake action)
//     are omitted.
//
// The prompt bodies themselves are covered by wake-orchestration.test.mjs; here we only
// assert the batch composition on top of them, so this file stays independent of the
// modules (waker/event-router/wake-queue) that other tasks touch.
import { describe, it, expect } from "vitest";
import { buildPrompt, buildBatchPrompt, HEADLESS_PREAMBLE } from "../prompts.mjs";

/** A representative task_assigned notification; spread `mk({...})` to vary it. */
const BASE = {
  uuid: "n-0",
  projectUuid: "proj-1",
  entityType: "task",
  entityUuid: "task-1",
  entityTitle: "Build the thing",
  action: "task_assigned",
  message: "",
  actorType: "user",
  actorUuid: "user-1",
  actorName: "Alice",
};
const mk = (o) => ({ ...BASE, ...o });

/** Count non-overlapping occurrences of `needle` in `hay`. */
function occurrences(hay, needle) {
  return hay.split(needle).length - 1;
}

describe("buildBatchPrompt — single-event path is byte-identical to buildPrompt", () => {
  // AC: buildBatchPrompt([n]) === buildPrompt(n) byte-for-byte across representative actions.
  const reps = [
    mk({ action: "task_assigned" }),
    mk({ action: "mentioned", entityType: "idea", entityUuid: "idea-9", message: "@agent take a look" }),
    mk({
      action: "proposal_approved",
      entityType: "proposal",
      entityUuid: "prop-1",
      entityTitle: "My Proposal",
      message: 'Proposal "My Proposal" has been approved. Note: ship it',
    }),
    mk({ action: "elaboration_verified", entityType: "idea", entityUuid: "idea-2", entityTitle: "Elab" }),
    mk({ action: "start_development", entityType: "idea", entityUuid: "idea-3", entityTitle: "Dev" }),
    mk({ action: "yolo_requested", entityType: "idea", entityUuid: "idea-4", entityTitle: "Yolo" }),
    mk({ action: "resource_resumed", entityType: "task", entityUuid: "task-7" }),
    mk({ action: "human_instruction", entityType: "idea", entityUuid: "idea-5", instructionText: "please rebase onto main" }),
  ];
  for (const n of reps) {
    it(`[${n.action}] buildBatchPrompt([n]) === buildPrompt(n)`, () => {
      const single = buildPrompt(n);
      expect(single).not.toBeNull(); // sanity: these actions all produce a body
      expect(buildBatchPrompt([n])).toBe(single);
    });
  }

  it("a single empty human_instruction yields null, exactly like buildPrompt", () => {
    const n = mk({ action: "human_instruction", instructionText: "   " });
    expect(buildPrompt(n)).toBeNull();
    expect(buildBatchPrompt([n])).toBe(buildPrompt(n));
    expect(buildBatchPrompt([n])).toBeNull();
  });

  it("collapses to the single-event path when only one event has a renderable body", () => {
    // A batch of 2 where one is an empty human_instruction reduces to the lone real
    // event and is byte-identical to its single-event prompt (no backlog preamble).
    const empty = mk({ action: "human_instruction", instructionText: "" });
    const real = mk({ action: "mentioned", entityType: "idea", entityUuid: "idea-9", message: "@agent hi" });
    expect(buildBatchPrompt([empty, real])).toBe(buildPrompt(real));
  });
});

describe("buildBatchPrompt — N>1 composition", () => {
  it("emits exactly one headless preamble, one backlog preamble, and N ordered labeled blocks", () => {
    // AC: For N>1 events, output has exactly one HEADLESS_PREAMBLE + one backlog
    // preamble + labeled blocks in arrival order.
    const a = mk({ action: "task_assigned", entityUuid: "task-A", entityTitle: "Alpha" });
    const b = mk({ action: "mentioned", entityType: "idea", entityUuid: "idea-B", entityTitle: "Bravo", message: "@agent see this" });
    const c = mk({ action: "task_reopened", entityUuid: "task-C", entityTitle: "Charlie" });
    const p = buildBatchPrompt([a, b, c]);

    // headless preamble appears exactly once, at the very top
    expect(occurrences(p, HEADLESS_PREAMBLE)).toBe(1);
    expect(p.startsWith(HEADLESS_PREAMBLE)).toBe(true);

    // exactly one backlog preamble, stating the count (3 renderable events)
    expect(occurrences(p, "queued Chorus events on this session")).toBe(1);
    expect(p).toContain("You have 3 queued Chorus events on this session");

    // three labeled blocks, in arrival order
    expect(occurrences(p, "### Event ")).toBe(3);
    expect(p).toContain("### Event 1 — task_assigned on task task-A");
    expect(p).toContain("### Event 2 — mentioned on idea idea-B");
    expect(p).toContain("### Event 3 — task_reopened on task task-C");

    // arrival order preserved in the rendered text
    expect(p.indexOf("### Event 1")).toBeLessThan(p.indexOf("### Event 2"));
    expect(p.indexOf("### Event 2")).toBeLessThan(p.indexOf("### Event 3"));
    expect(p.indexOf("task-A")).toBeLessThan(p.indexOf("idea-B"));
    expect(p.indexOf("idea-B")).toBeLessThan(p.indexOf("task-C"));
  });

  it("each block keeps its own per-action tool hints and @mention guidance", () => {
    // AC: Each event block still carries its per-action tool hints and @mention guidance.
    const t = mk({
      action: "task_assigned",
      entityUuid: "task-A",
      entityTitle: "Alpha",
      actorName: "Alice",
      actorType: "user",
      actorUuid: "user-1",
    });
    const m = mk({
      action: "mentioned",
      entityType: "idea",
      entityUuid: "idea-B",
      entityTitle: "Bravo",
      message: "@agent hey",
      actorName: "Bob",
      actorType: "user",
      actorUuid: "user-2",
    });
    const p = buildBatchPrompt([t, m]);
    // task_assigned tool hints + its own @mention (Alice)
    expect(p).toContain("chorus_get_task");
    expect(p).toContain("chorus_claim_task");
    expect(p).toContain("@[Alice](user:user-1)");
    // mentioned tool hints + its own @mention (Bob)
    expect(p).toContain("chorus_get_comments");
    expect(p).toContain("@[Bob](user:user-2)");
  });
});

describe("buildBatchPrompt — same-(action,entityUuid) collapse", () => {
  it("collapses repeated same-entity events into one block noting the count and the newest message", () => {
    // AC: Multiple events with the same (action, entityUuid) collapse into one block
    // noting the count and showing the newest message.
    const base = { action: "mentioned", entityType: "idea", entityUuid: "idea-X", entityTitle: "X" };
    const m1 = mk({ ...base, uuid: "m1", message: "OLDESTMENTIONTEXT" });
    const m2 = mk({ ...base, uuid: "m2", message: "MIDDLEMENTIONTEXT" });
    const m3 = mk({ ...base, uuid: "m3", message: "NEWESTMENTIONTEXT" });
    const p = buildBatchPrompt([m1, m2, m3]);

    // one collapsed block for idea-X
    expect(occurrences(p, "### Event ")).toBe(1);
    expect(occurrences(p, "on idea idea-X")).toBe(1);

    // the block notes the occurrence count and the action
    expect(p).toContain("3 mentioned events");

    // shows the NEWEST message; the two older ones are dropped (not re-fetchable? no —
    // comments ARE re-derivable, hence collapse is safe here)
    expect(p).toContain("NEWESTMENTIONTEXT");
    expect(p).not.toContain("OLDESTMENTIONTEXT");
    expect(p).not.toContain("MIDDLEMENTIONTEXT");
  });

  it("keeps distinct (action, entityUuid) events as separate blocks (no over-collapse)", () => {
    const m1 = mk({ action: "mentioned", entityType: "idea", entityUuid: "idea-X", message: "@agent one" });
    const m2 = mk({ action: "mentioned", entityType: "idea", entityUuid: "idea-Y", message: "@agent two" });
    // same entity but DIFFERENT action → not collapsed with the mention on idea-X
    const r = mk({ action: "task_reopened", entityType: "task", entityUuid: "idea-X", entityTitle: "reopened" });
    const p = buildBatchPrompt([m1, m2, r]);
    expect(occurrences(p, "### Event ")).toBe(3);
    expect(p).toContain("on idea idea-X");
    expect(p).toContain("on idea idea-Y");
    expect(p).toContain("on task idea-X");
  });

  it("a collapsed group holds its first-seen slot while a human_instruction interleaves", () => {
    const m1 = mk({ uuid: "m1", action: "mentioned", entityType: "idea", entityUuid: "idea-X", message: "OLDERMENTION" });
    const h1 = mk({ uuid: "h1", action: "human_instruction", entityType: "idea", entityUuid: "idea-X", instructionText: "CHATBETWEEN" });
    const m2 = mk({ uuid: "m2", action: "mentioned", entityType: "idea", entityUuid: "idea-X", message: "NEWERMENTION" });
    const p = buildBatchPrompt([m1, h1, m2]);

    // two blocks: the collapsed mention (at m1's first-seen slot) + the chat message
    expect(occurrences(p, "### Event ")).toBe(2);
    expect(p).toContain("### Event 1 — mentioned on idea idea-X");
    expect(p).toContain("### Event 2 — human_instruction on idea idea-X");
    // newest mention shown, older dropped; chat preserved in full
    expect(p).toContain("NEWERMENTION");
    expect(p).not.toContain("OLDERMENTION");
    expect(p).toContain("CHATBETWEEN");
    // N counts every renderable event (3), not the block count (2)
    expect(p).toContain("You have 3 queued Chorus events");
  });
});

describe("buildBatchPrompt — human_instruction is NEVER collapsed", () => {
  it("renders three same-session chat messages as three full blocks in arrival order", () => {
    // AC: human_instruction is EXEMPT from collapse: three queued chat messages render
    // as three full blocks in arrival order, none dropped or reduced to newest-only.
    // (Round-1 BLOCKER-2: every human_instruction carries entityUuid=directIdeaUuid, so
    // collapsing by (action, entityUuid) would drop all but the newest.)
    const base = { action: "human_instruction", entityType: "idea", entityUuid: "idea-D" };
    const h1 = mk({ ...base, uuid: "h1", instructionText: "ALPHAINSTRUCTION" });
    const h2 = mk({ ...base, uuid: "h2", instructionText: "BRAVOINSTRUCTION" });
    const h3 = mk({ ...base, uuid: "h3", instructionText: "CHARLIEINSTRUCTION" });
    const p = buildBatchPrompt([h1, h2, h3]);

    // three separate blocks despite identical (action, entityUuid)
    expect(occurrences(p, "### Event ")).toBe(3);
    expect(occurrences(p, "human_instruction on idea idea-D")).toBe(3);

    // all three instruction texts present in full — none collapsed away
    expect(p).toContain("ALPHAINSTRUCTION");
    expect(p).toContain("BRAVOINSTRUCTION");
    expect(p).toContain("CHARLIEINSTRUCTION");

    // arrival order preserved
    expect(p.indexOf("ALPHAINSTRUCTION")).toBeLessThan(p.indexOf("BRAVOINSTRUCTION"));
    expect(p.indexOf("BRAVOINSTRUCTION")).toBeLessThan(p.indexOf("CHARLIEINSTRUCTION"));

    // and it is NOT reduced to a single "3 occurrences" collapse block
    expect(p).not.toContain("3 human_instruction events");
    expect(p).toContain("You have 3 queued Chorus events");
  });
});

describe("buildBatchPrompt — null-body events are omitted", () => {
  it("omits empty human_instruction events from a multi-event batch", () => {
    // AC: Events whose body is null (empty human_instruction) are omitted from the batch.
    const empty = mk({ action: "human_instruction", entityType: "idea", entityUuid: "idea-D", instructionText: "   " });
    const m = mk({ action: "mentioned", entityType: "idea", entityUuid: "idea-E", message: "@agent real one" });
    const t = mk({ action: "task_assigned", entityUuid: "task-F", entityTitle: "F" });
    const p = buildBatchPrompt([empty, m, t]);

    // only the two real events render
    expect(occurrences(p, "### Event ")).toBe(2);
    expect(p).toContain("You have 2 queued Chorus events");
    expect(p).toContain("on idea idea-E");
    expect(p).toContain("on task task-F");
    // the empty instruction contributed no block at all
    expect(p).not.toContain("human_instruction");
  });

  it("returns null when every event in the batch has a null body", () => {
    const e1 = mk({ action: "human_instruction", instructionText: "" });
    const e2 = mk({ action: "count_update" }); // non-wake action → null body
    expect(buildBatchPrompt([e1, e2])).toBeNull();
  });

  it("returns null for an empty batch", () => {
    expect(buildBatchPrompt([])).toBeNull();
  });
});
