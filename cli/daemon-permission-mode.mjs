// cli/daemon-permission-mode.mjs
// Pure resolution of the daemon's permission posture for the woken agent.
// The DEFAULT is now `yolo` (full autonomy) — reversing the prior `chorus`-only
// default. No confirmation needed; the startup banner prominently warns users
// and shows how to opt out with --chorus-only.
//
// This module is PURE: `resolvePermissionMode` does no IO and returns a
// decision object. Zero dependencies — ships in the npm package alongside chorus.mjs.

/**
 * @typedef {"yolo"|"workspace"|"chorus"} PermissionMode
 *   "yolo"      → woken agent gets full autonomy (--dangerously-skip-permissions).
 *   "workspace" → may write code, run tests and commit, but the OS sandbox confines
 *                 its reads and writes to the served working directory.
 *   "chorus"    → restricted: only mcp__chorus__* tools (no Bash / file edits).
 */

/**
 * @typedef {Object} PermissionDecision
 * @property {PermissionMode} mode        The resolved posture.
 * @property {boolean} needConfirm        True iff the caller must obtain an
 *   interactive TTY y/N confirmation AND persist an ack before starting yolo.
 * @property {boolean} warnUnattended     True iff yolo is starting on a non-TTY
 *   (unattended) — the caller must emit exactly one prominent ⚠ warning line.
 */

/**
 * Resolve the permission posture from the layered inputs. Precedence:
 *   1. Explicit restricted request (`--chorus-only` / CHORUS_CHORUS_ONLY=1) wins
 *      outright → `chorus`, never needs confirmation. It outranks `--workspace`:
 *      when both are asked for, the tighter posture can only cost capability,
 *      whereas picking the looser one would grant more than was requested.
 *   2. `--workspace` / CHORUS_WORKSPACE=1 → `workspace`. Opt-in only, never a
 *      default: it changes what a wake can do to the machine.
 *   3. Otherwise the posture is `yolo` (the default; `--yolo` /
 *      CHORUS_YOLO=1 select it too, but it is also the no-flag default).
 *      Yolo starts immediately with NO confirmation prompt — the warning banner
 *      tells users how to opt out.
 *
 * `CHORUS_YOLO=0`/`"false"` is treated as an explicit opt-OUT of yolo (→
 * `chorus`), symmetric with the `=1`/`"true"` opt-in, so the existing env knob
 * keeps working after the default flip.
 *
 * @param {{ yolo?: boolean, chorusOnly?: boolean }} flags
 * @param {Record<string, string|undefined>} env
 * @param {{ isTTY: boolean, hasAck: boolean }} ctx
 * @returns {PermissionDecision}
 */
export function resolvePermissionMode(flags, env, ctx) {
  const envChorusOnly = env.CHORUS_CHORUS_ONLY === "1" || env.CHORUS_CHORUS_ONLY === "true";
  const envYoloOff = env.CHORUS_YOLO === "0" || env.CHORUS_YOLO === "false";
  const envWorkspace = env.CHORUS_WORKSPACE === "1" || env.CHORUS_WORKSPACE === "true";

  // 1. The most restrictive explicit request wins. `--chorus-only` outranks
  //    `--workspace` deliberately: when an operator asks for both, honouring the
  //    tighter one can only cost capability, while honouring the looser one would
  //    silently grant more than was asked for.
  if (flags.chorusOnly || envChorusOnly || envYoloOff) {
    return { mode: "chorus", needConfirm: false, warnUnattended: false };
  }

  // 2. Workspace: explicit opt-in only. Never a default — it changes what a wake
  //    can do, and that decision belongs to the operator.
  if (flags.workspace || envWorkspace) {
    return { mode: "workspace", needConfirm: false, warnUnattended: false };
  }

  // 3. Default + explicit yolo both resolve to yolo with NO confirmation needed.
  // Always warn (both TTY and non-TTY) so users know how to restrict.
  return { mode: "yolo", needConfirm: false, warnUnattended: true };
}

/**
 * The prominent warning shown whenever yolo is active. Names both tighter
 * postures, because an operator reading this is deciding right now and the
 * middle one did not exist when the default flipped to yolo. Shown in the startup banner for both TTY and non-TTY.
 * @returns {string}
 */
export function yoloWarningLine() {
  return (
    "⚠ PERMISSION MODE: YOLO — the woken agent has FULL autonomy (Bash, file writes, " +
    "any command) under this daemon's API key. Run only in a trusted/sandboxed " +
    "environment. To restrict permissions, use --workspace (writes code and runs " +
    "tests, but the OS sandbox confines it to the served directory) or --chorus-only " +
    "(Chorus MCP tools only)."
  );
}
