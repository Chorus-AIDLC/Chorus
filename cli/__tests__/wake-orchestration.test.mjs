// cli/__tests__/wake-orchestration.test.mjs
// Covers the EventRouter → Waker → ClaudeSpawner wake loop, prompt builders,
// failure isolation, and the no-op upload hooks (cli-daemon spec
// "Task-dispatch wake" + "Reserved upload hooks").
import { describe, it, expect, vi } from "vitest";
import { buildPrompt, buildBatchPrompt, WAKE_ACTIONS, HEADLESS_PREAMBLE } from "../prompts.mjs";
import { createNoopUploadHooks } from "../upload-hooks.mjs";
import { Waker } from "../waker.mjs";
import { EventRouter } from "../event-router.mjs";
import { WakeQueue } from "../wake-queue.mjs";
import { ClaudeSpawner } from "../claude-spawner.mjs";
import { EventEmitter } from "node:events";

const silent = { info() {}, warn() {}, error() {} };

const TASK_NOTIF = {
  uuid: "notif-1",
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

describe("buildPrompt", () => {
  it("task_assigned prompt contains the task + project UUIDs and the claim tool", () => {
    const p = buildPrompt(TASK_NOTIF);
    expect(p).toContain("task-1");
    expect(p).toContain("proj-1");
    expect(p).toContain("chorus_get_task");
    expect(p).toContain("chorus_claim_task");
    expect(p).toContain("@[Alice](user:user-1)"); // mention guidance
  });

  it("returns null for non-wake actions", () => {
    expect(buildPrompt({ ...TASK_NOTIF, action: "count_update" })).toBeNull();
    // Deliberately-ignored real actions also return null.
    expect(buildPrompt({ ...TASK_NOTIF, action: "task_status_changed" })).toBeNull();
    expect(buildPrompt({ ...TASK_NOTIF, action: "report_created" })).toBeNull();
  });

  it("comment_added does NOT wake (too noisy); only an explicit @mention does", () => {
    // A plain comment to the task's assignee/creator should be ignored...
    expect(buildPrompt({ ...TASK_NOTIF, action: "comment_added", message: "please rebase" })).toBeNull();
    // ...but an @mention (delivered as action "mentioned") wakes.
    const m = buildPrompt({ ...TASK_NOTIF, action: "mentioned", message: "@agent please rebase" });
    expect(m).not.toBeNull();
    expect(m).toContain("chorus_get_comments");
  });

  it("builds a non-null prompt for every action in WAKE_ACTIONS (no dead/missing entries)", () => {
    for (const action of WAKE_ACTIONS) {
      // human_instruction is a wake action only when it carries a free-text body — its
      // actionable payload IS the instruction, so supply one for the coverage check
      // (an empty-body human_instruction legitimately returns null; see its own test).
      const extra = action === "human_instruction" ? { instructionText: "please rebase onto main" } : {};
      const p = buildPrompt({ ...TASK_NOTIF, action, ...extra });
      expect(p, `WAKE_ACTIONS has "${action}" but buildPrompt returns null for it`).not.toBeNull();
    }
  });

  it("proposal_approved surfaces the reviewer's note inline when message carries one", () => {
    const p = buildPrompt({
      ...TASK_NOTIF,
      action: "proposal_approved",
      entityType: "proposal",
      entityUuid: "prop-1",
      entityTitle: "My Proposal",
      message: 'Proposal "My Proposal" has been approved. Note: ship it but rename the flag',
    });
    expect(p).not.toBeNull();
    expect(p).toContain("APPROVED");
    // The reviewer's opinion is inline so the daemon needs no follow-up fetch.
    expect(p).toContain("Review note:");
    expect(p).toContain("ship it but rename the flag");
    // Still points at the unblocked-tasks tool.
    expect(p).toContain("chorus_get_unblocked_tasks");
  });

  it("proposal_approved WITHOUT a note reads cleanly (no empty note text)", () => {
    const p = buildPrompt({
      ...TASK_NOTIF,
      action: "proposal_approved",
      entityType: "proposal",
      entityUuid: "prop-1",
      entityTitle: "My Proposal",
      message: 'Proposal "My Proposal" has been approved',
    });
    expect(p).not.toBeNull();
    expect(p).toContain("APPROVED");
    // No "Note: " marker in the message → no review-note fragment, no empty placeholder.
    expect(p).not.toContain("Review note:");
    expect(p).toContain("chorus_get_unblocked_tasks");
  });

  it("proposal_rejected still embeds the reviewer's reason (unchanged by the approve-note fix)", () => {
    const p = buildPrompt({
      ...TASK_NOTIF,
      action: "proposal_rejected",
      entityType: "proposal",
      entityUuid: "prop-1",
      entityTitle: "My Proposal",
      message: "too risky, split it",
    });
    expect(p).not.toBeNull();
    expect(p).toContain("REJECTED");
    expect(p).toContain('Review note: "too risky, split it"');
    expect(p).toContain("chorus_pm_submit_proposal");
  });

  it("resource_resumed is an entity-generic wake action with a continue prompt (子3)", () => {
    expect(WAKE_ACTIONS.has("resource_resumed")).toBe(true);
    // Resume is entity-generic and arrives off the control channel as a synthetic
    // dispatch carrying only entityType + entityUuid (no title/project/actor).
    const p = buildPrompt({ action: "resource_resumed", entityType: "task", entityUuid: "task-1" });
    expect(p).not.toBeNull();
    expect(p).toContain("task-1"); // the entity uuid
    expect(p).toContain("RESUMED"); // tells the agent it's a resume
    expect(p.toLowerCase()).toContain("continue where you left off");
    expect(p).toContain("chorus_get_task");
    // Works for a non-task entity too (idea), since interrupted state is generic.
    const pi = buildPrompt({ action: "resource_resumed", entityType: "idea", entityUuid: "idea-7" });
    expect(pi).not.toBeNull();
    expect(pi).toContain("idea-7");
  });

  it("resource_resumed with resumedFrom=crash injects the crash-specific continue instruction (add-crash-execution-resume)", () => {
    const p = buildPrompt({
      action: "resource_resumed",
      entityType: "task",
      entityUuid: "task-1",
      resumedFrom: "crash",
    });
    expect(p).not.toBeNull();
    expect(p).toContain("task-1");
    // States the abnormal exit and instructs verify-state-then-continue.
    expect(p).toContain("EXITED ABNORMALLY");
    expect(p).toContain("chorus_get_task");
    expect(p.toLowerCase()).toContain("re-check the current state");
    expect(p.toLowerCase()).toContain("continue the unfinished work");
    // It is a DIFFERENT text from the user-resume prompt.
    expect(p).not.toContain("RESUMED after an interrupt");
  });

  it("resource_resumed with resumedFrom=user, absent, or unknown keeps the user-resume prompt (graceful degradation)", () => {
    const base = { action: "resource_resumed", entityType: "task", entityUuid: "task-1" };
    const userText = buildPrompt({ ...base, resumedFrom: "user" });
    const absentText = buildPrompt(base);
    const unknownText = buildPrompt({ ...base, resumedFrom: "meteor" });
    expect(userText).toContain("RESUMED after an interrupt");
    // Absent (older server) and unknown values degrade to the SAME user text.
    expect(absentText).toBe(userText);
    expect(unknownText).toBe(userText);
    expect(userText).not.toContain("EXITED ABNORMALLY");
  });

  it("elaboration_verified wakes the agent to WRITE the proposal, not answer questions (add-elaboration-verify-wake)", () => {
    expect(WAKE_ACTIONS.has("elaboration_verified")).toBe(true);
    const p = buildPrompt({
      ...TASK_NOTIF,
      action: "elaboration_verified",
      entityType: "idea",
      entityUuid: "idea-9",
      entityTitle: "Ship the widget",
    });
    expect(p).not.toBeNull();
    expect(p).toContain("idea-9"); // the idea uuid
    expect(p).toContain("proj-1"); // project uuid for context
    expect(p).toContain("VERIFIED"); // tells the agent the elaboration was verified
    expect(p).toContain("elaborated"); // idea is now elaborated
    // It must direct proposal authoring via the existing proposal flow...
    expect(p).toContain("chorus_pm_create_proposal");
    expect(p).toContain("chorus_get_idea");
    expect(p).toContain("chorus_get_elaboration");
    expect(p.toLowerCase()).toContain("write the proposal");
    // ...and must NOT instruct the agent to answer elaboration questions or open a round.
    expect(p).not.toContain("chorus_pm_validate_elaboration");
    expect(p).not.toContain("chorus_pm_start_elaboration");
    expect(p).toContain("@[Alice](user:user-1)"); // mention guidance
  });

  it("start_development wakes the agent to EXECUTE ALL remaining tasks, never stopping after one (add-stage-advance-start-development)", () => {
    expect(WAKE_ACTIONS.has("start_development")).toBe(true);
    const p = buildPrompt({
      ...TASK_NOTIF,
      action: "start_development",
      entityType: "idea",
      entityUuid: "idea-9",
      entityTitle: "Ship the widget",
    });
    expect(p).not.toBeNull();
    expect(p).toContain("idea-9"); // the idea uuid
    expect(p).toContain("proj-1"); // project uuid for context
    // The execute-all contract (elaboration decision Q1):
    expect(p).toContain("ALL remaining tasks");
    expect(p).toContain("dependency");
    expect(p).toContain("Do NOT stop after one task");
    // The develop-flow loop tools:
    expect(p).toContain("chorus_get_unblocked_tasks");
    expect(p).toContain("chorus_claim_task");
    expect(p).toContain("chorus_submit_for_verify");
    // Boundaries: leave to_verify / foreign-claimed tasks; end benignly.
    expect(p).toContain("to_verify");
    expect(p.toLowerCase()).toContain("other sessions");
    expect(p.toLowerCase()).toContain("status comment");
    // It must NOT instruct proposal authoring — that's the elaboration_verified wake.
    expect(p).not.toContain("chorus_pm_create_proposal");
    expect(p).toContain("@[Alice](user:user-1)"); // mention guidance
  });

  it("yolo_requested wakes the agent to drive the whole idea via the yolo skill, stage-adaptive, no PR merge (add-stage-advance-yolo)", () => {
    expect(WAKE_ACTIONS.has("yolo_requested")).toBe(true);
    const p = buildPrompt({
      ...TASK_NOTIF,
      action: "yolo_requested",
      entityType: "idea",
      entityUuid: "idea-9",
      entityTitle: "Ship the widget",
    });
    expect(p).not.toBeNull();
    expect(p).toContain("idea-9"); // the idea uuid
    expect(p).toContain("proj-1"); // project uuid for context
    // Points at the yolo skill / full pipeline:
    expect(p.toLowerCase()).toContain("yolo skill");
    // Stage-adaptive — resume from current phase, NOT a hard-coded execute loop:
    expect(p.toLowerCase()).toContain("resume");
    expect(p).not.toContain("ALL remaining tasks");
    // "Yolo never merges": must forbid a PR merge/push without approval.
    expect(p.toLowerCase()).toContain("do not merge");
    expect(p).toContain("@[Alice](user:user-1)"); // mention guidance
  });

  it("WAKE_ACTIONS covers the agent-relevant server notifications and excludes the noisy ones", () => {
    for (const a of [
      "task_assigned",
      "mentioned",
      "elaboration_requested",
      "elaboration_answered",
      "elaboration_verified",
      "start_development",
      "yolo_requested",
      "proposal_rejected",
      "proposal_approved",
      "idea_claimed",
      "task_reopened",
      "task_verified",
    ]) {
      expect(WAKE_ACTIONS.has(a), `expected ${a} to wake`).toBe(true);
    }
    for (const a of [
      "comment_added",
      "task_status_changed",
      "task_submitted_for_verify",
      "report_created",
      "count_update",
    ]) {
      expect(WAKE_ACTIONS.has(a), `expected ${a} NOT to wake`).toBe(false);
    }
  });
});

// add-daemon-headless-interaction-guard: every wake prompt carries the headless preamble
// so a daemon-woken (no-human-at-terminal) session never calls AskUserQuestion and routes
// human-decision points through Chorus instead.
describe("HEADLESS_PREAMBLE (daemon headless interaction guard)", () => {
  it("the preamble declares headlessness, the env signal, the AskUserQuestion prohibition, the Chorus route, and the async hand-off", () => {
    // (1) identity + no-human + env signal
    expect(HEADLESS_PREAMBLE).toContain("headless");
    expect(HEADLESS_PREAMBLE.toLowerCase()).toContain("no human at the terminal");
    expect(HEADLESS_PREAMBLE).toContain("CHORUS_DAEMON_HEADLESS=1");
    // (2) prohibition — literal tool name
    expect(HEADLESS_PREAMBLE).toContain("AskUserQuestion");
    // (3) general route-through-Chorus rule
    expect(HEADLESS_PREAMBLE).toContain("chorus_add_comment");
    expect(HEADLESS_PREAMBLE.toLowerCase()).toContain("elaboration");
    // (4) reference-attachment reflex (strengthen-reference-association)
    expect(HEADLESS_PREAMBLE).toContain("references[]");
    expect(HEADLESS_PREAMBLE).toContain("chorus_add_reference");
    // (5) async hand-off — post then end the turn, don't block
    expect(HEADLESS_PREAMBLE.toLowerCase()).toContain("end the turn");
    expect(HEADLESS_PREAMBLE.toLowerCase()).toContain("pending");
  });

  it("does NOT embed the answer-questions tool names — keeps the elaboration_verified contract intact even though it rides every wake", () => {
    // The preamble is prepended to EVERY wake, including elaboration_verified
    // (write-the-proposal), whose contract forbids the answer-questions tools. Routing
    // guidance therefore uses chorus_add_comment + prose, not these literals.
    expect(HEADLESS_PREAMBLE).not.toContain("chorus_pm_start_elaboration");
    expect(HEADLESS_PREAMBLE).not.toContain("chorus_pm_validate_elaboration");
  });

  it("every WAKE_ACTIONS prompt is prefixed with the preamble while preserving the per-action body + @mention guidance", () => {
    for (const action of WAKE_ACTIONS) {
      const extra = action === "human_instruction" ? { instructionText: "please rebase onto main" } : {};
      const p = buildPrompt({ ...TASK_NOTIF, action, ...extra });
      expect(p, `WAKE_ACTIONS "${action}" must produce a prompt`).not.toBeNull();
      // preamble first, original body after it
      expect(p.startsWith(HEADLESS_PREAMBLE), `"${action}" prompt must start with the preamble`).toBe(true);
      expect(p).toContain("AskUserQuestion");
      expect(p.toLowerCase()).toContain("end the turn");
      // the per-action body still follows the preamble (e.g. the [Chorus] marker)
      expect(p.slice(HEADLESS_PREAMBLE.length)).toContain("[Chorus]");
    }
  });

  it("preserves the per-action @mention guidance after the preamble (task_assigned)", () => {
    const p = buildPrompt(TASK_NOTIF);
    expect(p.startsWith(HEADLESS_PREAMBLE)).toBe(true);
    expect(p).toContain("chorus_claim_task"); // body intact
    expect(p).toContain("@[Alice](user:user-1)"); // mention guidance intact
  });

  it("a null body stays null after the wrapper — no preamble-only prompt is produced", () => {
    // unknown action
    expect(buildPrompt({ ...TASK_NOTIF, action: "count_update" })).toBeNull();
    // empty human_instruction (no body to act on)
    expect(buildPrompt({ ...TASK_NOTIF, action: "human_instruction", instructionText: "   " })).toBeNull();
    expect(buildPrompt({ ...TASK_NOTIF, action: "human_instruction" })).toBeNull();
  });
});

// A canonical lowercase UUID used as the direct idea (= deterministic session id).
const DIRECT_IDEA = "11111111-1111-4111-8111-111111111111";
const ROOT_IDEA = "99999999-9999-4999-8999-999999999999";

function makeWaker(overrides = {}) {
  const spawner = overrides.spawner ?? {
    wake: vi.fn(async ({ sessionId, onMessage }) => {
      onMessage?.({ type: "system", session_id: sessionId });
      return { sessionId, exitCode: 0, isNew: true };
    }),
  };
  // Lineage now resolves BOTH ids in one call. Default: direct ≠ root.
  const lineage =
    overrides.lineage ??
    { resolve: vi.fn(async () => ({ rootIdeaUuid: ROOT_IDEA, directIdeaUuid: DIRECT_IDEA })) };
  const hooks = overrides.hooks ?? createNoopUploadHooks();
  const writeMcpConfigFn =
    overrides.writeMcpConfigFn ?? vi.fn(() => ({ path: "/tmp/m.json", cleanup: vi.fn() }));
  // Disk probe is injected so tests control new-vs-resume without touching the FS.
  const isNewSessionFn = overrides.isNewSessionFn ?? vi.fn(() => true);
  // Interrupt reporter (子3): injected spy so tests assert user-vs-crash reporting.
  const reportInterrupt = overrides.reportInterrupt ?? vi.fn(async () => {});
  // Turn reporter (子1 / coalescing): injected spy so tests can assert coalescedCount.
  const advanceTurn = overrides.advanceTurn ?? vi.fn(async () => {});
  const waker = new Waker({
    creds: { url: "https://c", apiKey: "cho_x" },
    lineage,
    spawner,
    cwd: overrides.cwd ?? "/work/dir",
    hooks,
    logger: silent,
    writeMcpConfigFn,
    isNewSessionFn,
    reportInterrupt,
    advanceTurn,
  });
  return { waker, spawner, lineage, hooks, writeMcpConfigFn, isNewSessionFn, reportInterrupt, advanceTurn };
}

describe("Waker.wake full loop", () => {
  it("keyFor anchors on the DIRECT idea and returns both ids", async () => {
    const { waker } = makeWaker();
    const resolved = await waker.keyFor(TASK_NOTIF);
    expect(resolved).toEqual({
      key: `idea:${DIRECT_IDEA}`,
      rootIdeaUuid: ROOT_IDEA,
      directIdeaUuid: DIRECT_IDEA,
    });
  });

  it("spawns with the direct idea as session id, --session-id (new) when no transcript, cleans up", async () => {
    const { waker, spawner, writeMcpConfigFn, isNewSessionFn } = makeWaker();
    const cfg = { path: "/tmp/m.json", cleanup: vi.fn() };
    writeMcpConfigFn.mockReturnValue(cfg);

    const resolved = await waker.keyFor(TASK_NOTIF);
    await waker.wake(TASK_NOTIF, resolved.key, resolved);

    const spawnArgs = spawner.wake.mock.calls[0][0];
    expect(spawnArgs.prompt).toContain("task-1");
    expect(spawnArgs.sessionId).toBe(DIRECT_IDEA); // deterministic = direct idea uuid
    expect(spawnArgs.isNew).toBe(true); // no transcript on disk → new session
    expect(spawnArgs.cwd).toBe("/work/dir"); // same cwd threaded for probe + spawn
    expect(spawnArgs.mcpConfigPath).toBe("/tmp/m.json");
    // probe used the SAME cwd as the spawn
    expect(isNewSessionFn).toHaveBeenCalledWith(DIRECT_IDEA, "/work/dir");
    // temp config cleaned up
    expect(cfg.cleanup).toHaveBeenCalled();
  });

  it("passes isNew=false (resume) when the transcript already exists on disk", async () => {
    const { waker, spawner } = makeWaker({ isNewSessionFn: vi.fn(() => false) });
    const resolved = await waker.keyFor(TASK_NOTIF);
    await waker.wake(TASK_NOTIF, resolved.key, resolved);
    expect(spawner.wake.mock.calls[0][0].isNew).toBe(false);
    expect(spawner.wake.mock.calls[0][0].sessionId).toBe(DIRECT_IDEA);
  });

  it("logs the backend's actual session decision instead of the transcript probe hint", async () => {
    const messages = [];
    const spawner = {
      sessionDecision: { probeIsAuthoritative: false },
      wake: vi.fn(async () => ({ sessionId: "codex-thread-1", exitCode: 0, isNew: false })),
    };
    const { waker } = makeWaker({ spawner, isNewSessionFn: vi.fn(() => true) });
    waker.logger = { ...silent, info: (message) => messages.push(message) };
    const resolved = await waker.keyFor(TASK_NOTIF);
    await waker.wake(TASK_NOTIF, resolved.key, resolved);

    expect(spawner.wake.mock.calls[0][0].isNew).toBe(true);
    expect(messages).toContain(`[Chorus] dispatching session ${DIRECT_IDEA}`);
    expect(messages).toContain("[Chorus] backend resumed session codex-thread-1");
    expect(messages.join("\n")).not.toMatch(/spawning new|resuming session/);
  });

  it("falls back to a per-entity key when there's no direct idea", async () => {
    const { waker } = makeWaker({
      lineage: { resolve: async () => ({ rootIdeaUuid: null, directIdeaUuid: null }) },
    });
    const resolved = await waker.keyFor(TASK_NOTIF);
    expect(resolved.key).toBe("entity:task:task-1");
    expect(resolved.directIdeaUuid).toBeNull();
  });

  it("STILL spawns for a no-idea entity (quick task), anchoring on the entity's OWN uuid", async () => {
    // Regression guard: a task_assigned for a quick task (no proposal → no idea
    // ancestor) is the daemon's headline use case. It must still wake Claude — the
    // session is anchored on the entity's own uuid (deterministic + resumable),
    // NOT dropped because directIdeaUuid is null.
    const QUICK_TASK = "22222222-2222-4222-8222-222222222222"; // entityUuid IS a uuid
    const { waker, spawner } = makeWaker({
      lineage: { resolve: async () => ({ rootIdeaUuid: null, directIdeaUuid: null }) },
    });
    const notif = { ...TASK_NOTIF, entityType: "task", entityUuid: QUICK_TASK };
    const resolved = await waker.keyFor(notif);
    expect(resolved.key).toBe(`entity:task:${QUICK_TASK}`); // per-entity serialization
    await waker.wake(notif, resolved.key, resolved);

    expect(spawner.wake).toHaveBeenCalledTimes(1); // it DID spawn
    const args = spawner.wake.mock.calls[0][0];
    expect(args.sessionId).toBe(QUICK_TASK); // anchored on the entity's own uuid
    // snapshot still reports null root (no idea ancestor) — not the entity uuid
    expect(resolved.rootIdeaUuid).toBeNull();
  });

  it("a spawn failure is logged and does NOT throw", async () => {
    const warns = [];
    const { waker } = makeWaker({
      spawner: { wake: vi.fn(async () => { throw new Error("spawn exploded"); }) },
    });
    waker.logger = { ...silent, warn: (m) => warns.push(m) };
    const resolved = await waker.keyFor(TASK_NOTIF);
    await expect(waker.wake(TASK_NOTIF, resolved.key, resolved)).resolves.toBeUndefined();
    expect(warns.join("")).toMatch(/wake failed/);
  });

  it("invokes the onSessionStart upload hook (no-op here)", async () => {
    const onSessionStart = vi.fn(async () => {});
    const { waker } = makeWaker({
      hooks: { onSessionStart, onConnect: async () => {}, onTranscriptMessage: async () => {} },
    });
    const resolved = await waker.keyFor(TASK_NOTIF);
    await waker.wake(TASK_NOTIF, resolved.key, resolved);
    expect(onSessionStart).toHaveBeenCalledWith(
      expect.objectContaining({ rootIdeaKey: `idea:${DIRECT_IDEA}`, sessionId: DIRECT_IDEA, isNew: true })
    );
  });

  it("logs a non-zero exit visibly (no-silent-errors), still no throw", async () => {
    const warns = [];
    const { waker } = makeWaker({
      spawner: { wake: vi.fn(async ({ sessionId }) => ({ sessionId, exitCode: 2, isNew: true })) },
    });
    waker.logger = { ...silent, warn: (m) => warns.push(m) };
    const resolved = await waker.keyFor(TASK_NOTIF);
    await waker.wake(TASK_NOTIF, resolved.key, resolved);
    expect(warns.join("")).toMatch(/exited non-zero/);
  });

  it("execution snapshot reports the RESOLVED ROOT idea, NOT the direct-idea key (two-id contract)", async () => {
    // The BLOCKER regression guard: with direct ≠ root, the snapshot's rootIdeaUuid
    // must be the server-resolved root, never the direct idea carried by the key.
    let snapshotDuringRun;
    const { waker } = makeWaker({
      spawner: {
        wake: vi.fn(async ({ sessionId }) => {
          snapshotDuringRun = waker.buildExecutionSnapshot();
          return { sessionId, exitCode: 0, isNew: true };
        }),
      },
    });
    const resolved = await waker.keyFor(TASK_NOTIF);
    expect(resolved.directIdeaUuid).not.toBe(resolved.rootIdeaUuid); // precondition
    await waker.wake(TASK_NOTIF, resolved.key, resolved);

    expect(snapshotDuringRun).toHaveLength(1);
    expect(snapshotDuringRun[0].rootIdeaUuid).toBe(ROOT_IDEA); // resolved root, not DIRECT_IDEA
    expect(snapshotDuringRun[0].rootIdeaUuid).not.toBe(DIRECT_IDEA);
    expect(snapshotDuringRun[0].entityUuid).toBe("task-1");
  });

  it("markQueued reports the resolved root idea (not sliced from the key)", async () => {
    const { waker } = makeWaker();
    const resolved = await waker.keyFor(TASK_NOTIF);
    waker.markQueued(TASK_NOTIF, resolved.key, resolved);
    const snap = waker.buildExecutionSnapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].rootIdeaUuid).toBe(ROOT_IDEA);
    expect(snap[0].status).toBe("queued");
  });
});

