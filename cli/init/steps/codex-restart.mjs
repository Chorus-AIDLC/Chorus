import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseEnv } from "node:util";
import { OUTCOME_ACTIONS, STEP_SCOPES } from "../contracts.mjs";
import { runCommand } from "../run-command.mjs";
import { resolveCodexEnvPath } from "./credential-seed.mjs";
import { codexFamilyProfile } from "../../codex-family.mjs";

// Codex-family App Server restart (codex + trae). VERIFIED traecli 0.209.1 with an isolated
// TRAE_HOME: `traecli app-server daemon {start,version,restart,stop}` mirror Codex — `version`
// prints `{"status":"running",…}` JSON while a daemon runs and `restart` prints
// `{"status":"restarted",…}`. One difference: with no daemon, traecli `version` exits 1
// ("failed to connect to …app-server-control.sock") instead of printing a stopped status, so
// TRAE defers with "daemon state could not be determined" — still never starting a daemon.

const MANAGED_KEYS = ["CHORUS_URL", "CHORUS_API_KEY", "CHORUS_AGENT_PROFILE"];
const MAX_OUTPUT = 64 * 1024;

export const codexRestartStep = {
  id: "codex-restart",
  order: 25,
  scope: STEP_SCOPES.PER_AGENT,
  async run(ctx) {
    const profile = codexFamilyProfile(ctx.agentId);
    if (!profile || ctx.flags?.pluginOnly) return [];

    const agentId = profile.agentType;
    const bin = profile.binaries.posix[0];
    const name = profile.displayName;
    const env = ctx.env ?? process.env;
    const envPath = resolveCodexEnvPath(env, profile);
    const familyHome = dirname(envPath);
    const guidance = `Configuration directory: ${JSON.stringify(familyHome)}. ` +
      `For manual recovery, inspect \`${bin} app-server daemon restart --help\` for support first. ` +
      "Before restarting a running daemon, load CHORUS_URL, CHORUS_API_KEY and CHORUS_AGENT_PROFILE " +
      `from that directory's .env as environment data (not shell code), using the same ${profile.homeEnv}. ` +
      `Restarting can interrupt other ${name} sessions; no daemon is started or upgraded by this step.`;
    const outcome = (action, detail) => ({ stepId: "codex-restart", agentId, action, detail });
    const defer = (reason) => outcome(OUTCOME_ACTIONS.SKIPPED, `${name} App Server restart deferred: ${reason}. ${guidance}`);
    const prior = ctx.priorOutcomes ?? [];
    // credential-seed tags its .env write with codexEnvAgentId; an untagged write is Codex's
    // (the pre-TRAE outcome shape), so TRAE requires an explicit "trae" tag.
    const seeded = prior.some((entry) => entry.stepId === "credential-seed" &&
      [OUTCOME_ACTIONS.SEEDED, OUTCOME_ACTIONS.SKIPPED].includes(entry.action) && entry.codexEnvWritten === true &&
      (entry.codexEnvAgentId ?? "codex") === agentId);
    const configured = prior.some((entry) => entry.stepId === "plugin-install" && entry.agentId === agentId &&
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
      childEnv = { ...env, [profile.homeEnv]: familyHome };
      for (const key of MANAGED_KEYS) childEnv[key] = persisted[key];
    } catch {
      return defer("saved environment could not be read");
    }

    const run = ctx.run ?? runCommand;
    const command = async (args, timeoutMs = 5_000) => {
      try {
        const result = await run(bin, ["app-server", "daemon", ...args], {
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
    const usageRe = new RegExp(`\\bUsage:\\s+${bin} app-server daemon restart\\b`);
    if (!help || !usageRe.test(help.stdout)) {
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
        `Restart the running ${name} App Server with the saved Chorus environment? ` +
        `This can interrupt other ${name} sessions and active work. [y/N] `,
      );
    } catch {
      return defer("confirmation was unavailable");
    }
    if (typeof answer !== "string" || !/^(?:y|yes)$/i.test(answer.trim())) return defer("not explicitly confirmed");

    const restarted = await command(["restart"], 30_000);
    if (!restarted) {
      return outcome(OUTCOME_ACTIONS.FAILED, `${name} App Server restart command failed or timed out; ` +
        `saved configuration remains in place. ${guidance}`);
    }
    return outcome(OUTCOME_ACTIONS.REPAIRED,
      `${name} App Server restart command succeeded with the saved environment; credentials and MCP connectivity were not verified.`);
  },
};
