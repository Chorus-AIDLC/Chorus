import { describe, it, expect } from "vitest";
import {
  CLI_HEARTBEAT_INTERVAL_SEC, CLI_LEASE_TTL_SEC, CLI_SESSION_TRIGGER, DAEMON_OWNED_TURN,
  hasExpiredCliLease, isCliLeased, isDaemonOwnedTurn, notCliLeasedWhere, pathContains, toCliSessionView,
} from "@/services/daemon-cli-lease";

const now = new Date("2026-11-09T12:00:00Z");
const later = new Date(now.getTime() + 1000);
const earlier = new Date(now.getTime() - 1000);

describe("daemon-cli-lease", () => {
  it("pins the lease contract constants", () => {
    expect(CLI_SESSION_TRIGGER).toBe("cli_session");
    expect(CLI_LEASE_TTL_SEC).toBe(60);
    expect(CLI_HEARTBEAT_INTERVAL_SEC).toBe(15);
    expect(DAEMON_OWNED_TURN).toEqual({ trigger: { not: "cli_session" } });
  });

  it("isDaemonOwnedTurn excludes only cli_session turns", () => {
    expect(isDaemonOwnedTurn({ trigger: "cli_session" })).toBe(false);
    expect(isDaemonOwnedTurn({ trigger: "human_instruction" })).toBe(true);
  });

  it("isCliLeased / hasExpiredCliLease", () => {
    expect(isCliLeased({ cliLeaseHolder: "h", cliLeaseExpiresAt: later }, now)).toBe(true);
    expect(isCliLeased({ cliLeaseHolder: "h", cliLeaseExpiresAt: now }, now)).toBe(false);
    expect(isCliLeased({ cliLeaseHolder: null, cliLeaseExpiresAt: later }, now)).toBe(false);
    expect(isCliLeased({ cliLeaseHolder: "h", cliLeaseExpiresAt: null }, now)).toBe(false);
    expect(isCliLeased({ cliLeaseHolder: "h", cliLeaseExpiresAt: new Date(Date.now() + 5000) })).toBe(true);
    expect(hasExpiredCliLease({ cliLeaseHolder: "h", cliLeaseExpiresAt: earlier }, now)).toBe(true);
    expect(hasExpiredCliLease({ cliLeaseHolder: "h", cliLeaseExpiresAt: later }, now)).toBe(false);
    expect(hasExpiredCliLease({ cliLeaseHolder: null, cliLeaseExpiresAt: null }, now)).toBe(false);
    expect(hasExpiredCliLease({ cliLeaseHolder: null, cliLeaseExpiresAt: null })).toBe(false);
  });

  it("notCliLeasedWhere matches sessions without a live lease", () => {
    expect(notCliLeasedWhere(now)).toEqual({
      OR: [{ cliLeaseHolder: null }, { cliLeaseExpiresAt: null }, { cliLeaseExpiresAt: { lte: now } }],
    });
    expect(notCliLeasedWhere().OR).toHaveLength(3);
  });

  it("toCliSessionView is null for daemon sessions and carries the launch place for CLI ones", () => {
    expect(toCliSessionView({ cliLeaseHolder: null, cliLeaseExpiresAt: null, cliHost: null, cliCwd: null }, now)).toBeNull();
    expect(toCliSessionView({ cliLeaseHolder: "h", cliLeaseExpiresAt: later, cliHost: "box", cliCwd: "/r" }, now))
      .toEqual({ leased: true, host: "box", cwd: "/r" });
    expect(toCliSessionView({ cliLeaseHolder: null, cliLeaseExpiresAt: null, cliHost: "box", cliCwd: "/r" }))
      .toEqual({ leased: false, host: "box", cwd: "/r" });
  });

  it("pathContains is component-aware", () => {
    expect(pathContains("/home/u", "/home/u")).toBe(true);
    expect(pathContains("/home/u/", "/home/u/repo")).toBe(true);
    expect(pathContains("/home/u", "/home/u/repo/")).toBe(true);
    expect(pathContains("/home/u", "/home/user")).toBe(false);
    expect(pathContains("/", "/etc")).toBe(true);
    expect(pathContains("C:\\Users\\u", "C:\\Users\\u\\repo")).toBe(true);
    expect(pathContains("", "/x")).toBe(false);
  });
});
