import { afterEach, describe, expect, it, vi } from "vitest";
import { createWakeError } from "../wake-error.js";

afterEach(() => vi.unstubAllEnvs());

describe("OpenClaw wake diagnostics", () => {
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
