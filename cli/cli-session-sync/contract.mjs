// cli/cli-session-sync/contract.mjs
// The backend adapter contract for `chorus agents run` session sync
// (OpenSpec change cli-agent-session-sync, design D3). The sync core
// (cli/cli-session-sync.mjs) is backend-agnostic; everything backend-specific — how the
// resume identity is established, how the transcript is read — lives behind this
// contract, one module per backend under cli/cli-session-sync/<backend>.mjs, wired in
// cli/cli-session-sync/index.mjs.
//
// RESUME IDENTITY RULE (design "Module Contracts"): the identity an adapter establishes
// MUST equal what the daemon computes on its next wake for the same Chorus session —
// the daemon never reads the server's informational `backendSessionId` to resume.
//   • caller-supplied-id backends (Claude, Pi): inject backendSessionKey(sessionId, agentUuid)
//     from cli/backend-session-identity.mjs (never a reimplementation);
//   • self-generated-id backends (Codex, Trae, Kiro): discover the id after launch and
//     write the session-map entry (with ownership metadata) the daemon spawner reads.
// When the identity cannot be established (user passed their own session/resume flag,
// ambiguous discovery, …) the adapter reports `continuable:false` — never a guess.

/**
 * @typedef {{ role: "user"|"assistant", text: string }} SyncMessage
 *
 * @typedef {Object} ArgInspection   Pre-registration verdict on the planned argv (pure).
 * @property {boolean} sync          false → this invocation is not a conversation (e.g.
 *                                   `claude mcp list`, `--version`); the core registers
 *                                   nothing and launches exactly as `--no-sync` would.
 * @property {boolean} inject        true → prepareArgs may inject the resume identity.
 * @property {boolean} continuable   false → registered (and released) not continuable.
 * @property {string|null} reason    Machine-readable reason when inject/continuable is false.
 * @property {string|null} [userSessionId]  An explicit session id the USER passed (lets the
 *                                   adapter still tail that transcript read-only).
 * @property {boolean} [userResume]  The user's explicit id names an EXISTING conversation.
 *
 * @typedef {Object} SyncContext     Passed to every post-registration hook.
 * @property {string} sessionId      Chorus business key returned by registration.
 * @property {string} sessionUuid
 * @property {string|undefined} agentUuid
 * @property {string} cwd            Launch cwd (what the daemon serves / probes).
 * @property {NodeJS.ProcessEnv} env The CHILD env (honors profile overlays, e.g. CLAUDE_CONFIG_DIR).
 * @property {NodeJS.Platform} platform
 * @property {number} launchedAt     Epoch ms just before spawn (discovery cut-off).
 * @property {string|null} backendSessionId  From prepareArgs / discoverSessionId.
 * @property {ArgInspection} inspection
 * @property {{ info(m:string):void, warn(m:string):void, error(m:string):void }} logger  File-only sync log.
 *
 * @typedef {Object} TranscriptSource
 * @property {"live"|"on_exit"} mode  live → polled while the child runs AND once at exit;
 *                                    on_exit → read once after the child exits.
 * @property {() => Promise<SyncMessage[]>} next  Messages produced since the last call,
 *                                    already filtered to user/assistant text.
 *
 * @typedef {Object} SessionSyncAdapter
 * @property {string} id
 * @property {(input: { args: string[], userArgs: string[] }) => ArgInspection} [inspectArgs]
 * @property {(args: string[], ctx: SyncContext) => { args: string[], backendSessionId: string|null, continuable?: boolean }} prepareArgs
 * @property {(ctx: SyncContext) => Promise<string|null>} [discoverSessionId]
 * @property {(ctx: SyncContext) => TranscriptSource|null} [transcriptSource]
 * @property {(ctx: SyncContext) => Promise<{ continuable: boolean, reason?: string|null }>} [finalize]
 *   Exit-time verdict (e.g. Claude: no transcript was written → nothing to continue).
 */

/** @returns {ArgInspection} */
export function defaultInspection() {
  return { sync: true, inject: true, continuable: true, reason: null, userSessionId: null, userResume: false };
}

/**
 * Fill optional hooks with neutral defaults so the core never null-checks.
 * @param {SessionSyncAdapter} adapter
 * @returns {Required<SessionSyncAdapter>}
 */
export function normalizeAdapter(adapter) {
  if (!adapter || typeof adapter.prepareArgs !== "function" || typeof adapter.id !== "string") {
    throw new TypeError("session-sync adapter must have an id and a prepareArgs function");
  }
  return {
    id: adapter.id,
    inspectArgs: adapter.inspectArgs ?? (() => defaultInspection()),
    prepareArgs: adapter.prepareArgs,
    discoverSessionId: adapter.discoverSessionId ?? (async (ctx) => ctx.backendSessionId ?? null),
    transcriptSource: adapter.transcriptSource ?? (() => null),
    finalize: adapter.finalize ?? (async () => ({ continuable: true, reason: null })),
  };
}

/**
 * Registration-only adapter for backends with no (or not yet implemented) resume
 * identity: the run is visible in Chorus (registered + released) but never continuable,
 * and no transcript is synced. Args pass through untouched.
 * @param {string} id
 * @returns {SessionSyncAdapter}
 */
export function createNonResumableAdapter(id) {
  return {
    id,
    inspectArgs: () => ({ ...defaultInspection(), inject: false, continuable: false, reason: "backend_not_resumable" }),
    prepareArgs: (args) => ({ args, backendSessionId: null, continuable: false }),
  };
}
