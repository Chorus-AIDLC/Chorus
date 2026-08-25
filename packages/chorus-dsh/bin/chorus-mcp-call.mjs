#!/usr/bin/env node
// Stateless MCP-over-HTTP helper shipped with @chorus-aidlc/chorus-dsh.
// Usage: chorus-mcp-call.mjs TOOL_NAME '<json_arguments>'
//
// Reads CHORUS_URL + CHORUS_API_KEY from the environment. Pure Node: uses the
// global `fetch` (Node 18+) and `JSON` only — no `curl` and no `jq`, so the
// OpenSpec document-mirror path has zero external system dependencies and runs
// unchanged on Linux, macOS, and Windows.
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { parseEnv } from "node:util";

// Credentials fall back to $DSH_HOME/.env (default ~/.dsh/.env) when absent from
// the process environment — the agent shell tool that invokes this wrapper may
// not export CHORUS_API_KEY even though dsh has it in its config file. This is
// dsh's own sanctioned mechanism: its credentials-local provider lists
// `$DSH_HOME/.env` in its documented fallback chain, and dsh parses this file
// with the same node:util parser used here.
function readDshHomeEnv() {
  const home =
    process.env.DSH_HOME && process.env.DSH_HOME.trim()
      ? process.env.DSH_HOME
      : join(homedir(), ".dsh");
  try {
    return parseEnv(readFileSync(join(home, ".env"), "utf8"));
  } catch {
    return {}; // no .env — the environment variables must be set
  }
}

// Cosmetic MCP client label — read from package.json so it never drifts.
let pkgVersion = "0.0.0";
try {
  pkgVersion =
    JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
      .version || pkgVersion;
} catch {
  // keep the fallback
}

const dshEnv =
  process.env.CHORUS_URL && process.env.CHORUS_API_KEY ? {} : readDshHomeEnv();
const url = process.env.CHORUS_URL || dshEnv.CHORUS_URL;
const apiKey = process.env.CHORUS_API_KEY || dshEnv.CHORUS_API_KEY;
// Profile identity (AWS-CLI style): CHORUS_AGENT_PROFILE names WHICH agent to act
// as; the `chorus` CLI then resolves that agent's key from ~/.chorus/daemon.json,
// so url/apiKey need NOT be present. Unlike url/apiKey, the profile is NOT a
// credential-shaped value, so dsh does not scrub it from tool subprocesses: dsh
// loads $DSH_HOME/.env (where `chorus agents add` seeds it) into the session, and
// it reaches this wrapper directly on the environment. So read process.env ONLY —
// no $DSH_HOME/.env re-read (that fallback exists solely for the scrubbed
// url/apiKey). If the profile is absent, the wrapper still works via url+key below.
// The url/apiKey requirement is enforced lower down, only when a profile isn't
// driving a CLI delegation.
const agentProfile =
  (process.env.CHORUS_AGENT_PROFILE && process.env.CHORUS_AGENT_PROFILE.trim()) || "";

const toolName = process.argv[2];
if (!toolName) {
  process.stderr.write("chorus-mcp-call: tool name required\n");
  process.exit(1);
}

let argsRaw = process.argv[3];
if (argsRaw === undefined || argsRaw === "") argsRaw = "{}";

// Resolve the `chorus` binary on PATH without a shell (Windows npm shims are
// `chorus.cmd`, which `spawn` can't exec directly without shell:true). Mirrors
// resolveClaudePath/resolveCodexPath in the CLI. Returns an absolute path or null.
function resolveChorusOnPath(env, platform) {
  const isWin = platform === "win32";
  const names = isWin ? ["chorus.cmd", "chorus.exe", "chorus.bat", "chorus"] : ["chorus"];
  const pathVar = env.PATH || env.Path || "";
  for (const dir of pathVar.split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(dir, name);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // not this dir — keep scanning
      }
    }
  }
  return null;
}