describe("Waker.wakeBatch (coalescing §C3)", () => {
  // Two @mentions on DISTINCT child tasks that both resolve to idea D — so neither item
  // equals the session anchor idea:D. The reviewer NOTE case: the anchor is SYNTHESIZED.
  const ATTR = { key: `idea:${DIRECT_IDEA}`, rootIdeaUuid: ROOT_IDEA, directIdeaUuid: DIRECT_IDEA };
  const MENTION_A = { ...TASK_NOTIF, uuid: "a", action: "mentioned", entityType: "task", entityUuid: "task-a", message: "look at A" };
  const MENTION_B = { ...TASK_NOTIF, uuid: "b", action: "mentioned", entityType: "task", entityUuid: "task-b", message: "look at B" };
  // A synthetic control-channel resume (子3): entity-generic, NEVER a persisted notification, so
  // it creates NO server pending turn — it must NOT count toward coalescedCount (BLOCKER-2), or
  // the server's take:(coalescedCount-1) settlement over-reaches and drops a separate pending turn.
  const RESUME = { action: "resource_resumed", entityType: "task", entityUuid: "task-r" };

  // A spawner that fires onChild (where the → running turn-advance hangs off) then exits clean.
  const spawnerWithChild = () => ({
    wake: vi.fn(async ({ sessionId, onChild, onMessage }) => {
      onChild?.({ pid: 1, on: () => {}, kill: () => {} });
      onMessage?.({ type: "system", session_id: sessionId });
      return { sessionId, exitCode: 0, isNew: true };
    }),
  });

  it("spawns exactly ONE subprocess for N notifications, with the prompt built via buildBatchPrompt", async () => {
    const { waker, spawner } = makeWaker();
    await waker.wakeBatch([MENTION_A, MENTION_B], ATTR.key, ATTR);

    expect(spawner.wake).toHaveBeenCalledTimes(1); // ONE subprocess for the whole batch
    const args = spawner.wake.mock.calls[0][0];
    // The merged prompt is exactly buildBatchPrompt's output — backlog preamble + both blocks.
    expect(args.prompt).toBe(buildBatchPrompt([MENTION_A, MENTION_B]));
    expect(args.prompt).toContain("task-a");
    expect(args.prompt).toContain("task-b");
    expect(args.prompt).toContain("queued Chorus events");
    // The session anchor = the direct idea (one --resume turn).
    expect(args.sessionId).toBe(DIRECT_IDEA);
  });

  it("emits ONE running row synthesized as idea:<directIdeaUuid> (NOT one of the merged items) and drops the merged resources", async () => {
    let snapshotDuringRun;
    const { waker } = makeWaker({
      spawner: {
        wake: vi.fn(async ({ sessionId }) => {
          snapshotDuringRun = waker.buildExecutionSnapshot();
          return { sessionId, exitCode: 0, isNew: true };
        }),
      },
    });
    // The router marks each merged resource queued before enqueue — replicate that.
    waker.markQueued(MENTION_A, ATTR.key, ATTR);
    waker.markQueued(MENTION_B, ATTR.key, ATTR);
    expect(waker.buildExecutionSnapshot().map((e) => e.entityUuid).sort()).toEqual(["task-a", "task-b"]);

    await waker.wakeBatch([MENTION_A, MENTION_B], ATTR.key, ATTR);

    // During the run: exactly ONE running row = the SYNTHESIZED idea anchor — even though
    // neither merged item is idea:D.
    expect(snapshotDuringRun).toHaveLength(1);
    expect(snapshotDuringRun[0]).toMatchObject({
      entityType: "idea",
      entityUuid: DIRECT_IDEA,
      status: "running",
      rootIdeaUuid: ROOT_IDEA,
    });
    // The merged-away resources are ABSENT so reconcileSnapshot ends their queued rows.
    const uuids = snapshotDuringRun.map((e) => e.entityUuid);
    expect(uuids).not.toContain("task-a");
    expect(uuids).not.toContain("task-b");
    // After the wake everything is gone (the anchor leaves the active set too).
    expect(waker.buildExecutionSnapshot()).toHaveLength(0);
  });

  it("advances the ONE running turn keyed by sessionId and reports coalescedCount = N on the running edge", async () => {
    const advanceTurn = vi.fn(async () => {});
    const { waker } = makeWaker({ advanceTurn, spawner: spawnerWithChild() });
    await waker.wakeBatch([MENTION_A, MENTION_B], ATTR.key, ATTR);

    // Exactly one turn: running then ended.
    expect(advanceTurn.mock.calls.map((c) => c[0].status)).toEqual(["running", "ended"]);
    const running = advanceTurn.mock.calls.find((c) => c[0].status === "running")[0];
    expect(running.sessionId).toBe(DIRECT_IDEA);
    expect(running.coalescedCount).toBe(2);
    // The terminal edge carries no coalescedCount (it rides only the running-transition).
    expect(advanceTurn.mock.calls.find((c) => c[0].status === "ended")[0]).not.toHaveProperty("coalescedCount");
  });

  it("EXCLUDES a synthetic resource_resumed from coalescedCount (no server pending turn): [resource_resumed, mentionA, mentionB] → 2, not 3", async () => {
    // BLOCKER-2: the batch has 3 physical items but only 2 are TURN-BACKED (the mentions each
    // created a server pending turn; resource_resumed did not). The wire count must be 2 so the
    // server settles (2 − 1) = 1 same-session pending turn — never over-reaching into a
    // genuinely-separate post-drain turn (which it would silently mark `merged` and drop).
    const advanceTurn = vi.fn(async () => {});
    const { waker } = makeWaker({ advanceTurn, spawner: spawnerWithChild() });
    await waker.wakeBatch([RESUME, MENTION_A, MENTION_B], ATTR.key, ATTR);

    const running = advanceTurn.mock.calls.find((c) => c[0].status === "running")[0];
    expect(running.coalescedCount).toBe(2); // NOT 3
  });

  it("a batch that reduces to ONE turn-backed item after excluding resource_resumed reports 1 → omitted from the wire (no settlement)", async () => {
    // [resource_resumed, mention] → 1 turn-backed item → default 1, which the client omits from
    // the running-edge payload, so the server runs no settlement (default window of 1). The
    // batch still runs as ONE coalesced turn: a physical batch of 2 → the synthesized idea anchor.
    const advanceTurn = vi.fn(async () => {});
    const { waker } = makeWaker({ advanceTurn, spawner: spawnerWithChild() });
    await waker.wakeBatch([RESUME, MENTION_A], ATTR.key, ATTR);

    const running = advanceTurn.mock.calls.find((c) => c[0].status === "running")[0];
    expect(running).not.toHaveProperty("coalescedCount"); // 1 → omitted on the wire
    // Anchor synthesis still keys off the PHYSICAL batch size (2 > 1) — the fix touched only
    // the wire count, not the coalescing/anchor design.
    expect(running.entityType).toBe("idea");
    expect(running.entityUuid).toBe(DIRECT_IDEA);
  });

  it("a single-item batch is anchored on the item's OWN entity (ad-hoc: no idea synthesis)", async () => {
    // A batch of one keeps the item's own entity as the running row (byte-identical to the
    // pre-coalescing single wake) — the idea-anchor synthesis is a coalesced-only behavior.
    let snapshotDuringRun;
    const { waker } = makeWaker({
      spawner: {
        wake: vi.fn(async ({ sessionId }) => {
          snapshotDuringRun = waker.buildExecutionSnapshot();
          return { sessionId, exitCode: 0, isNew: true };
        }),
      },
    });
    await waker.wakeBatch([MENTION_A], ATTR.key, ATTR);
    expect(snapshotDuringRun).toHaveLength(1);
    expect(snapshotDuringRun[0].entityUuid).toBe("task-a"); // the item, NOT idea:D
  });

  it("wake(n) is a thin wakeBatch([n]) — single-wake prompt + turn accounting unchanged, coalescedCount omitted", async () => {
    const advanceTurn = vi.fn(async () => {});
    const { waker, spawner } = makeWaker({ advanceTurn, spawner: spawnerWithChild() });
    const resolved = await waker.keyFor(TASK_NOTIF);
    await waker.wake(TASK_NOTIF, resolved.key, resolved);

    // ONE subprocess; prompt byte-identical to buildPrompt(n) (== buildBatchPrompt([n])).
    expect(spawner.wake).toHaveBeenCalledTimes(1);
    expect(spawner.wake.mock.calls[0][0].prompt).toBe(buildPrompt(TASK_NOTIF));
    // The running advance carries the item's OWN entity (task-1), NOT the idea anchor, and
    // NO coalescedCount (a single wake reports 1, which the client omits).
    const running = advanceTurn.mock.calls.find((c) => c[0].status === "running")[0];
    expect(running.entityType).toBe("task");
    expect(running.entityUuid).toBe("task-1");
    expect(running).not.toHaveProperty("coalescedCount");
  });
});

