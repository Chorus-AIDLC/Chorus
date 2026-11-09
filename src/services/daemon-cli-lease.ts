// src/services/daemon-cli-lease.ts
// CLI session sync (cli-agent-session-sync) — the dependency-free leaf for the CLI lease and
// the `cli_session` turn exclusion. Kept free of prisma / event-bus imports so every daemon
// service (session, instruction, connection, execution) can share the SAME predicates without
// creating an import cycle.
//
// Two single-sourced rules live here:
//  - `isCliLeased(session, now)` (design D1 / Module Contracts): the ONLY gate every path
//    that delivers a pending turn consults (live deliver_turn ping, the SSE delivery guard,
//    pending-turns backfill and running admission / coalescing). A live lease means the
//    conversation is held by a foreground `chorus agents run`; queued turns stay `pending`.
//  - `isDaemonOwnedTurn(turn)` (design D8): a `cli_session` turn is the foreground CLI's own
//    running turn. It is never delivered to a daemon and is excluded from every piece of
//    daemon turn machinery (reconnect / stale orphan finalization, SSE-drop reconcile,
//    running-turn FIFO resolution, interrupt settlement, merge/coalescing, transcript
//    attribution by business key). `DAEMON_OWNED_TURN` is the equivalent Prisma `where`
//    fragment for query call sites.

/** Trigger of the turn that represents a foreground CLI run (D2/D8). */
export const CLI_SESSION_TRIGGER = "cli_session" as const;

/** Lease TTL: a lease not renewed within this window is treated as released (D1). */
export const CLI_LEASE_TTL_SEC = 60;

/** Heartbeat cadence the server tells the CLI to renew its lease at (D1). */
export const CLI_HEARTBEAT_INTERVAL_SEC = 15;

/** True for every turn the daemon may own — i.e. anything but a `cli_session` turn. */
export function isDaemonOwnedTurn(turn: { trigger: string }): boolean {
  return turn.trigger !== CLI_SESSION_TRIGGER;
}

/**
 * Prisma `DaemonSessionTurnWhereInput` fragment equivalent to {@link isDaemonOwnedTurn}.
 * Spread (or AND) into any turn query that assumes a running/pending turn belongs to a
 * daemon process. Structural literal (not the generated type) to keep this module leaf.
 */
export const DAEMON_OWNED_TURN = { trigger: { not: CLI_SESSION_TRIGGER } } as const;

export interface CliLeaseFields {
  cliLeaseHolder: string | null;
  cliLeaseExpiresAt: Date | null;
}

/** Is the session currently held by a live (unexpired) CLI lease? */
export function isCliLeased(session: CliLeaseFields, now: Date = new Date()): boolean {
  return (
    session.cliLeaseHolder != null &&
    session.cliLeaseExpiresAt != null &&
    session.cliLeaseExpiresAt.getTime() > now.getTime()
  );
}

/**
 * Does the session carry a lease that has EXPIRED but has not been swept yet? Such a lease is
 * treated as released (D4 lazy check) — the caller claims it with the conditional clear and
 * drains the queued turns.
 */
export function hasExpiredCliLease(session: CliLeaseFields, now: Date = new Date()): boolean {
  return session.cliLeaseHolder != null && !isCliLeased(session, now);
}

/** Prisma `DaemonSessionWhereInput` fragment: sessions with no live CLI lease at `now`. */
export function notCliLeasedWhere(now: Date = new Date()) {
  return {
    OR: [{ cliLeaseHolder: null }, { cliLeaseExpiresAt: null }, { cliLeaseExpiresAt: { lte: now } }],
  };
}

/** Session read payload block (Module Contracts): `{ leased, host, cwd } | null`. */
export interface CliSessionView {
  leased: boolean;
  host: string | null;
  cwd: string | null;
}

/**
 * Project the `cli` read-payload block. Non-null only for a CLI-registered session (one that
 * recorded a launch host/cwd); `leased` is the live-lease verdict at read time.
 */
export function toCliSessionView(
  session: CliLeaseFields & { cliHost: string | null; cliCwd: string | null },
  now: Date = new Date(),
): CliSessionView | null {
  if (session.cliHost == null && session.cliCwd == null && session.cliLeaseHolder == null) {
    return null;
  }
  return { leased: isCliLeased(session, now), host: session.cliHost, cwd: session.cliCwd };
}

/** Component-aware path containment (`/a/b` contains `/a/b` and `/a/b/c`, not `/a/bc`). */
export function pathContains(root: string, candidate: string): boolean {
  const trim = (p: string) => (p.length > 1 ? p.replace(/[\\/]+$/, "") : p);
  const r = trim(root);
  const c = trim(candidate);
  if (!r || !c) return false;
  if (c === r) return true;
  const sep = r.endsWith("/") || r.endsWith("\\") ? "" : r.includes("\\") && !r.includes("/") ? "\\" : "/";
  return c.startsWith(r + sep);
}
