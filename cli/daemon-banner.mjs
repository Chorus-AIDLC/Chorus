// cli/daemon-banner.mjs
// Pure formatter for the daemon's boxed startup banner — one screen summarizing
// the daemon's posture. No IO: `formatBanner(info)` returns a string the caller
// writes. Degrades box-drawing to plain lines when `isTTY` is false so piped /
// redirected output stays clean and never depends on terminal width.
//
// SECURITY: the banner shows the credential SOURCE, never the raw API key
// (owner decision: no masking needed because the key is simply not displayed).
// Zero dependencies (beyond the pure backendCli descriptor) — ships in the npm
// package alongside chorus.mjs.

import { backendCli } from "./daemon-agent.mjs";

/**
 * @typedef {Object} BannerInfo
 * @property {string} version          chorus CLI version.
 * @property {string} url              remote server URL.
 * @property {string} agentName        authenticated agent name.
 * @property {string} agentUuid        authenticated agent uuid.
 * @property {"yolo"|"chorus"} permissionMode
 * @property {string} credentialSource resolved credential source (flag/env/login-file/…).
 * @property {string} agentType        local agent backend (claude-code | codex | kiro | dsh) — drives the CLI row label.
 * @property {string|null} cliPath     resolved path of the SELECTED backend's CLI, or null when not found.
 * @property {string} [connection]     connection state line (default "connecting…").
 * @property {string} [configPath]     absolute path to the daemon.json the CLI reads.
 * @property {boolean} [configExists]  whether that daemon.json exists on disk.
 */

/** Right-pad to width (banner box alignment). */
function pad(s, width) {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

/**
 * Build the banner's labelled rows (label, value) in display order. Pure — also
 * used by tests to assert content independently of the box framing.
 * @param {BannerInfo} info
 * @returns {Array<[string, string]>}
 */
export function bannerRows(info) {
  const permission =
    info.permissionMode === "yolo"
      ? "YOLO ⚠  (full autonomy — Bash/write/any command)"
      : "chorus-only (Chorus MCP tools only)";
  // The CLI row names the selected backend so non-Claude runs are never
  // mislabeled and their own executable override is actionable.
  const cli = backendCli(info.agentType);
  const cliValue = info.cliPath
    ? `found: ${info.cliPath}`
    : `NOT FOUND — install \`${cli.name}\` or set ${cli.envVar}`;
  const rows = [
    ["Version", `chorus v${info.version}`],
    ["Server", info.url],
    ["Agent", `${info.agentName} (${info.agentUuid})`],
    ["Agent type", info.agentType],
    ["Permission", permission],
    ["Credentials", `source: ${info.credentialSource}`],
    ["Connection", info.connection ?? "connecting…"],
    [`${cli.name} CLI`, cliValue],
  ];
  // Config file row — shown only when the path is known. Tells the operator
  // exactly which daemon.json the CLI read (and whether it exists), so a
  // mis-located or absent config is obvious at a glance.
  if (info.configPath) {
    const exists = info.configExists ? "" : " (not found — using flags/env/defaults)";
    rows.push(["Config", `${info.configPath}${exists}`]);
  }
  return rows;
}

/**
 * The prominent warning shown at startup when the SELECTED backend's executable
 * cannot be resolved. Mirrors `yoloWarningLine()`'s loud single-line style so a
 * missing binary is visible in an unattended / systemd journal immediately,
 * rather than only when a wake later fails. The daemon stays non-fatal — it still
 * subscribes. Names the backend's own binary + override env var (claude /
 * CHORUS_CLAUDE_PATH, or codex / CHORUS_CODEX_PATH).
 * @param {string} agentType
 * @returns {string}
 */
export function agentNotFoundWarningLine(agentType) {
  const { name, envVar } = backendCli(agentType);
  return (
    `⚠ ${name} CLI NOT FOUND on PATH — wakes will FAIL until you install \`${name}\` ` +
    `or set ${envVar}. For a systemd/boot service, ensure the unit's PATH ` +
    "includes the directory holding the binary (e.g. ~/.local/bin). The daemon will " +
    "still subscribe, but every task dispatch errors until this is fixed."
  );
}

/**
 * Back-compat alias — the original claude-only warning. Delegates to
 * {@link agentNotFoundWarningLine} for the default claude-code backend so older
 * imports keep working.
 * @returns {string}
 */
export function claudeNotFoundWarningLine() {
  return agentNotFoundWarningLine("claude-code");
}

/**
 * Format the startup banner. On a TTY, draws a Unicode box; otherwise emits
 * plain `label: value` lines (no box-drawing chars, no width math) so piped
 * output is clean. Never throws.
 * @param {BannerInfo} info
 * @param {{ isTTY?: boolean }} [opts]
 * @returns {string}
 */
export function formatBanner(info, opts = {}) {
  const rows = bannerRows(info);
  const isTTY = opts.isTTY ?? false;

  if (!isTTY) {
    // Plain mode: stable, greppable, no box-drawing.
    const lines = ["Chorus daemon", ...rows.map(([k, v]) => `  ${k}: ${v}`)];
    return lines.join("\n") + "\n";
  }

  const labelW = Math.max(...rows.map(([k]) => k.length));
  const body = rows.map(([k, v]) => `${pad(k, labelW)}  ${v}`);
  const title = "Chorus daemon";
  const innerW = Math.max(title.length, ...body.map((l) => l.length));
  const top = "┌" + "─".repeat(innerW + 2) + "┐";
  const bottom = "└" + "─".repeat(innerW + 2) + "┘";
  const sep = "├" + "─".repeat(innerW + 2) + "┤";
  const line = (s) => `│ ${pad(s, innerW)} │`;
  return [top, line(title), sep, ...body.map(line), bottom].join("\n") + "\n";
}