describe("Waker interrupt / crash reporting (子3)", () => {
  // A child double the spawner hands to onChild.
  const FAKE_CHILD = { pid: 5555 };

  /** A spawner that registers the child (onChild) then resolves with `exitCode`. */
  function spawnerWith(exitCode, { duringRun } = {}) {
    return {
      wake: vi.fn(async ({ sessionId, onChild, onMessage }) => {
        onChild?.(FAKE_CHILD);
        onMessage?.({ type: "system", session_id: sessionId });
        if (duringRun) duringRun();
        return { sessionId, exitCode, isNew: true };
      }),
    };
  }

  it("stores the live child in the running execution entry, but the snapshot EXCLUDES it", async () => {
    let entryDuringRun;
    let snapshotDuringRun;
    const { waker } = makeWaker({
      spawner: {
        wake: vi.fn(async ({ sessionId, onChild }) => {
          onChild?.(FAKE_CHILD);
          entryDuringRun = waker.executions.get("task:task-1");
          snapshotDuringRun = waker.buildExecutionSnapshot();
          return { sessionId, exitCode: 0, isNew: true };
        }),
      },
    });
    const resolved = await waker.keyFor(TASK_NOTIF);
    await waker.wake(TASK_NOTIF, resolved.key, resolved);

    // Registry entry holds the live child handle for the interrupt path...
    expect(entryDuringRun.child).toBe(FAKE_CHILD);
    expect(entryDuringRun.status).toBe("running");
    // ...but the uploaded snapshot maps only serializable fields — NO child.
    expect(snapshotDuringRun).toHaveLength(1);
    expect(snapshotDuringRun[0]).not.toHaveProperty("child");
    expect(Object.keys(snapshotDuringRun[0]).sort()).toEqual(
      ["directIdeaUuid", "entityType", "entityUuid", "rootIdeaUuid", "startedAt", "status"].sort()
    );
  });

  it("reports interrupted(reason=user) when the control handler marked the entity interrupting", async () => {
    const { waker, reportInterrupt } = makeWaker({
      // Simulate the control handler setting the flag mid-run, then a graceful exit.
      spawner: {
        wake: vi.fn(async ({ sessionId, onChild }) => {
          onChild?.(FAKE_CHILD);
          waker.markInterrupting("task", "task-1");
          return { sessionId, exitCode: 0, isNew: true };
        }),
      },
    });
    const resolved = await waker.keyFor(TASK_NOTIF);
    await waker.wake(TASK_NOTIF, resolved.key, resolved);

    expect(reportInterrupt).toHaveBeenCalledTimes(1);
    expect(reportInterrupt).toHaveBeenCalledWith("task", "task-1", "user");
    // The interrupting flag is cleared after the wake (never leaks to the next one).
    expect(waker.interrupting.has("task:task-1")).toBe(false);
  });

  it("reports interrupted(reason=crash) on an unexpected non-zero exit with NO interrupt flag", async () => {
    const { waker, reportInterrupt } = makeWaker({ spawner: spawnerWith(2) });
    const resolved = await waker.keyFor(TASK_NOTIF);
    await waker.wake(TASK_NOTIF, resolved.key, resolved);
    expect(reportInterrupt).toHaveBeenCalledWith("task", "task-1", "crash");
  });

  it("reports crash on a null exit (spawn/transport failure) with no interrupt flag", async () => {
    const { waker, reportInterrupt } = makeWaker({ spawner: spawnerWith(null) });
    const resolved = await waker.keyFor(TASK_NOTIF);
    await waker.wake(TASK_NOTIF, resolved.key, resolved);
    expect(reportInterrupt).toHaveBeenCalledWith("task", "task-1", "crash");
  });

  it("does NOT report anything on a clean exit (code 0, no interrupt)", async () => {
    const { waker, reportInterrupt } = makeWaker({ spawner: spawnerWith(0) });
    const resolved = await waker.keyFor(TASK_NOTIF);
    await waker.wake(TASK_NOTIF, resolved.key, resolved);
    expect(reportInterrupt).not.toHaveBeenCalled();
  });

  it("a user interrupt on a non-zero exit still reports user (interrupt flag wins over crash)", async () => {
    const { waker, reportInterrupt } = makeWaker({
      spawner: {
        wake: vi.fn(async ({ sessionId, onChild }) => {
          onChild?.(FAKE_CHILD);
          waker.markInterrupting("task", "task-1"); // interrupt requested
          return { sessionId, exitCode: 137, isNew: true }; // killed (SIGKILL → 137)
        }),
      },
    });
    const resolved = await waker.keyFor(TASK_NOTIF);
    await waker.wake(TASK_NOTIF, resolved.key, resolved);
    expect(reportInterrupt).toHaveBeenCalledTimes(1);
    expect(reportInterrupt).toHaveBeenCalledWith("task", "task-1", "user");
  });

  it("a reporter that throws does NOT crash the wake (logged, swallowed)", async () => {
    const warns = [];
    const { waker } = makeWaker({
      spawner: spawnerWith(2),
      reportInterrupt: vi.fn(async () => { throw new Error("report blew up"); }),
    });
    waker.logger = { ...silent, warn: (m) => warns.push(m) };
    const resolved = await waker.keyFor(TASK_NOTIF);
    await expect(waker.wake(TASK_NOTIF, resolved.key, resolved)).resolves.toBeUndefined();
    expect(warns.join("")).toMatch(/reportInterrupt failed/);
  });

  it("markInterrupting is keyed the same as the execution registry", async () => {
    const { waker } = makeWaker();
    waker.markInterrupting("task", "task-1");
    expect(waker.interrupting.has("task:task-1")).toBe(true);
  });
});

