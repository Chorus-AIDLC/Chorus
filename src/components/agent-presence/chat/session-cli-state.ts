// CLI-held conversation state (cli-agent-session-sync D7) — pure helpers shared by the
// transcript header, the reply composer and the conversation list, so "is a terminal
// holding this conversation right now?" and "why can't I send?" have ONE answer each.
//
// Inputs are the session read payload's `{ cli, originBound, continuable }` block (Module
// Contracts) plus the loaded turns. The server's `cli.leased` is a read-time verdict; the
// open transcript patches turns live over SSE while the session row is only re-read on
// the 15 s list poll, so a `cli_session` turn that has already ENDED (release / expiry)
// overrides a stale `leased: true` — the terminal's running turn ends exactly when the
// lease does.

import { CLI_SESSION_TRIGGER } from "@/services/daemon-cli-lease";

// The subset of the session payload these helpers read. Optional so older payloads (and
// fixtures predating the change) degrade to "no CLI, bound, continuable".
export interface CliSessionFields {
  cli?: { leased: boolean; host: string | null; cwd: string | null } | null;
  originBound?: boolean;
  continuable?: boolean;
}

/**
 * Whether a terminal (`chorus agents run`) holds this conversation right now. True when
 * the server reported a live lease AND the newest loaded `cli_session` turn (if any) is
 * still running.
 */
export function isCliLeaseLive(
  session: CliSessionFields | null | undefined,
  turns: ReadonlyArray<{ trigger: string; status: string; seq: number }> = [],
): boolean {
  if (!session?.cli?.leased) return false;
  let newest: { status: string; seq: number } | null = null;
  for (const tn of turns) {
    if (tn.trigger !== CLI_SESSION_TRIGGER) continue;
    if (!newest || tn.seq > newest.seq) newest = tn;
  }
  return newest === null || newest.status === "running";
}

/**
 * The reply composer's send gate, in the server's own precedence (sendInstruction):
 *   not_continuable → refused (409 session_not_continuable), never resumable from Chorus;
 *   unbound         → refused (409 session_unbound), no daemon on the origin machine/dir yet;
 *   queued          → allowed; a terminal holds the lease, so the turn is stored pending and
 *                     delivered when the terminal session ends (origin online-ness is moot);
 *   offline         → read-only (409), the bound origin daemon is offline;
 *   open            → a normal live send.
 */
export type SendGate = "open" | "queued" | "offline" | "unbound" | "not_continuable";

export function deriveSendGate(params: {
  session: CliSessionFields | null | undefined;
  cliLeased: boolean;
  originOnline: boolean;
}): SendGate {
  const { session, cliLeased, originOnline } = params;
  if (session?.continuable === false) return "not_continuable";
  if (session?.originBound === false) return "unbound";
  if (cliLeased) return "queued";
  return originOnline ? "open" : "offline";
}

/** Server 409 reasons (error.details.reason) mapped to the matching gate. */
export function sendGateFromErrorReason(reason: unknown): SendGate | null {
  if (reason === "session_unbound") return "unbound";
  if (reason === "session_not_continuable") return "not_continuable";
  return null;
}

// Fold the list row's fresher CLI-held state onto the open conversation's detail session
// (see `openSession`). Only fields the row actually carries are taken; a detail session
// whose origin is already bound keeps its own origin (a re-point patches it explicitly).
export function mergeCliSessionState<
  S extends Required<CliSessionFields> & { uuid: string; originConnectionUuid: string | null },
>(
  session: S | null,
  row: (CliSessionFields & { uuid: string; originConnectionUuid: string | null }) | null,
): S | null {
  if (!session || !row || row.uuid !== session.uuid) return session;
  const next: S = { ...session };
  let changed = false;
  if (row.cli !== undefined && JSON.stringify(row.cli) !== JSON.stringify(session.cli)) {
    next.cli = row.cli ?? null;
    changed = true;
  }
  if (row.originBound !== undefined && row.originBound !== session.originBound) {
    next.originBound = row.originBound;
    changed = true;
  }
  if (row.continuable !== undefined && row.continuable !== session.continuable) {
    next.continuable = row.continuable;
    changed = true;
  }
  if (session.originConnectionUuid == null && row.originConnectionUuid != null) {
    next.originConnectionUuid = row.originConnectionUuid;
    changed = true;
  }
  return changed ? next : session;
}
