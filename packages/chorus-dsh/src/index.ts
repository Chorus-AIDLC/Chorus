import type { Context } from "@deepseek-ai/cordis";
import type { Agent, PreStepDecision } from "@deepseek-ai/dsh-agent";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { UserMessage } from "@deepseek-ai/dsh-session";
import type {
  PostToolDecision,
  ToolExecution,
  ToolExecutionResult,
} from "@deepseek-ai/dsh-tools";
import type {} from "@deepseek-ai/dsh-subagent";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import z from "@deepseek-ai/schemastery";

export const name = "chorus-dsh";
export const inject = ["tools"];
export const chorusMcpCallPath = fileURLToPath(
  new URL("../bin/chorus-mcp-call.mjs", import.meta.url),
);

// OpenSpec activeness for the openspec-aware-chorus skill. dsh has no
// SessionStart hook (unlike the Claude Code plugin), so the plugin precomputes
// the three-check result at load and exports it via CHORUS_OPENSPEC_ACTIVE; the
// skill reads it and only recomputes inline as a fallback. Mirrors how
// CHORUS_MCP_CALL is published to the process environment.
export function detectOpenspecActive(cwd: string = process.cwd()): boolean {
  if (process.env.CHORUS_OPENSPEC_MODE === "off") return false;
  if (!existsSync(join(cwd, "openspec"))) return false;
  try {
    execFileSync("openspec", ["--version"], { stdio: "ignore", timeout: 5000 });
  } catch {
    return false;
  }
  return true;
}

const CHECKIN_TOOL = "mcp__chorus__chorus_checkin";
const SYNTHETIC_CALL_PREFIX = "chorus-dsh:checkin:";
const PLUGIN_SOURCE = { kind: "plugin", plugin: name } as const;

// One-line working-style reminder injected at session start. Kept here in the
// plugin (NOT in the chorus_checkin MCP payload — the MCP response stays pure
// data): for long-horizon work, follow AI-DLC via the Chorus skill and use
// chorus_search to locate the work the user refers to.
const SESSION_START_GUIDANCE =
  "For long-horizon work, follow AI-DLC via the Chorus skill (idea → proposal → task → verify) rather than coding ad hoc, and use chorus_search to locate the specific work the user refers to across ideas/proposals/tasks/docs.";

const ACTIONS = {
  chorus_pm_submit_proposal: {
    argument: "proposalUuid",
    label: "proposal-review",
    instruction: (target: string) =>
      `Run the Chorus proposal reviewer for proposal ${target}: spawn the reviewer sub-agent with run_in_background: false (foreground — the call waits and returns the VERDICT inline; the approve/reject decision depends on it), then close the reviewer agent. Only set run_in_background: true when you deliberately want to fan out and collect the verdict later.`,
  },
  chorus_submit_for_verify: {
    argument: "taskUuid",
    label: "task-review",
    instruction: (target: string) =>
      `Run the Chorus task reviewer for task ${target}: spawn the reviewer sub-agent with run_in_background: false (foreground — the call waits and returns the VERDICT inline; the verify/reopen decision depends on it), then close the reviewer agent. Only set run_in_background: true when you deliberately want to fan out and collect the verdict later.`,
  },
  chorus_admin_verify_task: {
    argument: "taskUuid",
    label: "aggregate-review",
    instruction: (target: string) =>
      `First verify whether task ${target} was the final task of an idea-rooted proposal. Only if it was the last task, run the aggregate Chorus code-review for that idea: spawn the reviewer sub-agent with run_in_background: false (foreground — the call waits and returns the VERDICT inline; the ship decision depends on it), then close the reviewer agent. Only set run_in_background: true when you deliberately want to fan out and collect the verdict later.`,
  },
} as const;

type ActionName = keyof typeof ACTIONS;

export interface Config {
  url?: string;
  apiKey?: string;
  daemonOriginEnv?: string;
  checkinTimeoutMs?: number;
  maxPendingActions?: number;
}

interface ResolvedConfig {
  url?: string;
  apiKey?: string;
  daemonOriginEnv: string;
  checkinTimeoutMs: number;
  maxPendingActions: number;
}

export const Config: z<Config, ResolvedConfig> = z.object({
  url: z.string(),
  apiKey: z.string(),
  daemonOriginEnv: z
    .string()
    .pattern(/^[A-Za-z_][A-Za-z0-9_]*$/)
    .default("CHORUS_DAEMON_HEADLESS"),
  checkinTimeoutMs: z.number().step(1).min(100).max(30000).default(1500),
  maxPendingActions: z.number().step(1).min(1).max(64).default(8),
});

