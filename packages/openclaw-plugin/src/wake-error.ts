import { stripVTControlCharacters } from "node:util";

/** Wire contract shared with the CLI and daemon turn-advance endpoint. */
export interface WakeError {
  kind: "startup" | "execution" | "protocol";
  source: "claude" | "codex" | "pi" | "kiro" | "dsh" | "openclaw";
  message: string;
  details: string | null;
  exitCode: number | null;
  signal: string | null;
}

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  if (value && typeof value === "object" && "message" in value
    && typeof value.message === "string") return value.message;
  return "";
}

/** The separately published package cannot import the CLI's runtime helper. */
export function createWakeError(
  input: {
    kind?: WakeError["kind"];
    source?: WakeError["source"];
    message: unknown;
    details?: unknown;
    exitCode?: number | null;
    signal?: string | null;
  },
  secrets: string[] = [],
): WakeError {
  const forms = new Set<string>();
  const credentials = [
    ...secrets,
    ...Object.entries(process.env)
      .filter(([key]) => /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CALLBACK.*KEY)/i.test(key))
      .map(([, value]) => value),
  ];
  for (const credential of credentials) {
    if (!credential) continue;
    for (const part of [credential, ...credential.split(/\r?\n/)]) {
      for (const secret of [part, part.trim()]) {
        if (!secret) continue;
        forms.add(secret);
        forms.add(JSON.stringify(secret).slice(1, -1));
        try { forms.add(encodeURIComponent(secret)); } catch {}
      }
    }
  }
  const ordered = [...forms].sort((a, b) => b.length - a.length);
  function sanitize(value: unknown): string {
    let text = stripVTControlCharacters(errorText(value))
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
    for (const secret of ordered) text = text.split(secret).join("[redacted]");
    return text
      .replace(/\b(?:Bearer|Basic)\s+[^\s"'`,;<>\\]+/gi,
        (match) => `${match.split(/\s/)[0]} [redacted]`)
      .replace(/\bcho_[A-Za-z0-9_-]+/g, "[redacted]")
      .replace(/(\b(?:authorization|(?:[\w-]*_)?(?:api[_-]?key|token|secret|password))(?:["']?)\s*[:=]\s*["']?)([^\s"'`,;<>\\]+)/gi,
        (_, prefix: string) => `${prefix}[redacted]`)
      .trim();
  }
  return {
    kind: input.kind ?? "execution",
    source: input.source ?? "openclaw",
    message: (sanitize(input.message).replace(/\s+/g, " ") || "OpenClaw agent wake failed").slice(0, 500),
    details: sanitize(input.details).slice(0, 8000) || null,
    exitCode: Number.isInteger(input.exitCode) ? input.exitCode! : null,
    signal: sanitize(input.signal).slice(0, 50) || null,
  };
}
