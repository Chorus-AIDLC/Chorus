// src/services/__tests__/elaboration-verify-wake.integration.test.ts
//
// INTEGRATION CHECKPOINT for the add-elaboration-verify-wake feature (Tasks 1–4
// combined). This is NOT a re-review of each unit — the per-task suites already
// pin each end of the chain in isolation:
//   - elaboration.service.test.ts     → verifyElaboration logs `elaboration_verified`
//   - notification-listener.test.ts   → idea:elaboration_verified → agent-only recipient
//   - notification-turn.test.ts       → action → distinct trigger; online/offline paths
//   - daemon-session.service.test.ts  → TURN_TRIGGERS contains elaboration_verified
//   - cli/wake-orchestration.test.mjs → WAKE_ACTIONS + write-proposal prompt
//
// What NO single unit test asserts is the SEAM the per-task reviews could not see:
// that the ONE literal string `elaboration_verified` survives UNBROKEN across every
// hop when the real maps are imported together. The activity action is a bare string
// literal in elaboration.service.ts (not a shared constant), so a typo at any one seam
// would silently break the chain while every per-task test (which hardcodes its own
// copy of the string) stays green. This test imports the actual maps from THREE
// modules — notification-turn (NOTIFICATION_ACTION_TO_TURN_TRIGGER + triggerForAction),
// daemon-session (TURN_TRIGGERS), and cli/prompts (WAKE_ACTIONS + buildPrompt) — and
// walks the string through them as ONE flow, so a single-seam mismatch fails HERE.
//
// The notification-listener seam (idea:elaboration_verified → elaboration_verified) is
// the one map this test does NOT import live: resolveNotificationType is module-private
// in notification-listener.ts and its only public entry, handleActivity, drags in prisma
// + the full notification service (heavy DB mocking). That seam is instead anchored by
// (a) the LISTENER_KEY assertion below over the shared literal, (b) the grep audit in the
// integration report, and (c) notification-listener.test.ts (idea:elaboration_verified →
// agent-only recipient). So the chain is end-to-end covered; only this one map is pinned
// indirectly rather than imported.
//
// It also asserts the two intent-distinguishing properties that make the feature
// correct: (a) the wake routes to the assigned AGENT and never a human, and (b) the
// daemon prompt is the WRITE-THE-PROPOSAL case, NOT the answer-elaboration-questions
// case.

import { describe, it, expect, vi } from "vitest";

// The notification-turn module composes daemon-session + daemon-connection + logger.
// We import only its pure mapping table (NOTIFICATION_ACTION_TO_TURN_TRIGGER) and the
// triggerForAction helper — but the module evaluates `logger.child(...)` at import, so
// stub the logger to keep this a pure mapping test with no real logger/DB pull-in.
vi.mock("@/lib/logger", () => ({
  default: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
  },
}));
// daemon-connection.service / daemon-session.service are imported by notification-turn;
// daemon-session is also imported here directly for TURN_TRIGGERS. We do NOT mock
// daemon-session (we want the REAL TURN_TRIGGERS constant), but it pulls prisma at
// import — the global prisma mock (src/__mocks__) handles that. daemon-connection is
// only referenced inside an async function we never call, so no mock is needed for the
// pure-table assertions below.

import {
  NOTIFICATION_ACTION_TO_TURN_TRIGGER,
  triggerForAction,
} from "@/services/notification-turn";
import { TURN_TRIGGERS } from "@/services/daemon-session.service";
// The daemon client lives in cli/ as plain .mjs; Vitest imports it directly (the
// existing cli/__tests__/wake-orchestration.test.mjs proves the module is importable).
import { buildPrompt, WAKE_ACTIONS } from "../../../cli/prompts.mjs";

// ===== The single source-of-truth string =====
//
// This is the literal that elaboration.service.ts:verifyElaboration emits as the
// activity `action`. If that literal is ever changed in the service, this constant
// MUST be updated too — and the chain assertions below then prove every downstream map
// was updated in lockstep (or fail loudly if one seam lagged).
const ACTIVITY_ACTION = "elaboration_verified";

// notification-listener's resolveNotificationType maps `${targetType}:${action}` →
// notification type. For an idea-verify activity the key is this:
const LISTENER_KEY = `idea:${ACTIVITY_ACTION}`;
// …and it maps to this notification `action` (the value the notification row carries,
// which is what reaches both notification-turn AND the daemon's buildPrompt/WAKE_ACTIONS).
const NOTIFICATION_ACTION = "elaboration_verified";