// A `.cmd`/`.bat` shim is not a PE executable, so on Windows run it via
// `cmd.exe /d /s /c <path> ...args` (shell:false, argv as array — no word
// splitting/injection). Mirrors resolveSpawnCommand in cli/codex-spawner.mjs.
function buildChorusSpawn(chorusPath, args, platform, env) {
  const lower = chorusPath.toLowerCase();
  if (platform === "win32" && (lower.endsWith(".cmd") || lower.endsWith(".bat"))) {
    const comspec = env.ComSpec || env.COMSPEC || "cmd.exe";
    return { command: comspec, argv: ["/d", "/s", "/c", chorusPath, ...args] };
  }
  return { command: chorusPath, argv: args };
}

// Prefer the native `chorus` CLI when it is on PATH — the CLI is a compliant MCP
// client that this wrapper otherwise re-implements. Fall back to the built-in
// Node transport below ONLY when `chorus` is absent, or when the CHORUS_MCP_NO_CLI
// escape hatch is set (non-empty). This wrapper stays the single credential
// resolver, so the resolved url/apiKey are passed explicitly. The fallback never
// triggers on a call *failure*: a present-but-erroring `chorus mcp call`
// propagates its stdout/stderr and exit code verbatim (no double request), so
// argsRaw is forwarded verbatim and the CLI validates the JSON.
if (!process.env.CHORUS_MCP_NO_CLI) {
  const chorusPath = resolveChorusOnPath(process.env, process.platform);
  if (chorusPath) {
    // `chorus mcp` only exists in chorus >= 0.17.0. Delegating `chorus mcp call`
    // to an older CLI fails with a cryptic "unknown command", so version-gate
    // before delegating: >= 0.17.0 delegates below; an older or unparseable
    // version becomes an actionable upgrade error (no silent native fallback).
    // `chorus --version` prints a bare X.Y.Z; parse the first MAJOR.MINOR and
    // compare as major>0 OR (major==0 && minor>=17).
    const verSpawn = buildChorusSpawn(chorusPath, ["--version"], process.platform, process.env);
    const verRes = spawnSync(verSpawn.command, verSpawn.argv, { encoding: "utf8" });
    const verLine =
      !verRes.error && typeof verRes.stdout === "string"
        ? (verRes.stdout.split(/\r?\n/)[0] || "").trim()
        : "";
    const verMatch = verLine.match(/(\d+)\.(\d+)(?:\.\d+)?/);
    const major = verMatch ? Number(verMatch[1]) : NaN;
    const minor = verMatch ? Number(verMatch[2]) : NaN;
    const versionOk =
      Number.isInteger(major) && Number.isInteger(minor) && (major > 0 || minor >= 17);
    if (!versionOk) {
      process.stderr.write(
        `chorus-mcp-call: chorus CLI version '${verLine || "unknown"}' is too old; ` +
          "'chorus mcp' requires chorus >= 0.17.0. " +
          "Upgrade with: npm install -g @chorus-aidlc/chorus\n",
      );
      process.exit(6);
    }
    // Prefer the profile (identity-by-name) — the CLI resolves the key itself, so
    // url/apiKey need not be present. Else pass the resolved url+key. If NEITHER is
    // available, fall through to the url+key requirement error below (nothing to
    // delegate with).
    const credArgs = agentProfile
      ? ["--agent", agentProfile]
      : url && apiKey
        ? ["--url", url, "--api-key", apiKey]
        : null;
    if (credArgs) {
      const { command, argv } = buildChorusSpawn(
        chorusPath,
        ["mcp", "call", toolName, argsRaw, ...credArgs],
        process.platform,
        process.env,
      );
      const res = spawnSync(command, argv, { stdio: ["ignore", "inherit", "inherit"] });
      if (res.error) {
        // Detected but could not launch — a genuine failure, not "absence". Per the
        // contract we surface it rather than silently retrying over the Node path.
        process.stderr.write(`chorus-mcp-call: failed to run chorus CLI: ${res.error.message}\n`);
        process.exit(5);
      }
      process.exit(typeof res.status === "number" ? res.status : 1);
    }
  }
}

