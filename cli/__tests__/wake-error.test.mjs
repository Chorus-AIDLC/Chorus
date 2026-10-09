import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWakeError, createWakeErrorCollector, sanitizeWakeErrorText,
  WAKE_ERROR_MIN_TAIL_MATCH, WAKE_ERROR_STDERR_LIMIT, wakeErrorText,
} from "../wake-error.mjs";

afterEach(() => vi.unstubAllEnvs());

describe("bounded wake diagnostics", () => {
  it("keeps token counts, flags and short inferred settings readable", () => {
    const env = {
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "32000",
      MAX_THINKING_TOKENS: "1",
      EXTRA_TOKENS: "3200000000",
      ENABLE_TOKEN: "true",
      OPTIONAL_SECRET: "word",
    };
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const text = "Error: status 1 at line 132000, retry=true, word count=3200000000";
    expect(sanitizeWakeErrorText(text, { env })).toBe(text);
  });

  it("still protects short explicit credentials and password/API-key environment values", () => {
    const text = "Denied abc xyz 123 abcdefgh-long-token";
    expect(sanitizeWakeErrorText(text, {
      creds: { apiKey: "abc" }, secrets: ["123"],
      env: { CUSTOM_PASSWORD: "xyz", ACCESS_TOKEN: "abcdefgh-long-token" },
    })).toBe("Denied [redacted] [redacted] [redacted] [redacted]");
  });

  it("uses stderr before a delivery fallback without losing the fallback detail", () => {
    const collector = createWakeErrorCollector({ source: "claude" });
    collector.failFallback("stdin closed", "protocol");
    collector.appendStderr("Error: Invalid API key\n");
    expect(collector.hasFailure).toBe(true);
    expect(collector.build({ exitCode: 1 })).toEqual({
      source: "claude", kind: "execution", message: "Error: Invalid API key",
      details: "Error: Invalid API key\n\nstdin closed", exitCode: 1, signal: null,
    });
  });

  it("keeps authoritative errors ahead of stderr and delivery fallbacks", () => {
    const collector = createWakeErrorCollector({ source: "pi" });
    collector.failFallback("stdin closed", "protocol");
    collector.appendStderr("provider warning");
    collector.fail("Authentication rejected", "execution");
    expect(collector.build({ exitCode: 0 })).toMatchObject({
      kind: "execution", message: "Authentication rejected", exitCode: 0,
    });
  });

  it("falls back to a delivery failure when there is no backend error text", () => {
    const collector = createWakeErrorCollector({ source: "dsh" });
    collector.failFallback("stdin closed", "protocol");
    expect(collector.build({ exitCode: 0 })).toMatchObject({
      kind: "protocol", message: "stdin closed", details: "stdin closed", exitCode: 0,
    });
  });

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

  describe("retained-tail repair without ambient credentials", () => {
    // knownSecrets always folds in process.env; blank every credential-looking
    // variable so these cases reproduce identically on a laptop and a bare CI runner.
    beforeEach(() => {
      for (const key of Object.keys(process.env)) {
        if (/(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)/i.test(key)) vi.stubEnv(key, "");
      }
    });

    // Retain `secret.slice(cut)` at the head of the window; NUL filler is
    // stripped by sanitization, so the head is all that reaches stderrTail.
    function retainedTail(secret, cut, secrets) {
      const collector = createWakeErrorCollector({ source: "pi", secrets });
      collector.appendStderr(secret + "\u0000".repeat(WAKE_ERROR_STDERR_LIMIT - (secret.length - cut)));
      return collector.stderrTail;
    }

    it("does not let a weak match on a longer unrelated credential shadow the cut one", () => {
      const cut = "secret-credential-value";
      // Longer, so it is scored first, and ends with the residue's first byte.
      const unrelated = "unrelated-much-longer-credential-a";
      expect(retainedTail(cut, 15, [unrelated, cut])).toBe("[redacted]");
      // Order of the explicit list must not matter either.
      expect(retainedTail(cut, 15, [cut, unrelated])).toBe("[redacted]");
    });

    it("leaves sub-threshold residue alone instead of mis-redacting unrelated text", () => {
      // A 3-char tail collides with this credential's last bytes, but is below
      // WAKE_ERROR_MIN_TAIL_MATCH, so it is not evidence of a cut key.
      expect(retainedTail("#ue rest of a diagnostic", 1, ["unrelated-credential-value"]))
        .toBe("ue rest of a diagnostic");
    });

    it("bounds the residue at every cut offset for secret lengths 1..64", () => {
      const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789-";
      for (let length = 1; length <= 64; length++) {
        const secret = Array.from({ length }, (_, i) => alphabet[(i * 7 + length) % alphabet.length]).join("");
        for (let cut = 0; cut < length; cut++) {
          const rest = secret.slice(cut);
          // Worst case for shadowing: a longer credential that ends with the
          // residue's leading bytes (up to the sub-threshold maximum).
          const decoy = "decoy-credential-" + "z".repeat(64) +
            rest.slice(0, Math.min(rest.length, WAKE_ERROR_MIN_TAIL_MATCH - 1));
          const tail = retainedTail(secret, cut, [decoy, secret]);
          // Tails shorter than the threshold are the documented, accepted residue.
          const expected = cut === 0 || rest.length >= WAKE_ERROR_MIN_TAIL_MATCH ? "[redacted]" : rest;
          expect(tail, `length=${length} cut=${cut}`).toBe(expected);
        }
      }
    });
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
