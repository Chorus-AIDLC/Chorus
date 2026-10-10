// Published CLI helpers: no dependency on the application's TypeScript runtime.
import { stripVTControlCharacters } from "node:util";

export const WAKE_ERROR_MESSAGE_LIMIT = 500;
export const WAKE_ERROR_DETAILS_LIMIT = 8000;
export const WAKE_ERROR_SIGNAL_LIMIT = 50;
export const WAKE_ERROR_STDERR_LIMIT = 16_000;
// Shortest credential tail that counts as evidence of a key sliced by the
// retained-tail boundary. Below this, a suffix match is noise: a 1-char tail
// collides with ANY text starting with that character, so an unrelated
// credential whose last byte happens to match would redact innocent output —
// and, worse, shadow the form that actually was cut. Credential tails of 1-3
// characters are deliberately NOT repaired: that residue carries no usable
// information, and matching it costs correctness everywhere else.
export const WAKE_ERROR_MIN_TAIL_MATCH = 4;
const REDACTED = "[redacted]";
const SOURCES = new Set(["claude", "codex", "pi", "kiro", "dsh", "openclaw"]);
const KINDS = new Set(["startup", "execution", "protocol"]);

function scalarErrorText(value) {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  return typeof value?.message === "string" ? value.message : "";
}

/**
 * Extract only textual error fields. Array entries are sanitized before bounded
 * assembly; callers extracting arrays supply their backend's credential context.
 */
export function wakeErrorText(value, options = {}) {
  return Array.isArray(value) ? sanitize(value, knownSecrets(options)) : scalarErrorText(value);
}

function isCredentialEnvValue(key, value) {
  if (typeof value !== "string" || !value.trim() ||
      !/(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CALLBACK.*KEY)/i.test(key) ||
      /(?:^|[_-])TOKENS(?:$|[_-])/i.test(key)) return false;
  // Explicit credential names still protect short keys/passwords. Broad TOKEN/
  // SECRET matches also catch configuration flags; infer literals conservatively.
  if (/(?:API[_-]?KEY|PASSWORD|CALLBACK.*KEY)/i.test(key)) return true;
  const text = value.trim();
  return text.length >= 8 && !/^(?:[+-]?\d+(?:\.\d+)?|true|false|yes|no|on|off|null|undefined)$/i.test(text);
}

function knownSecrets({ env = process.env, creds, secrets = [] } = {}) {
  // Include callback credentials in the actual runtime env, as well as the
  // backend's env overlay and authoritative credentials that override it.
  const values = [...secrets, creds?.apiKey];
  for (const runtimeEnv of [process.env, env]) {
    for (const [key, value] of Object.entries(runtimeEnv ?? {})) {
      if (isCredentialEnvValue(key, value)) values.push(value);
    }
  }
  // Match sanitizeUpgradeOutput's representation-aware redaction without
  // importing its process-launching module into the diagnostic helper.
  const forms = new Set();
  for (const value of values) {
    if (typeof value !== "string" || !value) continue;
    for (const part of [value, ...value.split(/\r?\n/)]) {
      for (const secret of [part, part.trim()]) {
        if (!secret) continue;
        forms.add(secret);
        forms.add(JSON.stringify(secret).slice(1, -1));
        // A malformed UTF-16 value still has literal and JSON protection.
        try { forms.add(encodeURIComponent(secret)); } catch {}
      }
    }
  }
  return [...forms].sort((a, b) => b.length - a.length);
}

