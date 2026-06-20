/**
 * Ambient module shim for the OpenClaw 2026.5.x Plugin SDK.
 *
 * WHY THIS EXISTS:
 * The plugin's runtime entry imports `definePluginEntry` from the subpath
 * `openclaw/plugin-sdk/plugin-entry`. That subpath export only exists in the
 * OpenClaw 2026.5.30 Plugin SDK. The `openclaw` package currently resolvable in
 * this workspace's node_modules is an older build (2026.3.x) that does NOT
 * export `./plugin-sdk/plugin-entry`, so `tsc` cannot resolve the import from
 * the real package and would fail type-checking.
 *
 * Rather than bundle/install the full 2026.5.30 OpenClaw package just to satisfy
 * `tsc --noEmit`, we declare a minimal ambient module with a permissive
 * signature. At install/runtime the real host provides the actual SDK
 * (the package.json `peerDependencies.openclaw` floor + the
 * `openclaw.compat.pluginApi >=2026.5.30` gate enforce the version contract);
 * this declaration is purely a compile-time bridge.
 *
 * The signature mirrors `definePluginEntry` from
 * `../openclaw/src/plugin-sdk/plugin-entry.ts` (verified against OpenClaw
 * 2026.5.30). `api` is typed `unknown`-ish via a permissive shape so the entry
 * file stays readable without pulling in the full `OpenClawPluginApi` type
 * graph. When the workspace upgrades to an `openclaw` build that exports
 * `plugin-sdk/plugin-entry`, delete this shim and rely on the real types.
 */
declare module "openclaw/plugin-sdk/plugin-entry" {
  /** Public registration modes surfaced to plugin `register(api)` calls. */
  export type PluginRegistrationMode =
    | "full"
    | "discovery"
    | "tool-discovery"
    | "setup-only"
    | "setup-runtime"
    | "cli-metadata";

  /** JSON-Schema / parser config contract accepted by plugin entries. */
  export type OpenClawPluginConfigSchema = {
    safeParse?: (value: unknown) => unknown;
    parse?: (value: unknown) => unknown;
    validate?: (value: unknown) => unknown;
    uiHints?: Record<string, unknown>;
    jsonSchema?: Record<string, unknown>;
  };

  // ===========================================================================
  // Runtime SDK surface (`api.runtime`) — typed against the REAL ../openclaw
  // source so the daemon call sites are compile-time checked rather than
  // `unknown`-cast. We declare ONLY the minimal slice the plugin consumes; the
  // full `PluginRuntime` graph (subagent/nodes/channel/media/...) is not pulled
  // in. Every shape below was verified field-by-field against the real source
  // (file:line citations inline) — NOT from memory.
  //
  // WHY HAND-DECLARED (not imported from `openclaw/plugin-sdk`): the real
  // package exports `./plugin-sdk` (package.json exports map) but NOT the
  // `./plugin-sdk/plugin-entry` subpath this plugin imports, and the `openclaw`
  // build resolvable in this workspace is an older 2026.3.x that lacks both.
  // Importing the real defs would also couple this separately-published package
  // to the full `openclaw` type graph (llm-core, markdown-core, …) and turn the
  // peer into a build-time hard dependency. The plugin must build/pack
  // standalone (peerDependencies.openclaw only), so we mirror the minimal slice.
  // ===========================================================================

  /**
   * `BlockReplyPayload` — payload for the `onBlockReply` streaming callback.
   * Verified: ../openclaw/src/agents/embedded-agent-payloads.ts:1-11.
   * The plugin's transcript reporter reads only `.text`.
   */
  export type OpenClawBlockReplyPayload = {
    text?: string;
    mediaUrls?: string[];
    audioAsVoice?: boolean;
    trustedLocalMedia?: boolean;
    sensitiveMedia?: boolean;
    isReasoning?: boolean;
    replyToId?: string;
    replyToTag?: boolean;
    replyToCurrent?: boolean;
  };

  /**
   * `ReplyPayload` (subset) — payload for the `onToolResult` streaming callback.
   * Verified: ../openclaw/src/auto-reply/reply-payload.ts:7-60 (only the fields
   * the plugin may read are declared; the rest of the large union is omitted via
   * the index signature).
   */
  export type OpenClawReplyPayload = {
    text?: string;
    mediaUrl?: string;
    mediaUrls?: string[];
    isError?: boolean;
    isReasoning?: boolean;
    isReasoningSnapshot?: boolean;
    channelData?: Record<string, unknown>;
    [key: string]: unknown;
  };

  /**
   * What initiated an embedded run.
   * Verified: ../openclaw/src/agents/embedded-agent-runner/run/params.ts:32
   * (`EmbeddedRunTrigger`).
   */
  export type OpenClawEmbeddedRunTrigger =
    | "cron"
    | "heartbeat"
    | "manual"
    | "memory"
    | "overflow"
    | "user";