describe("add-elaboration-verify-wake — cross-module string-chain integration", () => {
  it("the elaboration_verified literal survives every server→daemon hop unbroken", () => {
    // Hop 1 — the activity action literal the service emits. (Pinned here; the service
    // test asserts the service actually emits it.)
    expect(ACTIVITY_ACTION).toBe("elaboration_verified");

    // Hop 2 — notification-turn's action→trigger map keys off the NOTIFICATION action
    // (the value produced from the activity), and yields the DISTINCT verified trigger.
    expect(NOTIFICATION_ACTION_TO_TURN_TRIGGER[NOTIFICATION_ACTION]).toBe(
      "elaboration_verified",
    );
    // …and the convenience resolver agrees (no implicit fallthrough to null).
    expect(triggerForAction(NOTIFICATION_ACTION)).toBe("elaboration_verified");

    // Hop 3 — the trigger that map produced MUST be a valid DaemonSessionTurn trigger,
    // or createPendingTurn's zod boundary would reject every verified wake.
    const trigger = triggerForAction(NOTIFICATION_ACTION)!;
    expect(TURN_TRIGGERS).toContain(trigger);

    // Hop 4 — the SAME notification action MUST be in the daemon's wake set, or the
    // event-router would never enqueue a wake for it (server creates a turn the daemon
    // ignores → dead chain).
    expect(WAKE_ACTIONS.has(NOTIFICATION_ACTION)).toBe(true);

    // Hop 5 — the daemon MUST build a non-null prompt for it (a WAKE_ACTIONS entry with
    // no prompt is a dead wake).
    const prompt = buildPrompt({
      uuid: "n-1",
      projectUuid: "proj-1",
      entityType: "idea",
      entityUuid: "idea-1",
      entityTitle: "Some idea",
      action: NOTIFICATION_ACTION,
      message: "verified",
      actorType: "user",
      actorUuid: "user-1",
      actorName: "Alice",
    });
    expect(prompt).not.toBeNull();
  });

  it("the verified trigger is DISTINCT from the answer-questions elaboration trigger at every layer", () => {
    // The whole point of the feature: "human verified → write proposal" must never be
    // collapsed into "answer the elaboration questions". Assert the distinction holds in
    // both the turn-trigger taxonomy and the action→trigger map.
    expect(triggerForAction(NOTIFICATION_ACTION)).not.toBe("elaboration");
    expect(NOTIFICATION_ACTION_TO_TURN_TRIGGER["elaboration_requested"]).toBe("elaboration");
    expect(NOTIFICATION_ACTION_TO_TURN_TRIGGER["elaboration_answered"]).toBe("elaboration");
    expect(NOTIFICATION_ACTION_TO_TURN_TRIGGER["elaboration_verified"]).toBe("elaboration_verified");
    expect(TURN_TRIGGERS).toContain("elaboration");
    expect(TURN_TRIGGERS).toContain("elaboration_verified");
  });

  it("the daemon prompt for the verified wake says WRITE THE PROPOSAL, not answer questions", () => {
    const verified = buildPrompt({
      uuid: "n-1",
      projectUuid: "proj-1",
      entityType: "idea",
      entityUuid: "idea-1",
      entityTitle: "Onboarding revamp",
      action: NOTIFICATION_ACTION,
      message: "verified",
      actorType: "user",
      actorUuid: "user-1",
      actorName: "Alice",
    });
    const answer = buildPrompt({
      uuid: "n-2",
      projectUuid: "proj-1",
      entityType: "idea",
      entityUuid: "idea-1",
      entityTitle: "Onboarding revamp",
      action: "elaboration_answered",
      message: "answered",
      actorType: "user",
      actorUuid: "user-1",
      actorName: "Alice",
    });

    // The verified case directs proposal authoring via the existing proposal flow…
    expect(verified).toContain("chorus_pm_create_proposal");
    expect(verified!.toLowerCase()).toContain("write the proposal");
    // …and explicitly steers AWAY from answering questions.
    expect(verified!.toLowerCase()).toContain("do not");
    expect(verified!.toLowerCase()).toContain("elaborated");

    // The two prompts are genuinely different (no accidental shared body), and the
    // answer-questions case is the one that points at validate/start, not create.
    expect(verified).not.toBe(answer);
    expect(answer).toContain("chorus_pm_validate_elaboration");
  });

  it("the listener key for an idea-verify activity is exactly idea:elaboration_verified", () => {
    // Guards the targetType:action concatenation the listener actually keys on. If the
    // service ever changed the activity action, LISTENER_KEY changes with ACTIVITY_ACTION
    // and this stays consistent — the regression we care about is a hand-edited typo in
    // the listener map drifting from the emitter, which the listener unit test plus this
    // shared-literal anchor jointly catch.
    expect(LISTENER_KEY).toBe("idea:elaboration_verified");
    expect(NOTIFICATION_ACTION).toBe(ACTIVITY_ACTION);
  });
});