function sanitize(text, secrets, truncated = false) {
  if (Array.isArray(text)) {
    let assembled = "";
    for (const item of text) {
      if (typeof item !== "string") continue;
      // Never slice raw entries: a key across the limit would become an
      // unrecognizable exposed prefix before the normal redaction boundary.
      const safe = sanitize(item, secrets);
      if (!safe) continue;
      const separator = assembled ? "\n" : "";
      assembled += separator + safe.slice(0, WAKE_ERROR_DETAILS_LIMIT - assembled.length - separator.length);
      if (assembled.length >= WAKE_ERROR_DETAILS_LIMIT) break;
    }
    return assembled;
  }
  let clean = stripVTControlCharacters(scalarErrorText(text))
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
  // A bounded raw tail may begin in the middle of a known credential. Score
  // EVERY form and keep the longest match, rather than stopping at the first
  // hit: `secrets` is ordered longest-first, so a weak match on a long
  // unrelated credential would otherwise win before the form that was
  // genuinely cut gets its turn.
  const ranges = [];
  if (truncated) {
    let best = 0;
    for (const secret of secrets) {
      const longest = Math.min(secret.length - 1, clean.length);
      for (let length = longest; length >= WAKE_ERROR_MIN_TAIL_MATCH && length > best; length--) {
        if (clean.startsWith(secret.slice(-length))) {
          best = length;
          break;
        }
      }
    }
    if (best > 0) ranges.push([0, best]);
  }
  // Locate the cut tail and every whole occurrence on the SAME raw text, then
  // redact their union. Replacing whole forms first would destroy the suffix
  // evidence of a cut credential that contains another known one; repairing
  // first would split a whole credential that the tail match only overlaps.
  for (const secret of secrets) {
    for (let at = clean.indexOf(secret); at !== -1; at = clean.indexOf(secret, at + 1)) {
      ranges.push([at, at + secret.length]);
    }
  }
  if (ranges.length) {
    ranges.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [start, stop] of ranges) {
      const last = merged.at(-1);
      if (last && start < last[1]) last[1] = Math.max(last[1], stop);
      else merged.push([start, stop]);
    }
    let redacted = "";
    let cursor = 0;
    for (const [start, stop] of merged) {
      redacted += clean.slice(cursor, start) + REDACTED;
      cursor = stop;
    }
    clean = redacted + clean.slice(cursor);
  }
  return clean
    .replace(/\b(?:Bearer|Basic)\s+[^\s"'`,;<>\\]+/gi, (match) => `${match.split(/\s/)[0]} ${REDACTED}`)
    .replace(/\bcho_[a-zA-Z0-9_-]+/g, REDACTED)
    .replace(/(\b(?:authorization|(?:[\w-]*_)?(?:api[_-]?key|token|secret|password))(?:["']?)\s*[:=]\s*["']?)([^\s"'`,;<>\\]+)/gi,
      (_, prefix) => `${prefix}${REDACTED}`)
    .trim();
}

/** Sanitize before truncating so a summary/detail limit cannot expose half a key. */
export function sanitizeWakeErrorText(text, options = {}) {
  return sanitize(text, knownSecrets(options));
}

/** Build the exact WakeError contract. Also useful for reporting setup exceptions. */
export function createWakeError({
  source, kind = "execution", message, details = null, exitCode = null, signal = null,
}, options = {}) {
  if (!SOURCES.has(source) || !KINDS.has(kind)) throw new TypeError("Invalid wake error source or kind");
  const secrets = knownSecrets(options);
  const code = Number.isSafeInteger(exitCode) ? exitCode : null;
  const safeSignal = sanitize(signal, secrets).slice(0, WAKE_ERROR_SIGNAL_LIMIT) || null;
  const fallback = safeSignal ? `${source} process terminated by ${safeSignal}`
    : code !== null ? `${source} process exited with code ${code}`
      : `${source} ${kind} failed without an available process exit code`;
  return {
    kind, source,
    message: (sanitize(message, secrets).replace(/\s+/g, " ") || fallback).slice(0, WAKE_ERROR_MESSAGE_LIMIT),
    details: sanitize(details, secrets).slice(-WAKE_ERROR_DETAILS_LIMIT) || null,
    exitCode: code,
    signal: safeSignal,
  };
}

/**
 * One collector per attempt. appendStderr bounds retained text on every chunk;
 * fail records a structured reason; build is called only for a classified failure.
 * build keeps raw exit metadata even when the spawner synthesizes a failure code.
 */
export function createWakeErrorCollector({ source, env, creds, secrets } = {}) {
  const options = { env, creds, secrets };
  const credentials = knownSecrets(options);
  let stderr = "";
  let truncated = false;
  let reason = "";
  let failureKind = null;
  let fallbackReason = "";
  let fallbackKind = null;
  let signal = null;
  return {
    get stderrLength() { return stderr.length; },
    get stderrTail() { return sanitize(stderr, credentials, truncated).slice(-WAKE_ERROR_DETAILS_LIMIT); },
    get hasFailure() { return failureKind !== null || fallbackKind !== null; },
    appendStderr(chunk) {
      const text = String(chunk);
      truncated ||= stderr.length + text.length > WAKE_ERROR_STDERR_LIMIT;
      stderr = text.length >= WAKE_ERROR_STDERR_LIMIT
        // Copy the small tail so V8 cannot retain a huge sliced-string backing store.
        ? Buffer.from(text.slice(-WAKE_ERROR_STDERR_LIMIT), "utf8").toString("utf8")
        : (stderr + text).slice(-WAKE_ERROR_STDERR_LIMIT);
    },
    fail(error, kind = "execution") {
      // The first failure owns the diagnostic, rather than a cleanup side effect.
      if (failureKind !== null) return;
      failureKind = kind;
      reason = sanitize(error, credentials).slice(0, WAKE_ERROR_DETAILS_LIMIT);
    },
    failFallback(error, kind = "protocol") {
      // Pipe closure can be a consequence of the backend failing. Retain it
      // without taking the summary away from a terminal error or drained stderr.
      if (fallbackKind !== null) return;
      fallbackKind = kind;
      fallbackReason = sanitize(error, credentials).slice(0, WAKE_ERROR_DETAILS_LIMIT);
    },
    observeChild(child) {
      const capture = (_code, value) => { if (typeof value === "string" && value) signal ??= value; };
      child.on?.("exit", capture);
      child.on?.("close", capture);
      return () => {
        child.removeListener?.("exit", capture);
        child.removeListener?.("close", capture);
      };
    },
    build({ kind, message, exitCode = null, signal: explicitSignal = signal } = {}) {
      const tail = this.stderrTail;
      const structured = sanitize(message, credentials) || reason;
      return createWakeError({
        source, kind: kind ?? failureKind ?? (tail ? "execution" : fallbackKind ?? "execution"),
        exitCode, signal: explicitSignal,
        message: structured || tail.split("\n").at(-1) || fallbackReason,
        details: [structured, tail, fallbackReason].filter(Boolean).join("\n\n"),
      }, options);
    },
  };
}
