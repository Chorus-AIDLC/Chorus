import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseEnv } from "node:util";
import { OUTCOME_ACTIONS, STEP_SCOPES } from "../contracts.mjs";
import { runCommand } from "../run-command.mjs";
import { resolveCodexEnvPath } from "./credential-seed.mjs";

const MANAGED_KEYS = ["CHORUS_URL", "CHORUS_API_KEY", "CHORUS_AGENT_PROFILE"];
const MAX_OUTPUT = 64 * 1024;

export const codexRestartStep = {
  id: "codex-restart",
  order: 25,
  scope: STEP_SCOPES.PER_AGENT,
  async run(ctx) {
    if (ctx.agentId !== "codex" || ctx.flags?.pluginOnly) return [];

    const env = ctx.env ?? process.env;
    const envPath = resolveCodexEnvPath(env);
    const codexHome = dirname(envPath);
    const guidance = `Configuration directory: ${JSON.stringify(codexHome)}. ` +
      "For manual recovery, inspect `codex app-server daemon restart --help` for support first. " +
      "Before restarting a running daemon, load CHORUS_URL, CHORUS_API_KEY and CHORUS_AGENT_PROFILE " +
      "from that directory's .env as environment data (not shell code), using the same CODEX_HOME. " +
      "Restarting can interrupt other Codex sessions; no daemon is started or upgraded by this step.";
    const outcome = (action, detail) => ({ stepId: "codex-restart", agentId: "codex", action, detail });
    const defer = (reason) => outcome(OUTCOME_ACTIONS.SKIPPED, `Codex App Server restart deferred: ${reason}. ${guidance}`);
    const prior = ctx.priorOutcomes ?? [];
    const seeded = prior.some((entry) => entry.stepId === "credential-seed" &&
      [OUTCOME_ACTIONS.SEEDED, OUTCOME_ACTIONS.SKIPPED].includes(entry.action) && entry.codexEnvWritten === true);
    const configured = prior.some((entry) => entry.stepId === "plugin-install" && entry.agentId === "codex" &&
      [OUTCOME_ACTIONS.INSTALLED, OUTCOME_ACTIONS.REPAIRED, OUTCOME_ACTIONS.SKIPPED].includes(entry.action) &&
      entry.codexMcpWritten === true);
    if (!seeded || !configured) return defer("credential persistence or plugin configuration did not complete");
    if (!ctx.io?.isTTY || ctx.flags?.yes || env.CHORUS_DAEMON_HEADLESS === "1" || typeof ctx.io?.ask !== "function") {
      return defer("a dedicated interactive confirmation is required (--yes does not authorize restart)");
    }

    let childEnv;
    try {
      const persisted = parseEnv(readFileSync(envPath, "utf8"));
      if (MANAGED_KEYS.some((key) => !persisted[key]?.trim())) return defer("saved environment is incomplete");
      childEnv = { ...env, CODEX_HOME: codexHome };
      for (const key of MANAGED_KEYS) childEnv[key] = persisted[key];
    } catch {
      return defer("saved environment could not be read");
    }

    const run = ctx.run ?? runCommand;
    const command = async (args, timeoutMs = 5_000) => {
      try {
        const result = await run("codex", ["app-server", "daemon", ...args], {
          env: childEnv, timeoutMs, maxBuffer: MAX_OUTPUT, killSignal: "SIGKILL",
        });
        if (!result?.ok || typeof result.stdout !== "string" || result.stdout.length > MAX_OUTPUT ||
          (result.stderr?.length ?? 0) > MAX_OUTPUT) return null;
        return result;
      } catch {
        return null;
      }
    };
    const help = await command(["restart", "--help"]);
    if (!help || !/\bUsage:\s+codex app-server daemon restart\b/.test(help.stdout)) {
      return defer("restart support could not be confirmed (missing/older CLI or failed probe)");
    }
    const version = await command(["version"]);
    let status;
    try {
      status = JSON.parse(version?.stdout).status;
    } catch {
      return defer("daemon state could not be determined");
    }
    if (status === "stopped") return defer("no running daemon; nothing was started");
    if (status !== "running") return defer("daemon state is unknown");

    let answer;
    try {
      answer = await ctx.io.ask(
        "Restart the running Codex App Server with the saved Chorus environment? " +
        "This can interrupt other Codex sessions and active work. [y/N] ",
      );
    } catch {
      return defer("confirmation was unavailable");
    }
    if (typeof answer !== "string" || !/^(?:y|yes)$/i.test(answer.trim())) return defer("not explicitly confirmed");

    const restarted = await command(["restart"], 30_000);
    if (!restarted) {
      return outcome(OUTCOME_ACTIONS.FAILED, "Codex App Server restart command failed or timed out; " +
        `saved configuration remains in place. ${guidance}`);
    }
    return outcome(OUTCOME_ACTIONS.REPAIRED,
      "Codex App Server restart command succeeded with the saved environment; credentials and MCP connectivity were not verified.");
  },
};
