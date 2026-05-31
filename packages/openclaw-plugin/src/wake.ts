import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

/**
 * Wake mechanism for the Chorus plugin.
 *
 * Runs an agent turn IN-PROCESS with the wake text as the agent's prompt, via
 * `api.runtime.agent.runEmbeddedAgent(...)` — the same primitive the cron
 * service uses to "run the agent now with this prompt"
 * (`../openclaw/src/cron/isolated-agent/run-executor.ts:266`).
 *
 * WHY NOT enqueueSystemEvent + heartbeat: that path was tried and does NOT
 * deliver our text. `enqueueSystemEvent` only pushes onto the session queue,
 * and the heartbeat prompt builder only renders exec-completion / cron events
 * into a prompt (`../openclaw/src/infra/heartbeat-runner.ts:1240-1252`); a plain
 * notification event is never injected, so the agent turned on the generic
 * `[OpenClaw heartbeat poll]` prompt with no Chorus content. runEmbeddedAgent
 * delivers the prompt directly and runs a real turn that can call the MCP tools.
 *
 * The runtime surface used here is declared on `PluginRuntimeCore.agent` in
 * `../openclaw/src/plugins/runtime/types-core.ts:180-221`. The local SDK shim
 * types `api.runtime` permissively, so we narrow the slice we use inline —
 * mirroring `mcp-registration.ts` (api.runtime.config). Verified signatures:
 *   - runEmbeddedAgent(RunEmbeddedAgentParams) — required: sessionId,
 *     sessionFile, workspaceDir, prompt, timeoutMs, runId (params.ts:39+).
 *   - agent.session.getSessionEntry({ sessionKey, agentId }) → SessionEntry?
 *     (store.ts:210); SessionEntry has sessionId + optional sessionFile.
 *   - agent.session.resolveSessionFilePath(sessionId, { sessionFile }, { agentId })
 *     (paths.ts:267).
 *   - agent.resolveAgentWorkspaceDir(cfg, agentId) / resolveAgentDir(cfg, agentId)
 *     — positional (agent-scope-config.ts:170/195).
 *   - agent.resolveAgentTimeoutMs({ cfg }) → number (timeout.ts:15).
 */

const FALLBACK_DEFAULT_AGENT_ID = "main";
const DEFAULT_MAIN_KEY = "main";

/** Mirror of OpenClaw's `normalizeAgentId` lowercasing fallback. */
function normalizeAgentId(value: string | undefined | null): string {
  const trimmed = (value ?? "").trim().toLowerCase();
  if (!trimmed) return FALLBACK_DEFAULT_AGENT_ID;
  // Keep it path-safe + shell-friendly (matches openclaw VALID_ID_RE behavior).
  if (/^[a-z0-9][a-z0-9_-]{0,63}$/.test(trimmed)) return trimmed;
  const collapsed = trimmed
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 64);
  return collapsed || FALLBACK_DEFAULT_AGENT_ID;
}

/** Mirror of OpenClaw's `normalizeMainKey`. */
function normalizeMainKey(value: string | undefined | null): string {
  const trimmed = (value ?? "").trim().toLowerCase();
  return trimmed || DEFAULT_MAIN_KEY;
}

/**
 * Resolve the main agent session key from the host config.
 *
 * This faithfully replicates OpenClaw's `resolveMainSessionKey(cfg)`
 * (`../openclaw/src/config/sessions/main-session.ts:14`): a background plugin
 * has no inbound message route to derive a session key from, so the wake must
 * target the main agent's session. We cannot import the OpenClaw internal here
 * (the resolvable `openclaw` peer is an older build), so we re-derive the key
 * from `api.config` (the live `OpenClawConfig` snapshot) using the same rules:
 *
 *   - `session.scope === "global"`  → the literal `"global"` queue
 *   - otherwise → `agent:<defaultAgentId>:<mainKey>`, where defaultAgentId is
 *     the agent flagged `default`, else the first listed agent, else "main".
 *
 * Returns `null` when no session key can be resolved. The design's no-session
 * fallback (graceful drop) then applies — we never fabricate a session.
 */
export function resolveSessionKey(api: OpenClawPluginApi): string | null {
  const cfg = api.config as
    | {
        session?: { scope?: string; mainKey?: string };
        agents?: { list?: Array<{ id?: string; default?: boolean }> };
      }
    | undefined;

  if (!cfg) return null;

  if (cfg.session?.scope === "global") {
    return "global";
  }

  const agents = Array.isArray(cfg.agents?.list) ? cfg.agents!.list! : [];
  const defaultAgentId =
    agents.find((agent) => agent?.default)?.id ?? agents[0]?.id ?? FALLBACK_DEFAULT_AGENT_ID;

  const key = `agent:${normalizeAgentId(defaultAgentId)}:${normalizeMainKey(cfg.session?.mainKey)}`;
  return key || null;
}