// Native transport requires explicit url + key. If we reach here with a profile
// set, the `chorus` CLI wasn't usable (absent / too old / escape hatch) — profile
// resolution needs it, so say so plainly instead of a generic "not set".
if (!url || !apiKey) {
  process.stderr.write(
    agentProfile
      ? "chorus-mcp-call: CHORUS_AGENT_PROFILE is set but the chorus CLI (>= 0.17.0) is not available — profile resolution needs it. Install `npm install -g @chorus-aidlc/chorus`, or set CHORUS_URL + CHORUS_API_KEY.\n"
      : "chorus-mcp-call: CHORUS_URL or CHORUS_API_KEY not set (checked the environment and $DSH_HOME/.env)\n",
  );
  process.exit(1);
}

let toolArguments;
try {
  toolArguments = JSON.parse(argsRaw);
} catch {
  process.stderr.write("chorus-mcp-call: <json_arguments> is not valid JSON\n");
  process.exit(1);
}

// Normalize the endpoint: honor an explicit path (e.g. .../api/mcp), otherwise
// append /api/mcp — matching the behavior of the previous shell wrapper.
function resolveEndpoint(raw) {
  const u = raw.replace(/\/+$/, "");
  const match = u.match(/^https?:\/\/[^/]+(\/.*)?$/);
  const path = match && match[1] ? match[1] : "";
  return path ? u : `${u}/api/mcp`;
}
const endpoint = resolveEndpoint(url);

let sessionId = "";
function headers() {
  const base = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) base["Mcp-Session-Id"] = sessionId;
  return base;
}
function post(payload) {
  return fetch(endpoint, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(payload),
  });
}

// The streamable-http transport may answer with plain JSON or SSE framing
// (event:/data: lines). Extract the last data payload when framed, then parse.
function parseBody(text) {
  let body = text;
  const trimmed = text.trimStart();
  if (trimmed.startsWith("event:") || trimmed.startsWith("data:")) {
    const dataLines = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());
    body = dataLines.length ? dataLines[dataLines.length - 1] : "";
  }
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function writeOut(text) {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

try {
  const initRes = await post({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "chorus-dsh", version: pkgVersion },
    },
  });
  if (!initRes.ok) {
    process.stderr.write(`MCP initialize failed (HTTP ${initRes.status})\n`);
    process.exit(2);
  }
  sessionId = initRes.headers.get("mcp-session-id") || "";
  await initRes.text().catch(() => "");

  // Best-effort initialized notification; no response body is expected.
  await post({ jsonrpc: "2.0", method: "notifications/initialized" }).then(
    (res) => res.text().catch(() => ""),
    () => {},
  );

  const callRes = await post({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: toolName, arguments: toolArguments },
  });
  const raw = await callRes.text();
  if (!callRes.ok) {
    process.stderr.write(`MCP tool call failed (HTTP ${callRes.status})\n`);
    if (raw) writeOut(raw);
    process.exit(3);
  }

  const parsed = parseBody(raw);
  // JSON-RPC / tool error: emit the body (it contains "error") and fail loudly.
  // This is stricter than the old shell wrapper, which exited 0 on a 401.
  if (parsed && parsed.error) {
    writeOut(JSON.stringify(parsed));
    process.exit(4);
  }

  let out;
  if (parsed && parsed.result !== undefined) {
    const result = parsed.result;
    if (
      result &&
      Array.isArray(result.content) &&
      result.content[0] &&
      typeof result.content[0].text === "string"
    ) {
      out = result.content[0].text;
    } else if (typeof result === "string") {
      out = result;
    } else {
      out = JSON.stringify(result);
    }
  } else {
    out = parsed !== undefined ? JSON.stringify(parsed) : raw;
  }
  writeOut(out);
} catch (err) {
  const message = err && err.message ? err.message : String(err);
  process.stderr.write(`chorus-mcp-call: ${message}\n`);
  process.exit(5);
}
