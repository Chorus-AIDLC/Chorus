/**
 * NEXTAUTH_SECRET placeholder detection (GitHub issue #559).
 *
 * App-layer defense-in-depth that runs on every deployment path (Docker, CDK,
 * npm launcher, dev). It is intentionally side-effect free apart from logging:
 * it never throws and never sets a fallback value — when the variable is unset,
 * token issuance keeps failing with the existing "NEXTAUTH_SECRET is not set"
 * error from user-session.ts / super-admin.ts.
 *
 * The placeholder list MUST stay identical to CHORUS_KNOWN_INSECURE_SECRETS in
 * docker/ensure-secret.sh — a parity test enforces this.
 */
import logger from "@/lib/logger";

export const KNOWN_INSECURE_SECRETS = [
  "chorus-docker-secret-change-in-production",
  "chorus-local-secret",
  "your-secret-key-change-in-production",
  "change-me-to-a-random-secret",
] as const;

export type SecretAssessment =
  | { status: "ok" }
  | { status: "missing" }
  | { status: "known_insecure"; matched: string };

/**
 * Classify a NEXTAUTH_SECRET value.
 *
 * - `undefined` / `""` → `missing`
 * - exact match with a known public placeholder (after trimming surrounding
 *   whitespace) → `known_insecure`
 * - anything else → `ok` (no length or entropy heuristics, by design)
 */
export function assessNextAuthSecret(value: string | undefined): SecretAssessment {
  if (value === undefined || value === "") {
    return { status: "missing" };
  }
  const trimmed = value.trim();
  const matched = KNOWN_INSECURE_SECRETS.find((placeholder) => placeholder === trimmed);
  if (matched !== undefined) {
    return { status: "known_insecure", matched };
  }
  return { status: "ok" };
}

const DEFAULT_SECRET_MESSAGE = [
  "NEXTAUTH_SECRET is set to a publicly known placeholder value.",
  "Anyone who knows this public value can forge user AND super-admin session JWTs and take over this instance.",
  "Generate a strong secret with `openssl rand -base64 32` and set NEXTAUTH_SECRET before exposing this deployment.",
  "Rotating the secret invalidates all existing sessions (every user is logged out).",
  "Multi-replica deployments must share one identical NEXTAUTH_SECRET across all replicas.",
  "Background: https://github.com/Chorus-AIDLC/Chorus/issues/559 (GitHub issue #559).",
].join("\n");

const MISSING_SECRET_MESSAGE =
  "NEXTAUTH_SECRET is not set. Login and session issuance will fail until it is configured; " +
  "generate one with `openssl rand -base64 32`.";

/**
 * Log a startup warning when NEXTAUTH_SECRET is missing or a known placeholder.
 *
 * Never throws and never mutates process.env — logging only.
 */
export function warnOnInsecureNextAuthSecret(): void {
  try {
    const assessment = assessNextAuthSecret(process.env.NEXTAUTH_SECRET);
    if (assessment.status === "ok") return;

    const log = logger.child({ module: "security" });
    if (assessment.status === "known_insecure") {
      log.error(
        { reason: "default_secret", matched: assessment.matched, issue: 559 },
        DEFAULT_SECRET_MESSAGE,
      );
      return;
    }
    log.warn({ reason: "missing_secret" }, MISSING_SECRET_MESSAGE);
  } catch {
    // Defensive: a logging failure must never prevent startup.
  }
}
