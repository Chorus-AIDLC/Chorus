// Published CLI helpers: no dependency on the application's TypeScript runtime.
import { stripVTControlCharacters } from "node:util";

export const WAKE_ERROR_MESSAGE_LIMIT = 500;
export const WAKE_ERROR_DETAILS_LIMIT = 8000;
export const WAKE_ERROR_SIGNAL_LIMIT = 50;
export const WAKE_ERROR_STDERR_LIMIT = 16_000;
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

function knownSecrets({ env = process.env, creds, secrets = [] } = {}) {
  // Include callback credentials in the actual runtime env, as well as the
  // backend's env overlay and authoritative credentials that override it.
  const values = [...secrets, creds?.apiKey];
  for (const runtimeEnv of [process.env, env]) {
    for (const [key, value] of Object.entries(runtimeEnv ?? {})) {
      if (/(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CALLBACK.*KEY)/i.test(key)) values.push(value);
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
  for (const secret of secrets) {
    clean = clean.split(secret).join(REDACTED);
    // A bounded raw tail may begin in the middle of a known credential.
    if (truncated) {
      for (let length = Math.min(secret.length - 1, clean.length); length > 0; length--) {
        if (clean.startsWith(secret.slice(-length))) {
          clean = REDACTED + clean.slice(length);
          break;
        }
      }
    }
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
  let signal = null;
  return {
    get stderrLength() { return stderr.length; },
    get stderrTail() { return sanitize(stderr, credentials, truncated).slice(-WAKE_ERROR_DETAILS_LIMIT); },
    get hasFailure() { return failureKind !== null; },
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
    observeChild(child) {
      const capture = (_code, value) => { if (typeof value === "string" && value) signal ??= value; };
      child.on?.("exit", capture);
      child.on?.("close", capture);
      return () => {
        child.removeListener?.("exit", capture);
        child.removeListener?.("close", capture);
      };
    },
    build({ kind = failureKind ?? "execution", message, exitCode = null, signal: explicitSignal = signal } = {}) {
      const tail = this.stderrTail;
      const structured = sanitize(message, credentials) || reason;
      return createWakeError({
        source, kind, exitCode, signal: explicitSignal,
        message: structured || tail.split("\n").at(-1),
        details: [structured, tail].filter(Boolean).join("\n\n"),
      }, options);
    },
  };
}
