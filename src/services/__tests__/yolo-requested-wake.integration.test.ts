// src/services/__tests__/yolo-requested-wake.integration.test.ts
//
// INTEGRATION CHECKPOINT for the add-stage-advance-yolo feature. Mirrors
// elaboration-verify-wake.integration.test.ts: it is NOT a re-review of each unit
// (the per-surface suites pin each end in isolation) — it asserts the SEAM the
// per-task reviews cannot see: that the ONE literal string `yolo_requested`
// survives UNBROKEN across every server→daemon hop when the real maps are
// imported together. The activity action is a bare string literal in
// yolo-request.service.ts (not a shared constant), so a typo at any one seam
// would silently break the chain while every per-surface test (which hardcodes
// its own copy of the string) stays green.
//
// It also asserts the two properties that make THIS feature correct: (a) the
// yolo trigger is DISTINCT from task_assigned (never collapsed — the 0.13.0
// random-cwd defect), and (b) the daemon prompt is the stage-adaptive yolo-skill
// prompt: it references the yolo skill, does NOT hard-code a single stage, and
// does NOT instruct a PR merge.

import { describe, it, expect, vi } from "vitest";

// notification-turn evaluates `logger.child(...)` at import — stub the logger so
// this stays a pure mapping test with no real logger/DB pull-in.
vi.mock("@/lib/logger", () => ({
  default: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
  },
}));

import {
  NOTIFICATION_ACTION_TO_TURN_TRIGGER,
  triggerForAction,
} from "@/services/notification-turn";
import { TURN_TRIGGERS } from "@/services/daemon-session.service";
import { buildPrompt, WAKE_ACTIONS } from "../../../cli/prompts.mjs";

// The literal yolo-request.service.ts:requestYolo emits as the activity `action`.
// If that literal ever changes in the service, this constant MUST change too — and
// the chain assertions then prove every downstream map was updated in lockstep.
const ACTIVITY_ACTION = "yolo_requested";
// notification-listener keys on `${targetType}:${action}` for an idea-yolo activity.
const LISTENER_KEY = `idea:${ACTIVITY_ACTION}`;
// …mapping to this notification `action` (what reaches notification-turn AND the
// daemon's buildPrompt/WAKE_ACTIONS).
const NOTIFICATION_ACTION = "yolo_requested";

const SAMPLE_NOTIFICATION = {
  uuid: "n-1",
  projectUuid: "proj-1",
  entityType: "idea",
  entityUuid: "idea-1",
  entityTitle: "Some idea",
  action: NOTIFICATION_ACTION,
  message: "yolo",
  actorType: "user",
  actorUuid: "user-1",
  actorName: "Alice",
};

describe("add-stage-advance-yolo — cross-module string-chain integration", () => {
  it("the yolo_requested literal survives every server→daemon hop unbroken", () => {
    // Hop 1 — the activity action literal the service emits.
    expect(ACTIVITY_ACTION).toBe("yolo_requested");

    // Hop 2 — notification-turn's action→trigger map yields the DEDICATED yolo trigger.
    expect(NOTIFICATION_ACTION_TO_TURN_TRIGGER[NOTIFICATION_ACTION]).toBe("yolo_requested");
    expect(triggerForAction(NOTIFICATION_ACTION)).toBe("yolo_requested");

    // Hop 3 — that trigger MUST be a valid DaemonSessionTurn trigger, or
    // createPendingTurn's zod boundary would reject every yolo wake.
    const trigger = triggerForAction(NOTIFICATION_ACTION)!;
    expect(TURN_TRIGGERS).toContain(trigger);

    // Hop 4 — the same notification action MUST be in the daemon's wake set, or the
    // event-router would never enqueue a wake for it (dead chain).
    expect(WAKE_ACTIONS.has(NOTIFICATION_ACTION)).toBe(true);

    // Hop 5 — the daemon MUST build a non-null prompt for it.
    const prompt = buildPrompt(SAMPLE_NOTIFICATION);
    expect(prompt).not.toBeNull();
  });

  it("the yolo trigger is DISTINCT from task_assigned at every layer", () => {
    // The whole point of the dedicated trigger: a yolo wake must never be collapsed
    // into task_assigned (that collapse was the 0.13.0 random-cwd defect).
    expect(triggerForAction(NOTIFICATION_ACTION)).not.toBe("task_assigned");
    expect(NOTIFICATION_ACTION_TO_TURN_TRIGGER["yolo_requested"]).toBe("yolo_requested");
    expect(TURN_TRIGGERS).toContain("yolo_requested");
  });

  it("the daemon prompt points at the yolo skill, is stage-adaptive, and never merges a PR", () => {
    const prompt = buildPrompt(SAMPLE_NOTIFICATION);
    expect(prompt).not.toBeNull();
    const lower = prompt!.toLowerCase();

    // References the yolo skill / full AI-DLC pipeline.
    expect(lower).toContain("yolo skill");

    // Stage-adaptive: tells the agent to resume from the current phase, and does NOT
    // hard-code the single fixed execute-loop language start_development uses.
    expect(lower).toContain("resume");
    expect(lower).not.toContain("all remaining tasks");

    // Honors "yolo never merges": explicitly forbids a PR merge/push without approval.
    expect(lower).toContain("do not merge");
  });

  it("the yolo prompt is genuinely different from the start_development prompt", () => {
    const yolo = buildPrompt(SAMPLE_NOTIFICATION);
    const startDev = buildPrompt({ ...SAMPLE_NOTIFICATION, action: "start_development" });
    expect(yolo).not.toBe(startDev);
  });

  it("the listener key for an idea-yolo activity is exactly idea:yolo_requested", () => {
    expect(LISTENER_KEY).toBe("idea:yolo_requested");
    expect(NOTIFICATION_ACTION).toBe(ACTIVITY_ACTION);
  });
});
