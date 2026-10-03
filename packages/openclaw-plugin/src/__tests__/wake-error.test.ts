import { afterEach, describe, expect, it, vi } from "vitest";
import { createWakeError } from "../wake-error.js";

afterEach(() => vi.unstubAllEnvs());

describe("OpenClaw wake diagnostics", () => {
  it("does not mistake token counts, flags or short settings for credentials", () => {
    vi.stubEnv("CLAUDE_CODE_MAX_OUTPUT_TOKENS", "32000");
    vi.stubEnv("MAX_THINKING_TOKENS", "1");
    vi.stubEnv("EXTRA_TOKENS", "3200000000");
    vi.stubEnv("ENABLE_TOKEN", "true");
    vi.stubEnv("OPTIONAL_SECRET", "word");
    const text = "Error: status 1 at line 132000, retry=true, word count=3200000000";
    expect(createWakeError({ message: text, details: text })).toMatchObject({
      message: text, details: text,
    });
  });

  it("still redacts short explicit credentials and credential environment values", () => {
    vi.stubEnv("CUSTOM_PASSWORD", "xyz");
    vi.stubEnv("ACCESS_TOKEN", "abcdefgh-long-token");
    const error = createWakeError({ message: "Denied abc xyz abcdefgh-long-token" }, ["abc"]);
    expect(error.message).toBe("Denied [redacted] [redacted] [redacted]");
  });

  it("preserves the common shape and bounds sanitized text", () => {
    const error = createWakeError({
      message: `\u001b[31m${"m".repeat(550)}\u001b[0m`,
      details: `${"d".repeat(8100)}\u0000`,
    });
    expect(error).toEqual({
      kind: "execution", source: "openclaw", message: "m".repeat(500),
      details: "d".repeat(8000), exitCode: null, signal: null,
    });
  });

  it("uses a useful fallback when the host returned no error text", () => {
    expect(createWakeError({ message: undefined })).toMatchObject({
      message: "OpenClaw agent wake failed", details: null,
    });
  });

  it("extracts a host's object-shaped rejection message", () => {
    expect(createWakeError({ message: { message: "Provider unavailable" } }).message)
      .toBe("Provider unavailable");
  });

  it.each(["literal", "json", "url"] as const)("redacts %s credential forms before truncation", (form) => {
    const secret = 'pass"word\\callback/token';
    vi.stubEnv("CUSTOM_PASSWORD", secret);
    const text = form === "json" ? JSON.stringify(secret).slice(1, -1)
      : form === "url" ? encodeURIComponent(secret) : secret;
    const error = createWakeError({
      message: "m".repeat(490) + text,
      details: "d".repeat(7980) + text,
    });
    expect(error.message).toContain("[redacted]");
    expect(error.details).toContain("[redacted]");
    expect(error.details).not.toContain(text.slice(0, 10));
  });

  it("redacts supplied transport credentials and authorization patterns", () => {
    const error = createWakeError({
      message: new Error("Bearer provider-value"),
      details: 'password=private-value cho_agent-value transport-value',
    }, ["transport-value"]);
    expect(JSON.stringify(error)).not.toMatch(/provider-value|private-value|cho_agent-value|transport-value/);
  });
});
