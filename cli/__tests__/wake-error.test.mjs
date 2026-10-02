import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWakeError, createWakeErrorCollector, sanitizeWakeErrorText,
  WAKE_ERROR_STDERR_LIMIT, wakeErrorText,
} from "../wake-error.mjs";

afterEach(() => vi.unstubAllEnvs());

describe("bounded wake diagnostics", () => {
  it("exposes a reusable exact-contract builder for reporting startup exceptions", () => {
    expect(createWakeError({ source: "openclaw", kind: "startup", message: new Error(" launch rejected ") }))
      .toEqual({ source: "openclaw", kind: "startup", message: "launch rejected",
        details: null, exitCode: null, signal: null });
    expect(wakeErrorText({ opaque: "payload" })).toBe("");
    expect(wakeErrorText(["first", "", "second"])).toBe("first\nsecond");
  });

  it("redacts authoritative, overlaid and actual runtime callback credentials and token patterns", () => {
    vi.stubEnv("CHORUS_CALLBACK_API_KEY", "actual-callback-secret");
    vi.stubEnv("CHORUS_API_KEY", "inherited-secret");
    const text = "\u001b[31mDenied\u001b[0m\u0000\u0007\n" +
      "actual-callback-secret inherited-secret configured-secret daemon-secret\n" +
      "Authorization: Bearer unknown-token\nCHORUS_API_KEY=cho_unknown";
    const clean = sanitizeWakeErrorText(text, {
      env: { CHORUS_API_KEY: "configured-secret" }, creds: { apiKey: "daemon-secret" },
    });
    expect(clean).toContain("Denied");
    expect(clean).toContain("[redacted]");
    for (const secret of ["actual-callback-secret", "inherited-secret", "configured-secret",
      "daemon-secret", "unknown-token", "cho_unknown"]) expect(clean).not.toContain(secret);
    expect(clean).not.toMatch(/[\u0000-\u0008\u000b-\u001f]/);
  });

  it("bounds stderr on every chunk, including a huge line and keys split between chunks", () => {
    const collector = createWakeErrorCollector({ source: "kiro", secrets: ["runtime-key-123456"] });
    for (let i = 0; i < 100; i++) {
      collector.appendStderr("x".repeat(100_000));
      expect(collector.stderrLength).toBeLessThanOrEqual(WAKE_ERROR_STDERR_LIMIT);
    }
    collector.appendStderr("\n\u001b[33munauthorized runtime-");
    collector.appendStderr("key-123456\u001b[0m\n");
    const error = collector.build({ exitCode: 2 });
    expect(error.details.length).toBeLessThanOrEqual(8000);
    expect(error.message).toContain("unauthorized [redacted]");
    expect(error.details).not.toContain("runtime-key-123456");
    expect(error.details).not.toContain("\u001b");
  });

  it("redacts a key sliced by the retained-tail boundary", () => {
    const collector = createWakeErrorCollector({ source: "pi", secrets: ["secret-credential-value"] });
    collector.appendStderr("secret-credential-value" + "\u0000".repeat(WAKE_ERROR_STDERR_LIMIT - 8));
    expect(collector.stderrTail).not.toContain("al-value");
    expect(collector.stderrTail).toBe("[redacted]");
  });

  it("prefers the first structured reason, includes complementary stderr and preserves raw zero", () => {
    const collector = createWakeErrorCollector({ source: "codex" });
    collector.appendStderr("provider warning");
    collector.fail("Authentication rejected", "execution");
    collector.fail("Cleanup failed", "protocol");
    expect(collector.build({ exitCode: 0 })).toEqual({
      source: "codex", kind: "execution", message: "Authentication rejected",
      details: "Authentication rejected\n\nprovider warning", exitCode: 0, signal: null,
    });
  });

  it.each([
    [{ exitCode: 7 }, "code 7"],
    [{ signal: "SIGTERM" }, "SIGTERM"],
    [{}, "without an available process exit code"],
  ])("has an honest nonblank fallback for %j", (metadata, expected) => {
    const error = createWakeError({ source: "claude", message: "\u001b[31m \u001b[0m", ...metadata });
    expect(error.message).toContain(expected);
  });

  it("bounds all text after sanitization and never reveals keys cut by the summary limit", () => {
    const error = createWakeError({
      source: "dsh", message: "x".repeat(490) + "known-credential", details: "y".repeat(10_000),
      signal: "s".repeat(100), exitCode: 1.5,
    }, { secrets: ["known-credential"] });
    expect(error.message.length).toBe(500);
    expect(error.message).not.toContain("known");
    expect(error.details.length).toBe(8000);
    expect(error.signal.length).toBe(50);
    expect(error.exitCode).toBeNull();
  });

  it.each(["literal", "JSON", "URL"])("redacts %s forms at both retained and published stderr boundaries", (representation) => {
    const secret = 'callback/"\\+known-value';
    const form = representation === "JSON" ? JSON.stringify(secret).slice(1, -1)
      : representation === "URL" ? encodeURIComponent(secret) : secret;
    const options = { env: { CHORUS_CALLBACK_API_KEY: secret } };
    const collector = createWakeErrorCollector({ source: "pi", ...options });
    collector.appendStderr(form + "\u0000".repeat(WAKE_ERROR_STDERR_LIMIT - 12));
    expect(collector.stderrLength).toBe(WAKE_ERROR_STDERR_LIMIT);
    expect(collector.stderrTail).toBe("[redacted]");
    expect(collector.build({ exitCode: 1 }).details).toBe("[redacted]");

    const next = createWakeErrorCollector({ source: "claude", ...options });
    next.appendStderr("x".repeat(500) + form + "y".repeat(7990));
    const error = next.build({ exitCode: 1 });
    expect(error.details).not.toContain("known-value");
    expect(error.message.length).toBeLessThanOrEqual(500);
    expect(error.details.length).toBeLessThanOrEqual(8000);
  });

  it.each(["extract", "collector", "builder"])("sanitizes array entries before bounded %s assembly", (path) => {
    const secret = "callback-1234567890-abcdefghij";
    const options = { env: { CHORUS_CALLBACK_API_KEY: secret } };
    const input = ["x".repeat(7980) + secret];
    let text;
    if (path === "extract") text = wakeErrorText(input, options);
    if (path === "builder") text = createWakeError({ source: "claude", message: "failed", details: input }, options).details;
    if (path === "collector") {
      const collector = createWakeErrorCollector({ source: "claude", ...options });
      collector.fail(input);
      text = collector.build({ exitCode: 0 }).details;
    }
    expect(text.length).toBeLessThanOrEqual(8000);
    expect(text).toContain("[redacted]");
    expect(text).not.toContain("callback-");
  });
});