/**
 * Resolve the default agent id (matches OpenClaw's `resolveDefaultAgentId`):
 * the agent flagged `default`, else the first listed agent, else "main".
 * runEmbeddedAgent and the session/workspace resolvers are all agent-scoped.
 */
export function resolveAgentId(api: OpenClawPluginApi): string {
  const cfg = api.config as
    | { agents?: { list?: Array<{ id?: string; default?: boolean }> } }
    | undefined;
  const agents = Array.isArray(cfg?.agents?.list) ? cfg!.agents!.list! : [];
  const id = agents.find((a) => a?.default)?.id ?? agents[0]?.id ?? FALLBACK_DEFAULT_AGENT_ID;
  return normalizeAgentId(id);
}

/**
 * Resolve the configured default model into `{ provider, model }` so we can pass
 * them explicitly to runEmbeddedAgent. WHY THIS IS REQUIRED: runEmbeddedAgent
 * does NOT auto-resolve the model from config when `provider`/`model` are
 * omitted — it falls back to the built-in `DEFAULT_MODEL` ("gpt-5.5",
 * `../openclaw/src/agents/defaults.ts:4`), which fails with "Unknown model"
 * unless that happens to be configured. The host's own resolver
 * (`resolveConfiguredModelRef`, `../openclaw/src/agents/model-selection-shared.ts`)
 * is NOT exposed to plugins, so we mirror its primary-ref read: `agents.defaults.model`
 * is either a bare `"provider/model"` string or `{ primary: "provider/model" }`
 * (`resolvePrimaryStringValue`), split on the first "/".
 *
 * Returns null when no default model is configured (then we omit the overrides
 * and let the host fall back — same as before, but at least we tried).
 */
export function resolveModelRef(
  api: OpenClawPluginApi,
): { provider: string; model: string } | null {
  const model = (api.config as { agents?: { defaults?: { model?: unknown } } } | undefined)
    ?.agents?.defaults?.model;
  const raw =
    typeof model === "string"
      ? model
      : model && typeof model === "object"
        ? (model as { primary?: unknown }).primary
        : undefined;
  const ref = typeof raw === "string" ? raw.trim() : "";
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash >= ref.length - 1) {
    return null;
  }
  return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
}

/**
 * Narrowed view of the `api.runtime.agent` surface we use to run a turn. Only
 * the members this plugin touches are typed; the host provides the full
 * `PluginRuntimeCore.agent` at runtime (types-core.ts:180-221).
 */
interface SessionEntryLike {
  sessionId: string;
  sessionFile?: string;
}
interface RuntimeAgentSlice {
  runEmbeddedAgent: (params: Record<string, unknown>) => Promise<unknown>;
  resolveAgentDir: (cfg: unknown, agentId: string) => string;
  resolveAgentWorkspaceDir: (cfg: unknown, agentId: string) => string;
  resolveAgentTimeoutMs: (opts: { cfg?: unknown }) => number;
  session: {
    getSessionEntry: (options: { sessionKey: string; agentId?: string }) => SessionEntryLike | undefined;
    resolveSessionFilePath: (
      sessionId: string,
      entry?: { sessionFile?: string },
      opts?: { agentId?: string },
    ) => string;
  };
}

function getRuntimeAgent(api: OpenClawPluginApi): RuntimeAgentSlice | null {
  const agent = (api.runtime as { agent?: Partial<RuntimeAgentSlice> } | undefined)?.agent;
  if (
    !agent ||
    typeof agent.runEmbeddedAgent !== "function" ||
    typeof agent.resolveAgentWorkspaceDir !== "function" ||
    typeof agent.resolveAgentTimeoutMs !== "function" ||
    typeof agent.session?.getSessionEntry !== "function" ||
    typeof agent.session?.resolveSessionFilePath !== "function"
  ) {
    return null;
  }
  return agent as RuntimeAgentSlice;
}

/**
 * Build a stable-ish unique id without Date.now()/Math.random() (some hosts
 * sandbox those). A monotonic counter + the contextKey is enough for runId
 * uniqueness within a process.
 */
let wakeCounter = 0;
function nextRunId(contextKey: string): string {
  wakeCounter += 1;
  return `chorus-wake-${wakeCounter}-${contextKey}`;
}