  /**
   * Params for `runtime.agent.runEmbeddedAgent`.
   *
   * The real `RunEmbeddedAgentParams` has ~100 fields, almost all optional;
   * verified against ../openclaw/src/agents/embedded-agent-runner/run/params.ts.
   * We declare exactly the fields the plugin passes/uses (required ones with
   * their real required/optional-ness) plus the daemon-parity fields
   * (`abortSignal` + per-message streaming callbacks) the dependent tasks
   * consume, and keep an index signature for the untouched remainder so the
   * type stays a faithful subset rather than a closed shape.
   *
   * Required-field cites (params.ts): sessionId:40, sessionFile:104,
   * workspaceDir:105, prompt:111, timeoutMs:155, runId:166.
   * Optional-field cites: sessionKey:41, agentId:46, trigger:51, agentDir:108,
   * config:109, provider:122, model:123, disableMessageTool:91,
   * runTimeoutOverrideMs:165, abortSignal:167, onAssistantMessageStart:190,
   * onBlockReply:191, onReasoningStream:195-199, onToolResult:201.
   */
  export type RunEmbeddedAgentParams = {
    sessionId: string;
    sessionFile: string;
    workspaceDir: string;
    prompt: string;
    timeoutMs: number;
    runId: string;
    sessionKey?: string;
    agentId?: string;
    trigger?: OpenClawEmbeddedRunTrigger;
    agentDir?: string;
    // The real type is `OpenClawConfig`; the plugin passes through the opaque
    // `api.config` snapshot, so `unknown` keeps it pass-through-safe.
    config?: unknown;
    provider?: string;
    model?: string;
    disableMessageTool?: boolean;
    runTimeoutOverrideMs?: number;
    /** Cooperative mid-run interrupt; relayed through the whole run. (params.ts:167) */
    abortSignal?: AbortSignal;
    /** Fires when the assistant begins a message. (params.ts:190) */
    onAssistantMessageStart?: () => void | Promise<void>;
    /** Fires per finalized assistant text block — the transcript source. (params.ts:191) */
    onBlockReply?: (payload: OpenClawBlockReplyPayload) => void | Promise<void>;
    /** Fires for reasoning/thinking deltas; NOT posted to the transcript. (params.ts:195) */
    onReasoningStream?: (payload: {
      text?: string;
      mediaUrls?: string[];
      isReasoningSnapshot?: boolean;
    }) => void | Promise<void>;
    /** Fires per tool result. (params.ts:201) */
    onToolResult?: (payload: OpenClawReplyPayload) => void | Promise<void>;
    // The real type carries many more optional fields; allow them without
    // re-declaring the full graph.
    [key: string]: unknown;
  };

  /**
   * Result of `runtime.agent.runEmbeddedAgent`.
   * Verified: ../openclaw/src/agents/embedded-agent-runner/types.ts:179-212
   * (`EmbeddedAgentRunResult`) and its `meta: EmbeddedAgentRunMeta` at :137-177.
   * The plugin reads `meta.aborted` to distinguish a user-abort from a crash.
   */
  export type EmbeddedAgentRunMeta = {
    durationMs: number;
    /** True when the run was aborted via `abortSignal`. (types.ts:140) */
    aborted?: boolean;
    finalAssistantVisibleText?: string;
    stopReason?: string;
    [key: string]: unknown;
  };
  export type EmbeddedAgentRunResult = {
    meta: EmbeddedAgentRunMeta;
    payloads?: Array<{ text?: string; isError?: boolean; isReasoning?: boolean }>;
    [key: string]: unknown;
  };

  /**
   * Session store entry (subset).
   * Verified: ../openclaw/src/config/sessions/types.ts — `sessionId:254`,
   * `sessionFile?:256`. Returned by `getSessionEntry`.
   */
  export type OpenClawSessionEntry = {
    sessionId: string;
    sessionFile?: string;
    [key: string]: unknown;
  };

