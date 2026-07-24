// Persist the last cumulative Codex token snapshot per Chorus anchor. Codex
// `turn.completed.usage` is backed by ThreadTokenUsage.total, so resumed execs
// must subtract this baseline before publishing per-turn usage.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const NOOP_LOGGER = { warn() {} };
const FIELDS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
];

export function codexUsageMapPath() {
  return join(homedir(), ".chorus", "codex-usage.json");
}

function tokenInt(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

function sanitizeUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const usage = {};
  let found = false;
  for (const field of FIELDS) {
    const parsed = tokenInt(value[field]);
    if (parsed !== null) {
      usage[field] = parsed;
      found = true;
    }
  }
  return found ? usage : null;
}

function readMap(path, read, logger) {
  try {
    const parsed = JSON.parse(read(path));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    if (!(err && err.code === "ENOENT")) {
      logger.warn(`[Chorus] codex-usage-map: read failed (${err}) - treating as empty`);
    }
    return {};
  }
}

export function getCodexUsageSnapshot(anchor, threadId, deps = {}) {
  if (!anchor || !threadId) return null;
  const path = deps.path ?? codexUsageMapPath();
  const read = deps.read ?? ((p) => readFileSync(p, "utf8"));
  const logger = deps.logger ?? NOOP_LOGGER;
  const entry = readMap(path, read, logger)[anchor];
  if (!entry || entry.threadId !== threadId) return null;
  return sanitizeUsage(entry.usage);
}

export function setCodexUsageSnapshot(anchor, threadId, usage, deps = {}) {
  const clean = sanitizeUsage(usage);
  if (!anchor || !threadId || !clean) return;
  const path = deps.path ?? codexUsageMapPath();
  const read = deps.read ?? ((p) => readFileSync(p, "utf8"));
  const write = deps.write ?? writeFileSync;
  const mkdir = deps.mkdir ?? mkdirSync;
  const rename = deps.rename ?? renameSync;
  const logger = deps.logger ?? NOOP_LOGGER;
  try {
    const map = readMap(path, read, logger);
    map[anchor] = { threadId, usage: clean };
    mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    write(tmp, JSON.stringify(map, null, 2) + "\n", { mode: 0o600 });
    rename(tmp, path);
  } catch (err) {
    logger.warn(`[Chorus] codex-usage-map: persist failed (${err}) - next turn may overcount`);
  }
}

function delta(current, previous) {
  const now = tokenInt(current);
  if (now === null) return null;
  const before = tokenInt(previous);
  return before !== null && now >= before ? now - before : now;
}

export function normalizeCodexUsageEvent(event, previous) {
  if (!event || event.type !== "turn.completed" || !event.usage) return event;
  const raw = event.usage;
  const input = delta(raw.input_tokens, previous?.input_tokens);
  const cacheRead = delta(raw.cached_input_tokens, previous?.cached_input_tokens);
  const cacheWrite = delta(raw.cache_write_input_tokens, previous?.cache_write_input_tokens);
  const exclusiveInput =
    input === null ? null : Math.max(0, input - (cacheRead ?? 0) - (cacheWrite ?? 0));

  return {
    ...event,
    usage: {
      ...raw,
      input_tokens: exclusiveInput,
      cached_input_tokens: cacheRead,
      cache_write_input_tokens: cacheWrite,
      output_tokens: delta(raw.output_tokens, previous?.output_tokens),
      reasoning_output_tokens: delta(
        raw.reasoning_output_tokens,
        previous?.reasoning_output_tokens
      ),
    },
  };
}
