// cli/daemon-service.mjs
// `chorus daemon install` / `uninstall` — generate and install a CORRECT
// supervisor unit for the long-lived daemon, and detect one so the lifecycle
// subcommands (status/stop/restart/logs) can transparently delegate to it.
//
// WHY THIS EXISTS (root fix for the boot restart storm, idea e55ae33a follow-up):
// operators hand-wrote a systemd unit as `Type=forking` + `ExecStart=… -d`.
// `chorus daemon -d` SELF-daemonizes (detached + unref child + a JSON pidfile
// systemd cannot parse), so systemd never adopts the forked child as MainPID,
// treats the service as failed, and `Restart=on-failure` retries every few
// seconds — each retry's `-d` preflight then finds the previous orphan alive
// via the pidfile and refuses ("a daemon is already running"), an infinite
// loop that also pins the server-side connection rows ("all declared paths
// already served"). The correct model is a FOREGROUND `Type=simple` service:
// systemd owns the process directly, `systemctl stop` delivers SIGTERM to the
// daemon's existing graceful-shutdown handler, no pidfile is involved, and
// there is nothing to double-start.
//
// Design (add-daemon-install-supervisor):
//   - Linux: fully generate + install a `systemd --user` unit, daemon-reload,
//     enable --now.
//   - macOS (launchd) / Windows: PRINT a correct template + manual steps and
//     exit 0 without writing (no auto-install off Linux — YAGNI + no native
//     deps / platform service-manager coupling).
//   - Rendering is PURE (no IO) so the correctness-critical unit text is unit
//     testable; install / detect / delegate are thin injected-IO shells,
//     mirroring the seam in daemon-lifecycle.mjs (all IO overridable per call).

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The systemd --user unit name (also the launchd label stem). */
export const SERVICE_NAME = "chorus-daemon";

/** Default IO bundle — overridable per-call for tests (no real disk/process). */
function defaultIO() {
  return {
    existsSync,
    mkdirSync,
    readFileSync,
    unlinkSync,
    writeFileSync,
    spawnSync,
    platform: process.platform,
    home: homedir(),
  };
}

/** ~/.config/systemd/user/chorus-daemon.service */
export function systemdUnitPath(io = defaultIO()) {
  return join(io.home ?? homedir(), ".config", "systemd", "user", `${SERVICE_NAME}.service`);
}

/** ~/Library/LaunchAgents/com.chorus.daemon.plist */
export function launchdPlistPath(io = defaultIO()) {
  return join(io.home ?? homedir(), "Library", "LaunchAgents", "com.chorus.daemon.plist");
}

/**
 * Resolve the absolute path to this CLI's `chorus.mjs` entrypoint (one level up
 * from cli/). Absolute so the generated unit does not depend on the operator's
 * cwd or PATH at boot.
 */
export function resolveScriptPath() {
  return join(dirname(dirname(fileURLToPath(import.meta.url))), "chorus.mjs");
}

/**
 * Build the argv the SUPERVISED daemon runs — the normal long-lived daemon
 * (NO `-d`: the supervisor owns the foreground process). Reflects the `--agent`
 * / `--chorus-only` posture the operator passed to `install`. The served cwd set
 * is NOT embedded here — it lives in ~/.chorus/daemon.json `cwds` (single source
 * of truth) and is read by the daemon via resolveDaemonCwds. Pure.
 * @param {{ cwds?: string[], agent?: string, chorusOnly?: boolean, scriptPath: string }} spec
 * @returns {string[]}  e.g. ["/x/chorus.mjs","daemon","--agent","codex"]
 */
export function buildServiceArgs(spec) {
  const args = [spec.scriptPath, "daemon"];
  // NOTE: --cwd is deliberately NOT emitted. The set of working directories the
  // daemon serves is persisted to ~/.chorus/daemon.json `cwds` at install time
  // (the single source of truth) and read back by the daemon via
  // resolveDaemonCwds. Baking --cwd into the unit too would let the two sources
  // drift and would hide the paths from a plain `chorus daemon` run
  // (fix-daemon-install-config, elaboration Q5-A). `spec.cwds` is still accepted
  // for signature compatibility but ignored here.
  if (spec.agent) args.push("--agent", spec.agent);
  if (spec.chorusOnly) args.push("--chorus-only");
  return args;
}

