// cli/cli-session-sync/self-id.mjs
// Shared binding logic for backends whose CLI GENERATES its own conversation id
// (Codex / TRAE threads, Kiro sessions): discover the id this run created, claim it in
// the daemon's session map under the key the daemon looks up, and re-verify at exit.
//
// Discovery rule (design D3 / Risks): a candidate must be in the launch cwd and created
// at/after launch (the backend-specific `listCandidates` applies those filters). Ids
// already mapped under ANOTHER key (claimed by a concurrent `chorus agents run`, or by
// the daemon) are skipped. Exactly one free candidate → bind; more than one → keep
// waiting (another run may claim its own); none → keep waiting. At exit the set is
// recomputed: if any other free candidate appeared (two terminals in one cwd, an
// in-TUI "new session", …) the binding is withdrawn and the run is released
// `continuable:false` — never a guess.

import { backendSessionKey } from "../backend-session-identity.mjs";

/**
 * @template {{ id: string }} C
 * @param {{
 *   label: string,
 *   listCandidates: (ctx: import("./contract.mjs").SyncContext) => C[],
 *   map: { entries: () => Record<string,string>, set: (k: string, v: string) => void, remove: (k: string, v: string) => void },
 *   onBound?: (ctx: import("./contract.mjs").SyncContext, c: C, key: string) => void,
 *   onUnbound?: (ctx: import("./contract.mjs").SyncContext, id: string, key: string) => void,
 * }} o
 */
export function createSelfIdBinding(o) {
  let bound = null; // { id, key, candidate }
  let ambiguousSeen = false;

  const keyFor = (ctx) =>
    typeof ctx.agentUuid === "string" && ctx.agentUuid && typeof ctx.sessionId === "string" && ctx.sessionId
      ? backendSessionKey(ctx.sessionId, ctx.agentUuid)
      : null;

  function freeCandidates(ctx, key) {
    let claimed;
    try {
      claimed = new Set(Object.entries(o.map.entries()).filter(([k]) => k !== key).map(([, v]) => v));
    } catch {
      claimed = new Set();
    }
    let list = [];
    try {
      list = o.listCandidates(ctx) ?? [];
    } catch (err) {
      ctx.logger.warn(`[sync] ${o.label}: session store scan failed: ${err?.message ?? err}`);
    }
    const seen = new Set();
    return list.filter((c) => c && typeof c.id === "string" && !claimed.has(c.id) && !seen.has(c.id) && seen.add(c.id));
  }

  return {
    keyFor,
    /** @returns {C|null} */
    candidate: () => bound?.candidate ?? null,

    async discover(ctx) {
      if (bound) return bound.id;
      const key = keyFor(ctx);
      if (!key) return null;
      const free = freeCandidates(ctx, key);
      if (free.length === 1) {
        bound = { id: free[0].id, key, candidate: free[0] };
        o.map.set(key, bound.id);
        try {
          o.onBound?.(ctx, free[0], key);
        } catch (err) {
          ctx.logger.warn(`[sync] ${o.label}: ownership record failed: ${err?.message ?? err}`);
        }
        ctx.logger.info(`[sync] ${o.label}: bound the new session to the Chorus session map`);
        return bound.id;
      }
      if (free.length > 1 && !ambiguousSeen) {
        ambiguousSeen = true;
        ctx.logger.warn(`[sync] ${o.label}: ${free.length} new sessions in this directory since launch; waiting for a unique one`);
      }
      return null;
    },

    async finalize(ctx) {
      if (!bound) {
        return { continuable: false, reason: ambiguousSeen ? "ambiguous_session" : "no_session_discovered" };
      }
      const others = freeCandidates(ctx, bound.key).filter((c) => c.id !== bound.id);
      if (others.length > 0) {
        ctx.logger.warn(`[sync] ${o.label}: another new session appeared in this directory; withdrawing the binding`);
        o.map.remove(bound.key, bound.id);
        try {
          o.onUnbound?.(ctx, bound.id, bound.key);
        } catch {
          /* best-effort */
        }
        return { continuable: false, reason: "ambiguous_session" };
      }
      o.map.set(bound.key, bound.id); // idempotent re-assert
      return { continuable: true, reason: null };
    },
  };
}
