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
import { buildPrompt, buildBatchPrompt, HEADLESS_PREAMBLE, TEAM_REVIEW_MENTION_GUIDANCE } from "../prompts.mjs";

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

describe("direct Team reviewer wake protocol", () => {
  it.each(["proposal", "task", "idea"])("loads reviewer instructions on a fresh %s mention even with a truncated request", (entityType) => {
    const prompt = buildPrompt(mk({ action: "mentioned", entityType, message: "Please review…" }));
    expect(prompt).toContain(TEAM_REVIEW_MENTION_GUIDANCE);
    expect(prompt).toContain("fetch the full comments");
    expect(prompt).toContain("load and follow the current installed matching reviewer instructions BEFORE reviewing");
    expect(prompt).toContain("proposal → proposal-reviewer, task → task-reviewer, code (whole-Idea) → code-reviewer");
    expect(prompt).toContain("kind, target, current round and expected PASS/FAIL recipients");
    expect(prompt).toContain("corrected request and stop without a verdict");
    expect(prompt).toContain("exactly one final unformatted line starting at column 1: VERDICT: PASS, VERDICT: PASS WITH NOTES or VERDICT: FAIL");
    expect(prompt).toContain("No bold, backticks, bullet, quote, indentation or code fence");
    expect(prompt).toContain("exactly one actionable @mention");
    expect(prompt).toContain("proposal FAIL → current product delegate, else orchestrator");
    expect(prompt).toContain("task FAIL → current logical task developer");
    expect(prompt).toContain("whole-Idea FAIL → current orchestrator");
    expect(prompt).toContain("override generic sender/orchestrator reply guidance");
    expect(prompt).toContain("no second completion handoff");
    expect(prompt).not.toMatch(/^VERDICT:/m);
  });

  it("preserves dispatch and receiver rules in a coalesced mention wake", () => {
    const prompt = buildBatchPrompt([
      mk({ action: "task_assigned" }),
      mk({ action: "mentioned", entityType: "proposal", entityUuid: "proposal-1" }),
    ]);
    expect(prompt).toContain(TEAM_REVIEW_MENTION_GUIDANCE);
    expect(prompt).toContain("Team review request — <kind>, round N");
    expect(prompt).toContain("target UUID and matching reviewer protocol location");
    expect(prompt).toContain("expected PASS/FAIL recipient names and UUIDs without extra @mentions");
    expect(prompt).toContain("never start a request/forwarding line with VERDICT:");
  });

  it("does not turn non-review work into a reviewer request", () => {
    expect(buildPrompt(mk({ action: "task_assigned" }))).not.toContain(TEAM_REVIEW_MENTION_GUIDANCE);
    expect(buildPrompt(mk({ action: "mentioned", message: "ordinary question" }))).toContain("For a Team review handoff or direct review request only (not ordinary mentions)");
  });
});

describe("conditional sender mention guidance", () => {
  it.each(["user", "agent"])("mentions a %s sender only when they must act, never to acknowledge", (actorType) => {
    const prompt = buildPrompt(mk({ action: "mentioned", actorType }));
    expect(prompt).toContain("Only if the sender must act on your result (a question, requested decision, or work handoff)");
    expect(prompt).toContain(`post a comment on this task using chorus_add_comment with @mention: @[Alice](${actorType}:user-1)`);
    expect(prompt).toContain('Never @mention only to acknowledge or say "received".');
    expect(prompt).not.toContain("After completing your work, post a comment");
  });
});