/**
 * Render a `systemd --user` unit for the FOREGROUND daemon. Pure.
 *
 * Key correctness properties (the whole point of this module):
 *   - Type=simple + ExecStart WITHOUT `-d` → systemd owns the node process as
 *     MainPID; no self-fork, no pidfile.
 *   - NO ExecStop → default stop is SIGTERM to the unit cgroup, which the
 *     daemon already handles gracefully. A pidfile-based `ExecStop=chorus
 *     daemon stop` would be a no-op here (foreground writes no pidfile).
 *   - TimeoutStopSec gives graceful shutdown room before SIGKILL.
 *   - PATH is captured so `node`/`claude`/`codex` resolve at boot the same way
 *     they did in the operator's shell.
 *
 * @param {{
 *   nodePath: string, scriptPath: string, cwds?: string[], agent?: string,
 *   chorusOnly?: boolean, workingDir: string, home: string, path: string,
 *   restartSec?: number, timeoutStopSec?: number,
 * }} spec
 * @returns {string}
 */
export function renderSystemdUnit(spec) {
  const args = buildServiceArgs({
    cwds: spec.cwds,
    agent: spec.agent,
    chorusOnly: spec.chorusOnly,
    scriptPath: spec.scriptPath,
  });
  // systemd's ExecStart tokenizer splits on UNQUOTED whitespace, so a token
  // with a space (an operator's `--cwd "/home/u/My Projects/repo"`, or a node/
  // script path under such a dir) would be mis-split and the daemon would serve
  // the wrong path silently. Quote every token so spaces survive.
  const execStart = [spec.nodePath, ...args].map(systemdQuoteArg).join(" ");
  const restartSec = spec.restartSec ?? 10;
  const timeoutStopSec = spec.timeoutStopSec ?? 30;
  return `[Unit]
Description=Chorus Daemon (multi-cwd)
After=network-online.target
Wants=network-online.target

[Service]
# Type=simple: the daemon runs in the FOREGROUND (no -d). systemd owns this
# process directly as MainPID, so 'systemctl stop' delivers SIGTERM straight to
# the daemon's graceful-shutdown handler — no self-forked orphan, no pidfile
# race, no restart storm. Do NOT add -d here: -d self-daemonizes and writes a
# JSON pidfile systemd cannot parse (that was the boot-loop root cause).
Type=simple
WorkingDirectory=${spec.workingDir}
ExecStart=${execStart}
Restart=on-failure
RestartSec=${restartSec}
# Room for in-flight wakes to drain on SIGTERM before SIGKILL.
TimeoutStopSec=${timeoutStopSec}
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}
Environment=HOME=${spec.home}
Environment=PATH=${spec.path}

[Install]
WantedBy=default.target
`;
}

/**
 * Render a macOS launchd LaunchAgent plist for the FOREGROUND daemon. Pure.
 * RunAtLoad + KeepAlive make launchd start it at login and restart on crash;
 * ProgramArguments carries node + the daemon argv WITHOUT `-d` (launchd, like
 * systemd, must own the foreground process). We print this for the operator to
 * install manually (no auto-write off Linux).
 * @param {{
 *   nodePath: string, scriptPath: string, cwds?: string[], agent?: string,
 *   chorusOnly?: boolean, workingDir: string, home: string, path: string,
 *   logPath: string,
 * }} spec
 * @returns {string}
 */
