#!/usr/bin/env node
// Stateless MCP-over-HTTP helper shipped with @chorus-aidlc/chorus-dsh.
// Usage: chorus-mcp-call.mjs TOOL_NAME '<json_arguments>'
//
// Reads CHORUS_URL + CHORUS_API_KEY from the environment. Pure Node: uses the
// global `fetch` (Node 18+) and `JSON` only — no `curl` and no `jq`, so the
// OpenSpec document-mirror path has zero external system dependencies and runs
// unchanged on Linux, macOS, and Windows.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
if (!url || !apiKey) {
  process.stderr.write(
    "chorus-mcp-call: CHORUS_URL or CHORUS_API_KEY not set (checked the environment and $DSH_HOME/.env)\n",
  );
  process.exit(1);
}

const toolName = process.argv[2];
if (!toolName) {
  process.stderr.write("chorus-mcp-call: tool name required\n");
  process.exit(1);
}

let argsRaw = process.argv[3];
if (argsRaw === undefined || argsRaw === "") argsRaw = "{}";
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
