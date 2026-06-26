// cli/daemon-banner.mjs
// Pure formatter for the daemon's boxed startup banner — one screen summarizing
// the daemon's posture. No IO: `formatBanner(info)` returns a string the caller
// writes. Degrades box-drawing to plain lines when `isTTY` is false so piped /
// redirected output stays clean and never depends on terminal width.
//
// SECURITY: the banner shows the credential SOURCE, never the raw API key
// (owner decision: no masking needed because the key is simply not displayed).
// Zero dependencies — ships in the npm package alongside chorus.mjs.

/**
 * @typedef {Object} BannerInfo
 * @property {string} version          chorus CLI version.
 * @property {string} url              remote server URL.
 * @property {string} agentName        authenticated agent name.
 * @property {string} agentUuid        authenticated agent uuid.
 * @property {"yolo"|"chorus"} permissionMode
 * @property {string} credentialSource resolved credential source (flag/env/login-file/…).
 * @property {string} agentType        local agent backend (e.g. claude-code).
 * @property {string|null} claudePath  resolved claude path, or null when not found.
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
  const claude = info.claudePath ? `found: ${info.claudePath}` : "NOT FOUND — install `claude` or set CHORUS_CLAUDE_PATH";
  const rows = [
    ["Version", `chorus v${info.version}`],
    ["Server", info.url],
    ["Agent", `${info.agentName} (${info.agentUuid})`],
    ["Agent type", info.agentType],
    ["Permission", permission],
    ["Credentials", `source: ${info.credentialSource}`],
    ["Connection", info.connection ?? "connecting…"],
    ["claude CLI", claude],
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