export function renderLaunchdPlist(spec) {
  const args = buildServiceArgs({
    cwds: spec.cwds,
    agent: spec.agent,
    chorusOnly: spec.chorusOnly,
    scriptPath: spec.scriptPath,
  });
  const programArgs = [spec.nodePath, ...args]
    .map((a) => `    <string>${xmlEscape(a)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.chorus.daemon</string>
  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(spec.workingDir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${xmlEscape(spec.home)}</string>
    <key>PATH</key>
    <string>${xmlEscape(spec.path)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(spec.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(spec.logPath)}</string>
</dict>
</plist>
`;
}

/** Minimal XML text escaping for plist string values. */
function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Quote a single token for a systemd `ExecStart=` line. systemd splits the line
 * on unquoted whitespace and supports C-escaped double-quoted strings, so a
 * token containing whitespace (or a quote/backslash) must be wrapped in `"…"`
 * with `\` and `"` escaped. Tokens without whitespace are left bare to keep the
 * common unit readable.
 */
function systemdQuoteArg(token) {
  const s = String(token);
  if (!/[\s"\\]/.test(s)) return s;
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Detect whether a supervisor already manages the chorus daemon on this host.
 * Linux only (systemd --user); everything else reports `{ kind: "none" }`.
 *   - kind: "systemd" with installed (unit file present, `is-enabled` not
 *     "not-found") and active (`is-active` == "active").
 *   - kind: "none" otherwise (or when systemctl is unavailable).
 * Used by the lifecycle subcommands to decide whether to delegate.
 * @param {object} [io]
 * @returns {{ kind: "systemd", installed: boolean, active: boolean, unitPath: string } | { kind: "none" }}
 */
export function detectSupervisor(io = defaultIO()) {
  if (io.platform !== "linux") return { kind: "none" };
  const unitPath = systemdUnitPath(io);
  const installed = safeExists(unitPath, io);
  // `is-active` is authoritative for "running under systemd right now". Query it
  // even when the unit file is absent: a transient/unit-less path still returns
  // non-active, and we never want to throw here.
  const activeRes = systemctlUser(["is-active", `${SERVICE_NAME}.service`], io);
  const active = (activeRes.stdout ?? "").trim() === "active";
  if (!installed && !active) return { kind: "none" };
  return { kind: "systemd", installed, active, unitPath };
}

function safeExists(path, io) {
  try {
    return io.existsSync(path);
  } catch {
    return false;
  }
}

/** Run `systemctl --user <args>`, capturing output. Never throws. */
export function systemctlUser(args, io = defaultIO()) {
  try {
    const r = io.spawnSync("systemctl", ["--user", ...args], { encoding: "utf8" });
    return { status: r?.status ?? null, stdout: r?.stdout ?? "", stderr: r?.stderr ?? "" };
  } catch (err) {
    return { status: null, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
  }
}

/** Run `journalctl --user <args>`, capturing output. Never throws. */
export function journalctlUser(args, io = defaultIO()) {
  try {
    const r = io.spawnSync("journalctl", ["--user", ...args], { encoding: "utf8" });
    return { status: r?.status ?? null, stdout: r?.stdout ?? "", stderr: r?.stderr ?? "" };
  } catch (err) {
    return { status: null, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Install the systemd --user unit (Linux) or return the template to print
 * (macOS/Windows). On Linux: write the unit, `daemon-reload`, `enable --now`.
 * All IO injected. Never throws — errors surface in the return shape.
 * @param {{
 *   nodePath: string, scriptPath: string, cwds?: string[], agent?: string,
 *   chorusOnly?: boolean, workingDir: string, path: string,
 * }} spec
 * @param {object} [io]
 * @returns {{
 *   platform: "linux"|"darwin"|"other",
 *   installed: boolean,
 *   unitPath?: string,
 *   unitText: string,
 *   steps: string[],
 *   error?: string,
 * }}
 */
export function installService(spec, io = defaultIO()) {
  const home = io.home ?? homedir();
  if (io.platform === "linux") {
    const unitPath = systemdUnitPath(io);
    const unitText = renderSystemdUnit({ ...spec, home });
    const steps = [];
    try {
      io.mkdirSync(dirname(unitPath), { recursive: true });
      io.writeFileSync(unitPath, unitText, { mode: 0o644 });
      steps.push(`wrote ${unitPath}`);
      const reload = systemctlUser(["daemon-reload"], io);
      if (reload.status !== 0) {
        return { platform: "linux", installed: false, unitPath, unitText, steps, error: `systemctl --user daemon-reload failed: ${reload.stderr.trim() || `exit ${reload.status}`}` };
      }
      steps.push("systemctl --user daemon-reload");
      const enable = systemctlUser(["enable", "--now", `${SERVICE_NAME}.service`], io);
      if (enable.status !== 0) {
        return { platform: "linux", installed: false, unitPath, unitText, steps, error: `systemctl --user enable --now failed: ${enable.stderr.trim() || `exit ${enable.status}`}` };
      }
      steps.push(`systemctl --user enable --now ${SERVICE_NAME}.service`);
      // enable --now only STARTS an inactive service; on a re-install over an
      // already-running daemon it is a no-op, leaving the old process on the old
      // --cwd/--agent flags. Restart so a re-install always applies the new unit.
      // Best-effort: a restart failure must not fail an otherwise-good install.
      const restart = systemctlUser(["restart", `${SERVICE_NAME}.service`], io);
      if (restart.status === 0) steps.push(`systemctl --user restart ${SERVICE_NAME}.service`);
      return { platform: "linux", installed: true, unitPath, unitText, steps };
    } catch (err) {
      return { platform: "linux", installed: false, unitPath, unitText, steps, error: err instanceof Error ? err.message : String(err) };
    }
  }
  if (io.platform === "darwin") {
    const plistPath = launchdPlistPath(io);
    const unitText = renderLaunchdPlist({ ...spec, home, logPath: join(home, ".chorus", "daemon.log") });
    return {
      platform: "darwin",
      installed: false,
      unitPath: plistPath,
      unitText,
      steps: [
        `Save the plist below to ${plistPath}`,
        `launchctl load -w ${plistPath}`,
        `Check: launchctl list | grep com.chorus.daemon`,
      ],
    };
  }
  // Windows / other: no first-class service model without native deps. Print the
  // foreground command an operator can wrap in their supervisor of choice.
  // Quote whitespace-bearing tokens so a copy-pasted path with a space survives.
  const cmd = [spec.nodePath, ...buildServiceArgs(spec)]
    .map((a) => (/\s/.test(String(a)) ? `"${a}"` : a))
    .join(" ");
  return {
    platform: "other",
    installed: false,
    unitText: cmd,
    steps: [
      "Automatic service install is only supported on Linux (systemd).",
      "Run the daemon in the FOREGROUND under your supervisor of choice (NSSM, Task Scheduler, etc.) — do NOT use -d, let the supervisor own the process:",
      `  ${cmd}`,
    ],
  };
}

/**
 * Uninstall the systemd --user unit (Linux): `disable --now`, remove the unit
 * file, `daemon-reload`. macOS/Windows: return manual removal steps. All IO
 * injected. Never throws.
 * @param {object} [io]
 * @returns {{
 *   platform: "linux"|"darwin"|"other",
 *   removed: boolean,
 *   unitPath?: string,
 *   steps: string[],
 *   error?: string,
 * }}
 */
export function uninstallService(io = defaultIO()) {
  if (io.platform === "linux") {
    const unitPath = systemdUnitPath(io);
    const steps = [];
    const existed = safeExists(unitPath, io);
    // disable --now stops + removes the autostart symlink; tolerate a missing
    // unit (already gone) so uninstall is idempotent.
    const disable = systemctlUser(["disable", "--now", `${SERVICE_NAME}.service`], io);
    if (disable.status === 0) steps.push(`systemctl --user disable --now ${SERVICE_NAME}.service`);
    try {
      if (existed) {
        io.unlinkSync(unitPath);
        steps.push(`removed ${unitPath}`);
      }
    } catch (err) {
      return { platform: "linux", removed: false, unitPath, steps, error: err instanceof Error ? err.message : String(err) };
    }
    systemctlUser(["daemon-reload"], io);
    steps.push("systemctl --user daemon-reload");
    return { platform: "linux", removed: existed || disable.status === 0, unitPath, steps };
  }
  if (io.platform === "darwin") {
    const plistPath = launchdPlistPath(io);
    return {
      platform: "darwin",
      removed: false,
      unitPath: plistPath,
      steps: [`launchctl unload -w ${plistPath}`, `rm ${plistPath}`],
    };
  }
  return {
    platform: "other",
    removed: false,
    steps: ["Automatic service uninstall is only supported on Linux (systemd). Remove the daemon from your supervisor manually."],
  };
}

/**
 * The absolute node + script paths for a freshly-rendered unit, derived from the
 * running CLI. Kept here so callers don't reach into process internals.
 * @returns {{ nodePath: string, scriptPath: string, path: string }}
 */
export function resolveServicePaths(env = process.env, execPath = process.execPath) {
  return {
    nodePath: execPath,
    scriptPath: resolveScriptPath(),
    path: env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  };
}