describe("Waker graceful shutdown (fix-daemon-exit-orphan-running-turn)", () => {
  const FAKE_CHILD = { pid: 5555 };

  it("SUPPRESSES the execution crash report for a shutdown-killed subprocess (no stranded sticky rows)", async () => {
    // A shutdown-kill looks exactly like a crash to the old logic: dirty exit, no
    // user-interrupt flag. The !shuttingDown gate must keep reportInterrupt silent —
    // the execution row is reconcileOffline's job when the stream drops.
    const { waker, reportInterrupt } = makeWaker({
      spawner: {
        wake: vi.fn(async ({ sessionId, onChild }) => {
          onChild?.(FAKE_CHILD);
          waker.shuttingDown = true; // shutdown began mid-run
          return { sessionId, exitCode: 130, isNew: true }; // SIGINT-killed
        }),
      },
    });
    const resolved = await waker.keyFor(TASK_NOTIF);
    await waker.wake(TASK_NOTIF, resolved.key, resolved);
    expect(reportInterrupt).not.toHaveBeenCalled();
  });

  it("a USER interrupt during shutdown still reports the execution (sticky resumability preserved)", async () => {
    const { waker, reportInterrupt } = makeWaker({
      spawner: {
        wake: vi.fn(async ({ sessionId, onChild }) => {
          onChild?.(FAKE_CHILD);
          waker.markInterrupting("task", "task-1");
          waker.shuttingDown = true;
          return { sessionId, exitCode: 130, isNew: true };
        }),
      },
    });
    const resolved = await waker.keyFor(TASK_NOTIF);
    await waker.wake(TASK_NOTIF, resolved.key, resolved);
    expect(reportInterrupt).toHaveBeenCalledWith("task", "task-1", "user");
  });

  it("outside shutdown the crash report is byte-for-byte unchanged", async () => {
    const { waker, reportInterrupt } = makeWaker({
      spawner: {
        wake: vi.fn(async ({ sessionId, onChild }) => {
          onChild?.(FAKE_CHILD);
          return { sessionId, exitCode: 2, isNew: true };
        }),
      },
    });
    const resolved = await waker.keyFor(TASK_NOTIF);
    await waker.wake(TASK_NOTIF, resolved.key, resolved);
    expect(reportInterrupt).toHaveBeenCalledWith("task", "task-1", "crash");
  });

  it("interruptAll sets shuttingDown and kills every live running child via the injected killer", async () => {
    const killer = vi.fn(async () => ({ killed: true }));
    let interruptAllRan;
    const { waker } = makeWaker({
      spawner: {
        wake: vi.fn(async ({ sessionId, onChild }) => {
          onChild?.(FAKE_CHILD);
          // Simulate the daemon's stop() firing while this wake is live.
          waker.interruptAll();
          interruptAllRan = {
            shuttingDown: waker.shuttingDown,
            killerCalls: killer.mock.calls.length,
          };
          return { sessionId, exitCode: 130, isNew: true };
        }),
      },
    });
    waker.killer = killer;
    waker.sigintTimeoutMs = 1234;
    const resolved = await waker.keyFor(TASK_NOTIF);
    await waker.wake(TASK_NOTIF, resolved.key, resolved);

    expect(interruptAllRan.shuttingDown).toBe(true);
    expect(interruptAllRan.killerCalls).toBe(1);
    expect(killer).toHaveBeenCalledWith(
      FAKE_CHILD,
      expect.objectContaining({ sigintTimeoutMs: 1234 }),
    );
  });

  it("interruptAll skips queued entries (no child yet) and is idempotent", async () => {
    const killer = vi.fn(async () => ({ killed: true }));
    const { waker } = makeWaker();
    waker.killer = killer;
    // A queued entry (no live child) — nothing to kill.
    waker.markQueued(TASK_NOTIF, "idea:x", { rootIdeaUuid: null });
    waker.interruptAll();
    waker.interruptAll();
    expect(waker.shuttingDown).toBe(true);
    expect(killer).not.toHaveBeenCalled();
  });

  it("a rejecting killer never throws out of interruptAll (logged)", async () => {
    const warns = [];
    const { waker } = makeWaker();
    waker.logger = { ...silent, warn: (m) => warns.push(m) };
    waker.killer = vi.fn(() => Promise.reject(new Error("kill blew up")));
    waker.executions.set("task:task-1", {
      entityType: "task",
      entityUuid: "task-1",
      rootIdeaUuid: null,
      status: "running",
      startedAt: null,
      child: FAKE_CHILD,
    });
    expect(() => waker.interruptAll()).not.toThrow();
    await Promise.resolve(); // let the rejection propagate to the .catch
    expect(warns.join("")).toMatch(/killProcessTree rejected/);
  });
});