export interface ChorusConnectionConfig {
  url: string;
  apiKey: string;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

// Credential fallback: read $DSH_HOME/.env (DSH_HOME || $HOME/.dsh) using the
// same `node:util` parser dsh itself uses for this file (app-boot parseEnv /
// process.loadEnvFile), and consistent with dsh's own credentials-local
// provider, whose documented fallback chain includes `$DSH_HOME/.env`. DSH_HOME
// is resolved from the passed env so an empty env reads nothing (keeps unit
// tests hermetic — they never touch the real ~/.dsh).
export function readDshHomeEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const home =
    nonEmpty(env.DSH_HOME) ??
    (nonEmpty(env.HOME) ? join(env.HOME as string, ".dsh") : undefined);
  if (!home) return {};
  try {
    return parseEnv(readFileSync(join(home, ".env"), "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

export function resolveConnectionConfig(
  config: Pick<Config, "url" | "apiKey">,
  env: NodeJS.ProcessEnv = process.env,
): ChorusConnectionConfig {
  let url = nonEmpty(config.url) ?? nonEmpty(env.CHORUS_URL);
  let apiKey = nonEmpty(config.apiKey) ?? nonEmpty(env.CHORUS_API_KEY);
  // Only touch the filesystem when a value is still missing.
  if (!url || !apiKey) {
    const dshEnv = readDshHomeEnv(env);
    url = url ?? nonEmpty(dshEnv.CHORUS_URL);
    apiKey = apiKey ?? nonEmpty(dshEnv.CHORUS_API_KEY);
  }
  if (!url) {
    throw new Error(`${name}: url is required (config.url, CHORUS_URL, or $DSH_HOME/.env)`);
  }
  if (!apiKey) {
    throw new Error(
      `${name}: apiKey is required (config.apiKey, CHORUS_API_KEY, or $DSH_HOME/.env)`,
    );
  }
  return { url: url.replace(/\/+$/, ""), apiKey };
}

interface AgentState {
  readonly agent: Agent;
  readonly abort: AbortController;
  readonly pendingActions: Map<string, string>;
  checkin?: Promise<UserMessage | undefined>;
  firstStepHandled: boolean;
}

interface DetachedTracker {
  readonly signal: AbortSignal;
  track<T>(promise: Promise<T>): Promise<T>;
  drain(): Promise<void>;
}

function createDetachedTracker(): DetachedTracker {
  const controller = new AbortController();
  const active = new Set<Promise<unknown>>();
  return {
    signal: controller.signal,
    track<T>(promise: Promise<T>): Promise<T> {
      const tracked = promise.finally(() => active.delete(tracked));
      active.add(tracked);
      return tracked;
    },
    async drain(): Promise<void> {
      controller.abort();
      await Promise.allSettled([...active]);
    },
  };
}

export function isDaemonOrigin(
  env: NodeJS.ProcessEnv,
  daemonOriginEnv: string,
): boolean {
  return env[daemonOriginEnv] === "1";
}

export function normalizeChorusToolName(name: string): string | undefined {
  const prefix = "mcp__chorus__";
  return name.startsWith(prefix) && name.length > prefix.length
    ? name.slice(prefix.length)
    : undefined;
}

function createPluginMessage(content: ContentBlock[]): UserMessage {
  return Object.freeze({
    id: crypto.randomUUID(),
    role: "user",
    content: Object.freeze(content.map((block) => Object.freeze({ ...block }))),
    source: PLUGIN_SOURCE,
  }) as UserMessage;
}

function resultMessage(result: ToolExecutionResult): UserMessage | undefined {
  if (result.isError || result.content.length === 0) return undefined;
  const content = result.content.filter(
    (block): block is Extract<ContentBlock, { type: "text" }> =>
      block.type === "text" && block.text.trim().length > 0,
  );
  return content.length > 0 ? createPluginMessage(content) : undefined;
}

function actionTarget(exec: ToolExecution, action: ActionName): string {
  const argument = ACTIONS[action].argument;
  if (
    typeof exec.arguments === "object" &&
    exec.arguments !== null &&
    argument in exec.arguments
  ) {
    const value = (exec.arguments as Record<string, unknown>)[argument];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return String(exec.callId);
}

function addPendingAction(
  ctx: Context,
  state: AgentState,
  action: ActionName,
  exec: ToolExecution,
  maxPendingActions: number,
): void {
  const target = actionTarget(exec, action);
  const definition = ACTIONS[action];
  const key = `${definition.label}:${target}`;
  if (state.pendingActions.has(key)) return;
  if (state.pendingActions.size >= maxPendingActions) {
    ctx.logger.warn(
      `${name}: pending workflow action limit (${maxPendingActions}) reached; dropping ${key}`,
    );
    return;
  }
  state.pendingActions.set(key, definition.instruction(target));
}

function waitForCheckin(
  promise: Promise<UserMessage | undefined>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<UserMessage | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: UserMessage | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = (): void => finish(undefined);
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(finish, () => finish(undefined));
  });
}

export function apply(ctx: Context, config: Config): void {
  process.env.CHORUS_MCP_CALL ??= chorusMcpCallPath;
  // Publish OpenSpec activeness before the daemon-origin gate so both
  // interactive and daemon sessions get it; an explicit value always wins.
  process.env.CHORUS_OPENSPEC_ACTIVE ??= detectOpenspecActive() ? "1" : "0";
  const resolved = Config(config);
  ctx.provide(
    "chorusDshConfig",
    resolveConnectionConfig(resolved),
  );
  if (isDaemonOrigin(process.env, resolved.daemonOriginEnv)) {
    ctx.logger.info(
      `${name}: daemon origin detected via ${resolved.daemonOriginEnv}; lifecycle automation disabled`,
    );
    return;
  }

  const states = new WeakMap<Agent, AgentState>();
  const liveStates = new Set<AgentState>();
  const detached = createDetachedTracker();
  let callCounter = 0;

  const getState = (agent: Agent): AgentState | undefined => states.get(agent);

  ctx.effect(
    () => async () => {
      for (const state of liveStates) {
        state.abort.abort();
        state.pendingActions.clear();
      }
      await detached.drain();
      liveStates.clear();
    },
    `${name}: abort and drain lifecycle work`,
  );

  ctx.on("agent/session-start", ({ agent }) => {
    const previous = states.get(agent);
    if (previous) {
      previous.abort.abort();
      previous.pendingActions.clear();
      liveStates.delete(previous);
    }
    const state: AgentState = {
      agent,
      abort: new AbortController(),
      pendingActions: new Map(),
      firstStepHandled: false,
    };
    states.set(agent, state);
    liveStates.add(state);
    const checkin = ctx.tools
      .execute({
        callId: `${SYNTHETIC_CALL_PREFIX}${++callCounter}` as never,
        name: CHECKIN_TOOL,
        arguments: {},
        agent,
        signal: state.abort.signal,
      })
      .then(resultMessage)
      .catch((error: unknown) => {
        ctx.logger.warn(`${name}: check-in failed: ${String(error)}`);
        return undefined;
      });
    state.checkin = detached.track(checkin);
  });

  ctx.on(
    "agent/pre-step",
    async ({ agent, signal }, next): Promise<PreStepDecision> => {
      const state = getState(agent);
      if (!state || state.firstStepHandled) return next();
      state.firstStepHandled = true;
      const context = state.checkin
        ? await waitForCheckin(state.checkin, resolved.checkinTimeoutMs, signal)
        : undefined;
      if (!context) {
        ctx.logger.warn(
          `${name}: first-step check-in unavailable within ${resolved.checkinTimeoutMs}ms; continuing`,
        );
      }
      const downstream = await next();
      if (!context || downstream.kind !== "enter") return downstream;
      const guidance = createPluginMessage([
        { type: "text", text: SESSION_START_GUIDANCE },
      ]);
      // First step only: inject the check-in context + the one-line session-start
      // guidance. Fails open (no injection) when the check-in didn't resolve.
      return { kind: "enter", messages: [...downstream.messages, context, guidance] };
    },
  );

  ctx.on(
    "tools/post-execute",
    async (
      exec,
      result,
      next,
    ): Promise<PostToolDecision> => {
      const downstream = await next();
      const normalized = normalizeChorusToolName(exec.name);
      if (
        !exec.agent ||
        !normalized ||
        String(exec.callId).startsWith(SYNTHETIC_CALL_PREFIX) ||
        result.isError ||
        downstream.kind !== "accept"
      ) {
        return downstream;
      }
      const state = getState(exec.agent);
      if (!state || !(normalized in ACTIONS)) return downstream;
      addPendingAction(
        ctx,
        state,
        normalized as ActionName,
        exec,
        resolved.maxPendingActions,
      );
      return downstream;
    },
  );

  ctx.on("agent/turn-stopping", ({ agent }) => {
    const state = getState(agent);
    if (!state || state.pendingActions.size === 0) return;
    const instructions = [...state.pendingActions.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, instruction]) => instruction);
    state.pendingActions.clear();
    agent.steer(
      createPluginMessage([
        {
          type: "text",
          text: `Complete the pending Chorus workflow actions before stopping:\n\n${instructions
            .map((instruction, index) => `${index + 1}. ${instruction}`)
            .join("\n")}`,
        },
      ]),
    );
  });

  ctx.on("agent/disposed", ({ agent }) => {
    const state = getState(agent);
    if (!state) return;
    state.abort.abort();
    state.pendingActions.clear();
    liveStates.delete(state);
  });

  ctx.on("subagent/start", (info) => {
    ctx.logger.debug(`${name}: observed subagent start ${String(info.runId)}`);
  });
  ctx.on("subagent/end", (info) => {
    ctx.logger.debug(`${name}: observed subagent end ${String(info.runId)}`);
  });
}
