// cli/__tests__/daemon-config.test.mjs
// Covers the layered sigintTimeoutMs resolution (子3 — daemon-interrupt-resume,
// spec "The timeout SHALL be resolvable through the daemon's layered configuration"):
//   --sigint-timeout flag > CHORUS_DAEMON_SIGINT_TIMEOUT env > daemon.json > 10000.
import { describe, it, expect, vi } from "vitest";
import {
  resolveSigintTimeoutMs,
  DEFAULT_SIGINT_TIMEOUT_MS,
  resolveDaemonCwds,
} from "../daemon-config.mjs";

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

// ===== T3: resolveDaemonCwds — the SET of paths a single daemon serves =====
// FR-5/FR-8, DEC-2/DEC-5: a daemon declares a LIST of cwds (each → one independent
// connection). JUST a path list — no project binding. Layered precedence mirrors
// resolveSigintTimeoutMs: --cwd flag(s) > CHORUS_DAEMON_CWDS env > daemon.json `cwds`
// > [undefined] (single connection at the process cwd / HARD-1 single-path default).
describe("resolveDaemonCwds layered precedence", () => {
  const HOME = "/home/tester";

  it("defaults to [undefined] (single process-cwd connection) when nothing is declared", () => {
    const cwds = resolveDaemonCwds({}, { env: {}, readJson: () => null, home: HOME });
    expect(cwds).toEqual([undefined]);
  });

  it("daemon.json `cwds` declares the SET, resolved to absolute paths + deduped", () => {
    const readJson = vi.fn(() => ({ cwds: ["/dev/repo-a", "/dev/repo-b", "/dev/repo-a"] }));
    const cwds = resolveDaemonCwds(
      {},
      { env: {}, readJson, loginPath: "/x/daemon.json", home: HOME },
    );
    expect(cwds).toEqual(["/dev/repo-a", "/dev/repo-b"]); // dup dropped, order preserved
    expect(readJson).toHaveBeenCalledWith("/x/daemon.json");
  });

  it("env CHORUS_DAEMON_CWDS overrides daemon.json (comma OR colon separated)", () => {
    const comma = resolveDaemonCwds(
      {},
      { env: { CHORUS_DAEMON_CWDS: "/a,/b" }, readJson: () => ({ cwds: ["/from-file"] }), home: HOME },
    );
    expect(comma).toEqual(["/a", "/b"]);
    const colon = resolveDaemonCwds(
      {},
      { env: { CHORUS_DAEMON_CWDS: "/a:/b" }, readJson: () => null, home: HOME, delimiter: "" },
    );
    expect(colon).toEqual(["/a", "/b"]);
  });

  it("the --cwd flag list wins over env and file (highest precedence), repeatable", () => {
    const cwds = resolveDaemonCwds(
      { cwd: ["/flag-a", "/flag-b"] },
      { env: { CHORUS_DAEMON_CWDS: "/env" }, readJson: () => ({ cwds: ["/file"] }), home: HOME },
    );
    expect(cwds).toEqual(["/flag-a", "/flag-b"]);
  });

  it("accepts a single --cwd as a string too", () => {
    const cwds = resolveDaemonCwds({ cwd: "/only" }, { env: {}, readJson: () => null, home: HOME });
    expect(cwds).toEqual(["/only"]);
  });

  it("expands a leading ~ to the home dir", () => {
    const cwds = resolveDaemonCwds(
      { cwd: ["~/dev/x", "~"] },
      { env: {}, readJson: () => null, home: HOME },
    );
    expect(cwds).toEqual([`${HOME}/dev/x`, HOME]);
  });

  it("resolves a relative path to absolute (against process cwd)", () => {
    const cwds = resolveDaemonCwds({ cwd: ["sub/dir"] }, { env: {}, readJson: () => null, home: HOME });
    expect(cwds).toEqual([`${process.cwd()}/sub/dir`]);
  });

  it("drops blank / whitespace-only entries and falls through when all blank", () => {
    // All-blank flag list → fall through to env → file → default.
    const cwds = resolveDaemonCwds(
      { cwd: ["", "   "] },
      { env: {}, readJson: () => null, home: HOME },
    );
    expect(cwds).toEqual([undefined]);
  });

  it("a malformed daemon.json (no `cwds` array) falls through to the default", () => {
    const cwds = resolveDaemonCwds({}, { env: {}, readJson: () => ({ url: "x" }), home: HOME });
    expect(cwds).toEqual([undefined]);
  });

  it("the declaration is JUST paths — it never reads or returns any project binding", () => {
    // Even if a config carried an (ignored) project field, only the path set is used.
    const readJson = vi.fn(() => ({ cwds: ["/dev/repo-a"], projectUuid: "should-be-ignored" }));
    const cwds = resolveDaemonCwds({}, { env: {}, readJson, home: HOME });
    expect(cwds).toEqual(["/dev/repo-a"]);
    // The result is a flat array of strings — no project info threaded anywhere.
    expect(cwds.every((c) => typeof c === "string")).toBe(true);
  });
});
