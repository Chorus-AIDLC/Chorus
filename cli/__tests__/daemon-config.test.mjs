// cli/__tests__/daemon-config.test.mjs
// Covers the layered sigintTimeoutMs resolution (子3 — daemon-interrupt-resume,
// spec "The timeout SHALL be resolvable through the daemon's layered configuration"):
//   --sigint-timeout flag > CHORUS_DAEMON_SIGINT_TIMEOUT env > daemon.json > 10000.
import { describe, it, expect, vi } from "vitest";
import { resolveSigintTimeoutMs, DEFAULT_SIGINT_TIMEOUT_MS } from "../daemon-config.mjs";

describe("resolveSigintTimeoutMs layered precedence", () => {
  it("defaults to 10000 when no source is present", () => {
    const ms = resolveSigintTimeoutMs({}, { env: {}, readJson: () => null });
    expect(ms).toBe(10_000);
    expect(DEFAULT_SIGINT_TIMEOUT_MS).toBe(10_000);
  });

  it("daemon.json sigintTimeoutMs overrides the default", () => {
    const readJson = vi.fn(() => ({ sigintTimeoutMs: 5000 }));
    const ms = resolveSigintTimeoutMs({}, { env: {}, readJson, loginPath: "/x/daemon.json" });
    expect(ms).toBe(5000);
    expect(readJson).toHaveBeenCalledWith("/x/daemon.json");
  });

  it("env overrides daemon.json", () => {
    const ms = resolveSigintTimeoutMs(
      {},
      { env: { CHORUS_DAEMON_SIGINT_TIMEOUT: "3000" }, readJson: () => ({ sigintTimeoutMs: 5000 }) },
    );
    expect(ms).toBe(3000);
  });

  it("the flag overrides env and daemon.json (highest precedence)", () => {
    const ms = resolveSigintTimeoutMs(
      { sigintTimeout: "1500" },
      { env: { CHORUS_DAEMON_SIGINT_TIMEOUT: "3000" }, readJson: () => ({ sigintTimeoutMs: 5000 }) },
    );
    expect(ms).toBe(1500);
  });

  it("accepts a numeric flag value too", () => {
    const ms = resolveSigintTimeoutMs({ sigintTimeout: 2500 }, { env: {}, readJson: () => null });
    expect(ms).toBe(2500);
  });

  it("ignores a non-positive / non-numeric value and falls through to the next layer", () => {
    // flag is garbage → fall to env; env is 0 → fall to file; file is negative → default.
    const ms = resolveSigintTimeoutMs(
      { sigintTimeout: "abc" },
      { env: { CHORUS_DAEMON_SIGINT_TIMEOUT: "0" }, readJson: () => ({ sigintTimeoutMs: -5 }) },
    );
    expect(ms).toBe(10_000);
  });

  it("floors a fractional value to an integer ms", () => {
    const ms = resolveSigintTimeoutMs({ sigintTimeout: "1999.9" }, { env: {}, readJson: () => null });
    expect(ms).toBe(1999);
  });

  it("a malformed daemon.json (readJson returns null) falls through to the default", () => {
    const ms = resolveSigintTimeoutMs({}, { env: {}, readJson: () => null });
    expect(ms).toBe(10_000);
  });
});