describe("EventRouter dispatch", () => {
  function makeRouter(notifications, waker, queue, seen) {
    const mcpClient = { callTool: vi.fn(async () => ({ notifications })) };
    const router = new EventRouter({
      mcpClient,
      waker,
      queue,
      wakeActions: WAKE_ACTIONS,
      seen,
      logger: silent,
    });
    return { router, mcpClient };
  }

  it("routes a task_assigned notification onto the queue under its direct-idea key, as a DATA payload", async () => {
    const enqueued = [];
    const queue = { enqueue: (key, item) => enqueued.push({ key, item }) };
    const attribution = { key: `idea:${DIRECT_IDEA}`, rootIdeaUuid: ROOT_IDEA, directIdeaUuid: DIRECT_IDEA };
    const waker = {
      keyFor: vi.fn(async () => attribution),
      markQueued: vi.fn(),
      wakeBatch: vi.fn(async () => {}),
    };
    const { router } = makeRouter([TASK_NOTIF], waker, queue);

    router.dispatch({ type: "new_notification", notificationUuid: "notif-1" });
    await new Promise((r) => setTimeout(r, 0));

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].key).toBe(`idea:${DIRECT_IDEA}`);
    // markQueued got the resolved attribution (so the snapshot can report the root)
    expect(waker.markQueued).toHaveBeenCalledWith(TASK_NOTIF, `idea:${DIRECT_IDEA}`, attribution);
    // The enqueued value is now the opaque DATA item { notification, attribution } — NOT a
    // thunk. The queue coalesces same-key items and hands the batch to runBatch → wakeBatch
    // (wired in daemon.mjs); the router no longer invokes the waker directly.
    expect(enqueued[0].item).toEqual({ notification: TASK_NOTIF, attribution });
  });

  it("ignores non-new_notification events and non-wake actions", async () => {
    const queue = { enqueue: vi.fn() };
    const waker = { keyFor: vi.fn(), wake: vi.fn() };
    const { router } = makeRouter([{ ...TASK_NOTIF, action: "count_update" }], waker, queue);

    router.dispatch({ type: "count_update" });
    router.dispatch({ type: "new_notification", notificationUuid: "notif-1" });
    await new Promise((r) => setTimeout(r, 0));

    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("de-dupes a notification already handled (shared seen set) — no double wake on reconnect", async () => {
    const enqueued = [];
    const queue = { enqueue: (key, task) => enqueued.push({ key, task }) };
    const waker = {
      keyFor: vi.fn(async () => ({ key: `idea:${DIRECT_IDEA}`, rootIdeaUuid: ROOT_IDEA, directIdeaUuid: DIRECT_IDEA })),
      markQueued: vi.fn(),
      wake: vi.fn(async () => {}),
    };
    const seen = new Set();
    const { router } = makeRouter([TASK_NOTIF], waker, queue, seen);

    // Live delivery, then a reconnect-backfill re-dispatch of the SAME uuid.
    router.dispatch({ type: "new_notification", notificationUuid: "notif-1" });
    router.dispatch({ type: "new_notification", notificationUuid: "notif-1" });
    await new Promise((r) => setTimeout(r, 0));

    expect(enqueued).toHaveLength(1); // only one wake despite two dispatches
    expect(seen.has("notif-1")).toBe(true);
  });

  it("coalesces same-key dispatches that pile up during a running batch into ONE wakeBatch → ONE subprocess", async () => {
    // Router → queue → waker.wakeBatch integration (add-daemon-wake-coalescing §C1/§C4).
    // The first batch is held open on a gate so later same-key dispatches pile up; when the
    // slot frees they drain together into ONE coalesced batch (one subprocess, one prompt).
    let started = 0;
    let release;
    const gate = new Promise((r) => (release = r));
    const prompts = [];
    const spawner = {
      wake: vi.fn(async ({ sessionId, prompt, onChild }) => {
        started++;
        prompts.push(prompt);
        onChild?.({ pid: started, on: () => {}, kill: () => {} }); // fires the → running turn-advance
        if (started === 1) await gate; // hold batch #1 open
        return { sessionId, exitCode: 0, isNew: true };
      }),
    };
    const advanceTurn = vi.fn(async () => {});
    // All notifications resolve to the SAME direct idea → same key.
    const { waker } = makeWaker({
      spawner,
      advanceTurn,
      lineage: { resolve: async () => ({ rootIdeaUuid: ROOT_IDEA, directIdeaUuid: DIRECT_IDEA }) },
    });
    const queue = new WakeQueue({
      logger: silent,
      runBatch: (key, items) => waker.wakeBatch(items.map((i) => i.notification), key, items[0].attribution),
    });
    const notifA = { ...TASK_NOTIF, uuid: "a", entityUuid: "task-a" };
    const notifB = { ...TASK_NOTIF, uuid: "b", entityUuid: "task-b" };
    const notifC = { ...TASK_NOTIF, uuid: "c", entityUuid: "task-c" };
    const { router } = makeRouter([notifA, notifB, notifC], waker, queue);

    router.dispatch({ type: "new_notification", notificationUuid: "a" });
    await new Promise((r) => setTimeout(r, 15)); // batch [a] is running, hanging on the gate
    expect(spawner.wake).toHaveBeenCalledTimes(1);

    // Two more same-key dispatches while [a] runs → they MUST coalesce into ONE batch.
    router.dispatch({ type: "new_notification", notificationUuid: "b" });
    router.dispatch({ type: "new_notification", notificationUuid: "c" });
    await new Promise((r) => setTimeout(r, 15));
    expect(spawner.wake).toHaveBeenCalledTimes(1); // still serialized — nothing new spawned

    release();
    await new Promise((r) => setTimeout(r, 15));
    expect(spawner.wake).toHaveBeenCalledTimes(2); // [a], then the coalesced [b,c] — ONE more

    // The coalesced batch's single prompt merged BOTH b and c under one backlog preamble.
    const coalesced = prompts[1];
    expect(coalesced).toContain("task-b");
    expect(coalesced).toContain("task-c");
    expect(coalesced).toContain("queued Chorus events");
    // coalescedCount = 2 is reported on the coalesced batch's running edge (single wakes omit it).
    const runningAdvances = advanceTurn.mock.calls.filter((c) => c[0].status === "running");
    expect(runningAdvances.some((c) => c[0].coalescedCount === 2)).toBe(true);
    expect(runningAdvances.filter((c) => "coalescedCount" in c[0])).toHaveLength(1); // only the batch of 2
  });

  it("a human_instruction and an autonomous wake for the same session land on one key and merge", async () => {
    // Q3: chat backlog coalesces WITH autonomous events. A human_instruction (turn-keyed
    // dispatch) and a mention (notification path) for the same session share the direct-idea
    // key, so a held batch lets them pile up and drain together as one coalesced turn.
    let started = 0;
    let release;
    const gate = new Promise((r) => (release = r));
    const prompts = [];
    const spawner = {
      wake: vi.fn(async ({ sessionId, prompt }) => {
        started++;
        prompts.push(prompt);
        if (started === 1) await gate;
        return { sessionId, exitCode: 0, isNew: true };
      }),
    };
    const { waker } = makeWaker({
      spawner,
      lineage: { resolve: async () => ({ rootIdeaUuid: ROOT_IDEA, directIdeaUuid: DIRECT_IDEA }) },
    });
    const queue = new WakeQueue({
      logger: silent,
      runBatch: (key, items) => waker.wakeBatch(items.map((i) => i.notification), key, items[0].attribution),
    });
    const mention = { ...TASK_NOTIF, uuid: "m1", action: "mentioned", entityType: "idea", entityUuid: DIRECT_IDEA, message: "hey look" };
    const { router } = makeRouter([mention], waker, queue);

    // Batch #1 opens on a human_instruction and hangs on the gate.
    router.dispatchPendingTurn({
      turnUuid: "t-hold",
      sessionId: DIRECT_IDEA,
      directIdeaUuid: DIRECT_IDEA,
      trigger: "human_instruction",
      promptText: "first instruction (holds the slot)",
    });
    await new Promise((r) => setTimeout(r, 15));
    expect(spawner.wake).toHaveBeenCalledTimes(1);

    // While it runs: a second human_instruction AND an autonomous mention, same session.
    router.dispatchPendingTurn({
      turnUuid: "t-2",
      sessionId: DIRECT_IDEA,
      directIdeaUuid: DIRECT_IDEA,
      trigger: "human_instruction",
      promptText: "deploy the retry fix now",
    });
    router.dispatch({ type: "new_notification", notificationUuid: "m1" });
    await new Promise((r) => setTimeout(r, 15));
    expect(spawner.wake).toHaveBeenCalledTimes(1); // both piled up on the same key

    release();
    await new Promise((r) => setTimeout(r, 15));
    expect(spawner.wake).toHaveBeenCalledTimes(2); // ONE coalesced batch for the chat + mention

    const merged = prompts[1];
    expect(merged).toContain("deploy the retry fix now"); // human_instruction body, in full
    expect(merged).toContain("hey look"); // the autonomous mention merged in
    expect(merged).toContain("queued Chorus events"); // backlog preamble
  });

  it("dispatchResume stamps resumedFrom on the synthetic wake only for known reasons (add-crash-execution-resume)", async () => {
    const enqueued = [];
    const queue = { enqueue: (key, task) => enqueued.push({ key, task }) };
    const attribution = { key: `idea:${DIRECT_IDEA}`, rootIdeaUuid: ROOT_IDEA, directIdeaUuid: DIRECT_IDEA };
    const waker = {
      keyFor: vi.fn(async () => attribution),
      markQueued: vi.fn(),
      wake: vi.fn(async () => {}),
    };
    const { router } = makeRouter([], waker, queue);

    router.dispatchResume({ entityType: "task", entityUuid: "task-1", resumeReason: "crash" });
    router.dispatchResume({ entityType: "task", entityUuid: "task-2", resumeReason: "user" });
    router.dispatchResume({ entityType: "task", entityUuid: "task-3" });
    router.dispatchResume({ entityType: "task", entityUuid: "task-4", resumeReason: "meteor" });
    await new Promise((r) => setTimeout(r, 0));

    expect(enqueued).toHaveLength(4);
    const wakes = waker.markQueued.mock.calls.map((c) => c[0]);
    expect(wakes[0]).toMatchObject({ action: "resource_resumed", entityUuid: "task-1", resumedFrom: "crash" });
    expect(wakes[1]).toMatchObject({ action: "resource_resumed", entityUuid: "task-2", resumedFrom: "user" });
    // Absent / unknown reasons are NOT stamped — buildPrompt then falls back to the user text.
    expect(wakes[2]).not.toHaveProperty("resumedFrom");
    expect(wakes[3]).not.toHaveProperty("resumedFrom");
  });
});