/**
 * Build a `wake(message, contextKey)` callback bound to the host runtime.
 *
 * Each wake resolves the main agent's session + workspace and runs an agent
 * turn IN-PROCESS with `message` as the prompt (via runEmbeddedAgent). The turn
 * has the agent's normal tool set (including the `chorus__*` MCP tools), so the
 * agent can read the entity, the comment thread, and post back to Chorus.
 *
 * Failure modes (never throw — the SSE service must stay alive):
 *   - no resolvable session key / agent runtime unavailable → log + drop;
 *   - no existing session entry → run with a fresh sessionId (the runner
 *     creates the transcript); the agent starts a new conversation;
 *   - runEmbeddedAgent rejects (e.g. a turn is already in flight) → log + drop
 *     (the next SSE event re-triggers).
 *
 * Runs are fire-and-forget (the SSE dispatch path is sync); we log completion.
 */
export function createWake(
  api: OpenClawPluginApi,
  logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void },
): (message: string, contextKey: string) => void {
  return (message: string, contextKey: string) => {
    const sessionKey = resolveSessionKey(api);
    if (!sessionKey) {
      logger.warn(
        `[Chorus] Wake DROPPED — could not resolve a main agent session key (contextKey=${contextKey}). Event: ${message.slice(0, 100)}`,
      );
      return;
    }

    const agent = getRuntimeAgent(api);
    if (!agent) {
      logger.warn(
        `[Chorus] Wake DROPPED — api.runtime.agent.runEmbeddedAgent (or a required session helper) is unavailable on this host (contextKey=${contextKey}).`,
      );
      return;
    }

    const cfg = api.config;
    const agentId = resolveAgentId(api);

    // Resolve the EXISTING main-agent session so the wake turn continues the
    // real conversation (context + MCP tools). If none exists yet, fall back to
    // a fresh session id — runEmbeddedAgent creates the transcript file.
    let sessionId: string;
    let sessionFile: string;
    try {
      const entry = agent.session.getSessionEntry({ sessionKey, agentId });
      sessionId = entry?.sessionId ?? nextRunId(contextKey);
      sessionFile = agent.session.resolveSessionFilePath(
        sessionId,
        entry?.sessionFile ? { sessionFile: entry.sessionFile } : undefined,
        { agentId },
      );
    } catch (err) {
      logger.warn(`[Chorus] Wake DROPPED — session resolution failed (contextKey=${contextKey}): ${err}`);
      return;
    }

    let workspaceDir: string;
    let agentDir: string | undefined;
    let timeoutMs: number;
    try {
      workspaceDir = agent.resolveAgentWorkspaceDir(cfg, agentId);
      agentDir = agent.resolveAgentDir(cfg, agentId);
      timeoutMs = agent.resolveAgentTimeoutMs({ cfg });
    } catch (err) {
      logger.warn(`[Chorus] Wake DROPPED — workspace/timeout resolution failed (contextKey=${contextKey}): ${err}`);
      return;
    }

    // Resolve the configured model; runEmbeddedAgent otherwise falls back to the
    // built-in DEFAULT_MODEL ("gpt-5.5") and fails with "Unknown model".
    const modelRef = resolveModelRef(api);
    if (!modelRef) {
      logger.warn(
        `[Chorus] No agents.defaults.model configured — wake turn will use the host default model, which may be unavailable (contextKey=${contextKey}).`,
      );
    }

    const runId = nextRunId(contextKey);
    logger.info(
      `[Chorus] Waking agent via embedded run (sessionKey=${sessionKey}, model=${modelRef ? `${modelRef.provider}/${modelRef.model}` : "host-default"}, contextKey=${contextKey})`,
    );

    // Fire-and-forget: the SSE dispatch path is synchronous, and a wake turn
    // can take many seconds. We log completion/failure but never await here.
    // `disableMessageTool: true` → headless turn; the agent acts via MCP tools
    // (chorus_add_comment, etc.) rather than replying to a chat channel.
    void Promise.resolve()
      .then(() =>
        agent.runEmbeddedAgent({
          sessionId,
          sessionKey,
          agentId,
          trigger: "manual",
          sessionFile,
          ...(agentDir ? { agentDir } : {}),
          workspaceDir,
          config: cfg,
          prompt: message,
          timeoutMs,
          runId,
          disableMessageTool: true,
          ...(modelRef ? { provider: modelRef.provider, model: modelRef.model } : {}),
        }),
      )
      .then(() =>
        logger.info(`[Chorus] Wake turn completed (sessionKey=${sessionKey}, contextKey=${contextKey})`),
      )
      .catch((err) =>
        logger.warn(
          `[Chorus] Wake turn failed (sessionKey=${sessionKey}, contextKey=${contextKey}): ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
  };
}