  /**
   * The `runtime.agent` slice the plugin consumes.
   * Verified: ../openclaw/src/plugins/runtime/types-core.ts:180-221
   * (`PluginRuntimeCore.agent`). Each member's signature confirmed at its real
   * definition site (cited per member).
   */
  export type OpenClawRuntimeAgent = {
    /** params.ts/run.ts:458 — `(params) => Promise<EmbeddedAgentRunResult>`. */
    runEmbeddedAgent: (params: RunEmbeddedAgentParams) => Promise<EmbeddedAgentRunResult>;
    /** agent-scope-config.ts:195 — positional `(cfg, agentId)`, returns the agent dir. */
    resolveAgentDir: (cfg: unknown, agentId: string) => string;
    /** agent-scope-config.ts:170 — positional `(cfg, agentId)`, returns the workspace dir. */
    resolveAgentWorkspaceDir: (cfg: unknown, agentId: string) => string;
    /** timeout.ts:15 — options-object `({ cfg }) => number`. */
    resolveAgentTimeoutMs: (opts: {
      cfg?: unknown;
      overrideMs?: number | null;
      overrideSeconds?: number | null;
      minMs?: number;
    }) => number;
    session: {
      /** store.ts:210 — `({ sessionKey, agentId? }) => SessionEntry | undefined`. */
      getSessionEntry: (options: {
        sessionKey: string;
        agentId?: string;
        env?: NodeJS.ProcessEnv;
        storePath?: string;
      }) => OpenClawSessionEntry | undefined;
      /** paths.ts:267 — `(sessionId, entry?, opts?) => string`. */
      resolveSessionFilePath: (
        sessionId: string,
        entry?: { sessionFile?: string },
        opts?: { agentId?: string; sessionsDir?: string },
      ) => string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };

  /**
   * The `runtime.config` slice the plugin consumes (MCP-server registration).
   * Verified: ../openclaw/src/plugins/runtime/types-core.ts:145-178
   * (`PluginRuntimeCore.config`). The plugin uses `current()` to read the live
   * config snapshot and `mutateConfigFile(...)` to write the `mcp.servers.chorus`
   * entry; the real `mutateConfigFile` is generic — `mutate(draft)` mutates a
   * `DeepReadonly`-cloned draft in place. We narrow `draft`/return to the MCP
   * slice the plugin touches.
   */
  export type OpenClawRuntimeConfig = {
    current?: () => { mcp?: { servers?: Record<string, unknown> } } | undefined;
    mutateConfigFile?: (params: {
      afterWrite: { mode: "auto" };
      mutate: (draft: { mcp?: { servers?: Record<string, unknown> } }) => void;
    }) => Promise<unknown>;
    [key: string]: unknown;
  };

  /**
   * The slice of `PluginRuntime` (`api.runtime`) the plugin consumes.
   * Verified: ../openclaw/src/plugins/types.ts:2600 (`runtime: PluginRuntime`)
   * → ../openclaw/src/plugins/runtime/types.ts (PluginRuntime = PluginRuntimeCore
   * & …) → ../openclaw/src/plugins/runtime/types-core.ts (`agent` :180,
   * `config` :145). The reverse control channel is NOT part of this runtime
   * surface — it arrives over the SSE stream (`type: "control"`), handled in
   * `sse-listener.ts` / the control handler, not via `api.runtime`. Confirmed:
   * no `control`/`connection` member exists on `PluginRuntimeCore`.
   */
  export type OpenClawPluginRuntime = {
    agent: OpenClawRuntimeAgent;
    config: OpenClawRuntimeConfig;
    [key: string]: unknown;
  };

  /**
   * Permissive subset of `OpenClawPluginApi` used by this plugin's entry.
   *
   * Only the members this plugin touches are typed; the index signature keeps
   * the rest of the (large) host API accessible without importing it.
   * Verified: ../openclaw/src/plugins/types.ts:2584-2600 (`OpenClawPluginApi`).
   */
  export type OpenClawPluginApi = {
    registrationMode: PluginRegistrationMode;
    pluginConfig?: Record<string, unknown>;
    config?: Record<string, unknown> & {
      gateway?: { port?: number };
      hooks?: { token?: string };
    };
    logger: {
      debug?: (message: string) => void;
      info: (message: string) => void;
      warn: (message: string) => void;
      error: (message: string) => void;
    };
    registerService: (service: {
      id: string;
      start: (...args: unknown[]) => void | Promise<void>;
      stop?: (...args: unknown[]) => void | Promise<void>;
    }) => void;
    registerCommand: (command: unknown) => void;
    registerTool: (tool: unknown, opts?: unknown) => void;
    /**
     * In-process runtime helpers. Typed to the minimal slice the plugin uses
     * (`agent`, `config`) — no longer bare `unknown`. Optional because the
     * narrow registration modes (discovery/cli-metadata) may not expose it; the
     * plugin guards `api.runtime` before use.
     */
    runtime?: OpenClawPluginRuntime;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
  };

  export type DefinePluginEntryOptions = {
    id: string;
    name: string;
    description: string;
    configSchema?: OpenClawPluginConfigSchema | (() => OpenClawPluginConfigSchema);
    register: (api: OpenClawPluginApi) => void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
  };

  export type DefinedPluginEntry = {
    id: string;
    name: string;
    description: string;
    configSchema: OpenClawPluginConfigSchema;
    register: (api: OpenClawPluginApi) => void;
  };

  export function definePluginEntry(options: DefinePluginEntryOptions): DefinedPluginEntry;
}
