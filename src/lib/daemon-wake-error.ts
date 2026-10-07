import { z } from "zod";

export const WAKE_ERROR_KINDS = ["startup", "execution", "protocol"] as const;
export const WAKE_ERROR_SOURCES = ["claude", "codex", "pi", "kiro", "dsh", "openclaw", "hermes"] as const;

/** Only bounded plain text crosses the daemon-to-conversation boundary. */
export function sanitizeWakeErrorText(text: string): string {
  let cleaned = text
    // CSI / OSC terminal sequences, followed by nonprinting control characters.
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .replace(/\bcho_[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/\bBearer[ \t]+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]");
  const credential = process.env.CHORUS_API_KEY;
  if (credential) cleaned = cleaned.split(credential).join("[redacted]");
  return cleaned.trim();
}

/** Validate before sanitizing: an oversized report must not be silently accepted. */
export const wakeErrorSchema = z.object({
  kind: z.enum(WAKE_ERROR_KINDS),
  source: z.enum(WAKE_ERROR_SOURCES),
  message: z.string().max(500).trim().min(1),
  details: z.string().max(8000).nullish(),
  exitCode: z.number().int().nullish(),
  signal: z.string().max(50).trim().min(1).nullish(),
}).strict().transform((value) => ({
  kind: value.kind,
  source: value.source,
  message: sanitizeWakeErrorText(value.message).slice(0, 500) || "Agent wake failed",
  details: value.details ? sanitizeWakeErrorText(value.details).slice(0, 8000) || null : null,
  exitCode: value.exitCode ?? null,
  signal: value.signal ? sanitizeWakeErrorText(value.signal).slice(0, 50) || null : null,
}));

export type WakeError = z.output<typeof wakeErrorSchema>;

/** Old rows, old clients and malformed JSON read as an absent diagnostic. */
export function normalizeWakeError(raw: unknown): WakeError | null {
  const parsed = wakeErrorSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