// add-daemon-headless-interaction-guard — integration checkpoint: the convergence of
// BOTH changes (preamble in prompts.mjs + env signal in claude-spawner.mjs) on the real
// wake chain. Uses the REAL ClaudeSpawner (not the mocked one above) wired to a fake
// child, driven by a real Waker, so we assert the whole flow in one place:
// notification → buildPrompt(preamble+body) → spawn with CHORUS_DAEMON_HEADLESS=1 →
// prompt over stdin → NDJSON parsed → clean exit.
describe("headless guard — end-to-end wake flow (real Waker + real ClaudeSpawner)", () => {
  function makeFakeChild() {
    const child = new EventEmitter();
    const stdin = new EventEmitter();
    stdin.writes = [];
    stdin.write = (c) => stdin.writes.push(String(c));
    stdin.end = vi.fn();
    child.stdin = stdin;
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter();
    child.stderr.setEncoding = () => {};
    return child;
  }

  it("preamble+body reaches stdin AND CHORUS_DAEMON_HEADLESS=1 reaches the spawn env, in one flow", async () => {
    const child = makeFakeChild();
    // Drive the child reactively the moment it's spawned: Waker.wake awaits several
    // steps (lineage, writeMcpConfig, onSessionStart) BEFORE spawning, so emitting
    // synchronously from the test body would fire before any listener is attached.
    const spawnImpl = vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.emit("data", `{"type":"system","session_id":"${DIRECT_IDEA}"}\n`);
        child.emit("close", 0);
      });
      return child;
    });
    const spawner = new ClaudeSpawner({
      claudePath: "/usr/bin/claude",
      spawnImpl,
      logger: silent,
      platform: "linux",
    });
    const waker = new Waker({
      creds: { url: "https://c", apiKey: "cho_x" },
      lineage: { resolve: async () => ({ rootIdeaUuid: ROOT_IDEA, directIdeaUuid: DIRECT_IDEA }) },
      spawner, // the REAL spawner
      cwd: "/work/dir",
      hooks: createNoopUploadHooks(),
      logger: silent,
      writeMcpConfigFn: vi.fn(() => ({ path: "/tmp/m.json", cleanup: vi.fn() })),
      isNewSessionFn: vi.fn(() => true),
    });

    const resolved = await waker.keyFor(TASK_NOTIF);
    await waker.wake(TASK_NOTIF, resolved.key, resolved);

    expect(spawnImpl).toHaveBeenCalledTimes(1);
    const [, argv, opts] = spawnImpl.mock.calls[0];
    // env signal present (task 2)
    expect(opts.env.CHORUS_DAEMON_HEADLESS).toBe("1");
    // argv carries the session id, never the prompt
    expect(argv).toContain("--session-id");
    expect(argv).toContain(DIRECT_IDEA);
    // the prompt that reached stdin is preamble + the task_assigned body (task 1)
    const stdinPrompt = child.stdin.writes.join("");
    expect(stdinPrompt.startsWith(HEADLESS_PREAMBLE)).toBe(true);
    expect(stdinPrompt).toContain("AskUserQuestion"); // headless guard text
    expect(stdinPrompt).toContain("task-1"); // per-action body intact
    expect(stdinPrompt).toContain("chorus_claim_task");
    expect(child.stdin.end).toHaveBeenCalled();
  });

  it("a null-prompt action (count_update) never spawns a subprocess", async () => {
    const spawnImpl = vi.fn();
    const spawner = new ClaudeSpawner({ claudePath: "/usr/bin/claude", spawnImpl, logger: silent, platform: "linux" });
    const waker = new Waker({
      creds: { url: "https://c", apiKey: "cho_x" },
      lineage: { resolve: async () => ({ rootIdeaUuid: ROOT_IDEA, directIdeaUuid: DIRECT_IDEA }) },
      spawner,
      cwd: "/work/dir",
      hooks: createNoopUploadHooks(),
      logger: silent,
      writeMcpConfigFn: vi.fn(() => ({ path: "/tmp/m.json", cleanup: vi.fn() })),
      isNewSessionFn: vi.fn(() => true),
    });
    const notif = { ...TASK_NOTIF, action: "count_update" };
    const resolved = await waker.keyFor(notif);
    await waker.wake(notif, resolved.key, resolved);
    expect(spawnImpl).not.toHaveBeenCalled(); // no contentless spawn
  });
});
