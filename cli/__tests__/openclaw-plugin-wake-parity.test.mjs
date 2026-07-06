// cli/__tests__/openclaw-plugin-wake-parity.test.mjs
//
// LOCKSTEP GUARD (sync-openclaw-plugin-wake-events, elaboration q3=a): the CLI daemon
// (cli/prompts.mjs) and the OpenClaw plugin (packages/openclaw-plugin/src/event-router.ts)
// each maintain their OWN notification-action router — the plugin is a separately-published
// npm package that cannot import from cli/, so the two cannot share code and drift apart in
// practice (the plugin fell 3 wake actions behind the daemon, which this idea fixed).
//
// This guard makes the mirror ENFORCED, not merely documented: it asserts the plugin's
// handled-action set is a SUPERSET of the daemon's wake-action set, minus the two actions the
// plugin routes OFF the notification switch by design. It lives in cli/__tests__/ because the
// root vitest.config.ts `include` covers `cli/**/__tests__/**/*.test.mjs` but its `exclude`
// lists `packages` — so a guard here runs in the main CI and can read BOTH sources.
//
// It checks ACTION COVERAGE ONLY, never prompt-text equality: q4=c deliberately lets the two
// hosts word their prompts differently (the plugin keeps its own voice; no headless preamble).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { WAKE_ACTIONS } from "../prompts.mjs";

// Repo root is two levels up from cli/__tests__/. Resolve the plugin source path from the
// test file's own URL so the test is CWD-independent (Vitest may run from repo root or cli/).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROUTER = path.resolve(
  HERE,
  "..",
  "..",
  "packages",
  "openclaw-plugin",
  "src",
  "event-router.ts",
);

// Actions the plugin handles OFF the notification `switch` by design, so they are NOT expected
// as `case` labels in event-router.ts:
//   - resource_resumed  → arrives on the reverse CONTROL channel (control-handler.ts `resume`),
//     never as a persisted notification.
//   - human_instruction → delivered via the `deliver_turn` / pending-turn sweep (daemon-client.ts),
//     not the notification wake path.
// Both are the deferred degraded-parity follow-up; excluding them keeps this guard focused on
// the notification-router coverage invariant.
const CONTROL_OR_TURN_DELIVERED = new Set(["resource_resumed", "human_instruction"]);

/** Parse the plugin router's handled notification actions from its `case "<action>":` labels. */
function parsePluginHandledActions(source) {
  const handled = new Set();
  const re = /case\s+"([a-z_]+)"\s*:/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    handled.add(m[1]);
  }
  return handled;
}

describe("OpenClaw plugin ↔ daemon wake-action parity (lockstep guard)", () => {
  const source = readFileSync(PLUGIN_ROUTER, "utf8");
  const pluginHandled = parsePluginHandledActions(source);

  it("plugin handled-actions ⊇ daemon WAKE_ACTIONS minus the control/turn-delivered actions", () => {
    const required = [...WAKE_ACTIONS].filter((a) => !CONTROL_OR_TURN_DELIVERED.has(a));
    const missing = required.filter((a) => !pluginHandled.has(a));
    expect(
      missing,
      `packages/openclaw-plugin/src/event-router.ts is missing wake actions the daemon handles: ${missing.join(", ")}. ` +
        `Add a case + handler for each (or, if it is delivered off the notification switch, add it to CONTROL_OR_TURN_DELIVERED).`,
    ).toEqual([]);
  });

  it("covers the three stage-advance actions this change added", () => {
    for (const a of ["elaboration_verified", "start_development", "yolo_requested"]) {
      expect(pluginHandled.has(a), `plugin router should handle "${a}"`).toBe(true);
    }
  });

  it("sanity: the parser found the pre-existing handled actions too", () => {
    // Guards against a broken regex silently making the superset check vacuous.
    for (const a of ["task_assigned", "mentioned", "proposal_approved"]) {
      expect(pluginHandled.has(a), `parser should have found "${a}"`).toBe(true);
    }
  });
});