describe("headless background lifetime policy", () => {
  it("leaves background-agent waiting to runtime configuration, not a global foreground mandate", () => {
    const prompt = buildPrompt(mk({}));
    expect(prompt).toContain(HEADLESS_PREAMBLE);
    expect(HEADLESS_PREAMBLE).not.toContain("run_in_background");
    expect(HEADLESS_PREAMBLE).not.toMatch(/(?:collect and handle ALL|Wait for each owned child's)/);
    expect(HEADLESS_PREAMBLE).toContain("END THE TURN and leave the work");
    expect(HEADLESS_PREAMBLE).toContain("do not poll or wait for a synchronous reply");
  });
});

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

describe("scoped session headers", () => {
  it("places task isolation and worktree guidance before the wake body", () => {
    const notification = mk({ sessionId: "task:task-A", entityUuid: "task-A" });
    const prompt = buildPrompt(notification);
    expect(prompt.startsWith(HEADLESS_PREAMBLE)).toBe(true);
    expect(prompt).toContain("task-scoped session for task task-A");
    expect(prompt).toContain("no memory of the Idea session");
    expect(prompt).toContain("read the task, its proposal and the Idea first");
    expect(prompt).toContain("Other tasks of the same Idea may run concurrently in this working directory");
    expect(prompt).toContain("before editing files, work in your own git worktree");
    expect(prompt).toContain("EnterWorktree / `git worktree add`");
    expect(prompt.indexOf("task-scoped session")).toBeLessThan(prompt.indexOf("chorus_get_task"));
    expect(buildBatchPrompt([notification])).toBe(prompt);
  });

  it.each(["task", "proposal", "idea"])("makes %s reviews read-only without development memory", (entityType) => {
    const notification = mk({ action: "mentioned", sessionId: `review:${entityType}:review-target` });
    const prompt = buildPrompt(notification);
    expect(prompt).toContain(`review-scoped session for ${entityType} review-target`);
    expect(prompt).toContain("it never carries development memory. Stay read-only.");
    expect(prompt).not.toContain("task-scoped session");
    expect(prompt).not.toContain("git worktree add");
    expect(buildBatchPrompt([notification])).toBe(prompt);
  });

  it.each(["task:task-A", "review:task:task-A", "review:proposal:proposal-A", "review:idea:idea-A"])(
    "includes one scope header for coalesced and resumed wakes on %s", (sessionId) => {
      const notification = mk({ sessionId, action: "resource_resumed" });
      const prompt = buildBatchPrompt([notification, mk({ sessionId, action: "mentioned" })]);
      const header = buildPrompt(notification).split("\n\n").find((part) => part.includes("-scoped session"));
      expect(header).toBeTruthy();
      expect(occurrences(prompt, header)).toBe(1);
      expect(prompt.indexOf(header)).toBeLessThan(prompt.indexOf("queued Chorus events"));
    },
  );

  it.each([undefined, null, "", "11111111-1111-4111-8111-111111111111", "ad-hoc-session", "review:document:doc-A"])(
    "keeps unscoped prompts byte-identical for sessionId %s", (sessionId) => {
      const notification = mk();
      const mention = mk({ action: "mentioned" });
      expect(buildPrompt({ ...notification, sessionId })).toBe(buildPrompt(notification));
      expect(buildBatchPrompt([{ ...notification, sessionId }, { ...mention, sessionId }]))
        .toBe(buildBatchPrompt([notification, mention]));
    },
  );

  it.each(["task:task-A", "review:task:task-A"])("does not render a scope-only empty wake for %s", (sessionId) => {
    const notification = mk({ sessionId, action: "human_instruction", instructionText: "" });
    expect(buildPrompt(notification)).toBeNull();
    expect(buildBatchPrompt([notification, notification])).toBeNull();
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

describe("buildBatchPrompt — waker-session advisory anchor (T2, busy-worker batch)", () => {
  // AC (proposal-reviewer flag): the advisory anchor must ALSO surface in the coalesced
  // multi-wake path — the busy-worker scenario is exactly a batch. It is actor-scoped, so
  // it rides each event's own block (not once at the top).
  const WAKER_X = { agentUuid: "agent-x", agentName: "PeerX", ideaUuid: "idea-X" };
  const WAKER_Y = { agentUuid: "agent-y", agentName: "PeerY", ideaUuid: "idea-Y" };

  it("surfaces each event's own anchor per block; events without one carry no anchor", () => {
    const withAnchor = mk({
      action: "mentioned",
      entityType: "idea",
      entityUuid: "idea-X",
      message: "@agent look",
      wakerSession: WAKER_X,
    });
    const noAnchor = mk({ action: "task_assigned", entityUuid: "task-F", entityTitle: "F" });
    const p = buildBatchPrompt([withAnchor, noAnchor]);

    // both events render as blocks
    expect(occurrences(p, "### Event ")).toBe(2);
    // the anchor rides the block that carries it, naming its own waker
    expect(p).toContain("@[PeerX](agent:agent-x)");
    expect(p).toContain("has a live session open on this resource");
    // exactly one anchor block — the no-anchor event contributes none
    expect(occurrences(p, "has a live session open on this resource")).toBe(1);
    // still advisory, not a routing guarantee
    expect(p).toContain("advisory, not an");
  });

  it("renders a distinct per-wake anchor for each event that carries one", () => {
    const a = mk({ action: "task_assigned", entityUuid: "task-A", wakerSession: WAKER_X });
    const b = mk({
      action: "mentioned",
      entityType: "idea",
      entityUuid: "idea-Y",
      message: "@agent hi",
      wakerSession: WAKER_Y,
    });
    const p = buildBatchPrompt([a, b]);
    expect(p).toContain("@[PeerX](agent:agent-x)");
    expect(p).toContain("@[PeerY](agent:agent-y)");
    expect(occurrences(p, "has a live session open on this resource")).toBe(2);
    // each anchor sits with its own event, in arrival order
    expect(p.indexOf("@[PeerX](agent:agent-x)")).toBeLessThan(p.indexOf("@[PeerY](agent:agent-y)"));
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
