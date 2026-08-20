// cli/init/steps/daemon-setup.mjs
// The `once`-scoped daemon-setup step for `chorus init` (idea a7c2a3e8). It is the
// reserved sibling slot in the step registry (see registry.mjs / contracts.mjs):
// after credentials are seeded (order 10) and each agent's plugin is installed
// (order 20), this step (order 30) configures the local Chorus daemon and, opt-in,
// installs it as a boot-autostart service.
//
// Owner decisions (elaboration Round 1):
//   - full_preflight    : reuse `daemon install`'s cwds + backend preflight so the
//                         installed service is usable out of the box.
//   - connection_only   : the credential model is Chorus URL + API key only — this
//                         step collects NO provider secrets (AWS_/ANTHROPIC_/…).
//   - default_off        : the interactive prompt defaults to No (opt-in).
//   - explicit_flag      : a non-interactive run (non-TTY OR --yes) installs the
//                         boot service ONLY when --daemon-autostart is passed.
//   - linux_and_mac      : auto-start is real on Linux (systemd) and macOS (launchd);
//                         unsupported platforms write daemon.json + print manual steps.
//   - boot_and_now       : accepting installs AND enables the service (start now +
//                         at every boot) via the shared installService.
//   - report_skip_repair : a re-run where the service is already installed reports
//                         "already configured" and does not rewrite.
//
// All collaborators are injected (matching credential-seed.mjs) so the step
// unit-tests with fakes; production uses the real daemon-service / install-config
// modules, and an integration test can drive REAL installService against a fake io.

import { STEP_SCOPES, OUTCOME_ACTIONS } from "../contracts.mjs";
import {
  autostartCapability as defaultAutostartCapability,
  detectSupervisor as defaultDetectSupervisor,
  installService as defaultInstallService,
  resolveServicePaths as defaultResolveServicePaths,
} from "../../daemon-service.mjs";
import {
  resolveInstallCredentials as defaultResolveInstallCredentials,
  resolveInstallCwds as defaultResolveInstallCwds,
  resolveInstallAgent as defaultResolveInstallAgent,
} from "../../daemon-install-config.mjs";

const STEP_ID = "daemon-setup";
const { INSTALLED, SKIPPED, FAILED } = OUTCOME_ACTIONS;
const out = (action, detail) => ({ stepId: STEP_ID, action, detail });

/**
 * The daemon-setup step body.
 * @param {import("../contracts.mjs").StepContext & {
 *   autostartCapability?: Function, detectSupervisor?: Function,
 *   installService?: Function, resolveServicePaths?: Function, serviceIo?: object,
 *   resolveInstallCredentials?: Function, resolveInstallCwds?: Function,
 *   resolveInstallAgent?: Function,
 *   writeConfig?: Function, readJson?: Function, loginPath?: string,
 *   resolve?: Function, validate?: Function, processCwd?: string,
 * }} ctx
 * @returns {Promise<import("../contracts.mjs").StepOutcome>}
 */
export async function setupDaemon(ctx) {
  const env = ctx.env ?? process.env;
  const io = ctx.io ?? {};
  const isTTY = !!io.isTTY;
  const flags = ctx.flags ?? {};
  const log = typeof io.log === "function" ? io.log : () => {};

  // Injectable collaborators (real defaults in production).
  const capabilityOf = ctx.autostartCapability ?? defaultAutostartCapability;
  const detect = ctx.detectSupervisor ?? defaultDetectSupervisor;
  const install = ctx.installService ?? defaultInstallService;
  const servicePaths = ctx.resolveServicePaths ?? defaultResolveServicePaths;
  const serviceIo = ctx.serviceIo; // undefined ⇒ daemon-service uses its real defaultIO
  const resolveCreds = ctx.resolveInstallCredentials ?? defaultResolveInstallCredentials;
  const resolveCwds = ctx.resolveInstallCwds ?? defaultResolveInstallCwds;
  const resolveAgent = ctx.resolveInstallAgent ?? defaultResolveInstallAgent;

  // "Non-interactive" for the auto-start decision = non-TTY OR --yes (a --yes run in
  // a TTY must never block on the prompt), matching `daemon install --yes`.
  const nonInteractive = !isTTY || flags.yes === true;
  const skip = nonInteractive; // suppress the resolvers' prompts in non-interactive mode

  // Shared opts threaded into the reused preflight resolvers. undefined deps fall
  // through to the resolvers' real defaults (updateDaemonConfig / readJsonSafe / …).
  const preflightOpts = {
    isTTY,
    skip,
    writeConfig: ctx.writeConfig,
    readJson: ctx.readJson,
    loginPath: ctx.loginPath,
    prompt: io.ask,
    log,
  };

  // 1. Full preflight (decision: full_preflight). Persist the served cwd set and
  //    the default backend agent into daemon.json (credentials were seeded by the
  //    credential-seed step at order 10). Connection-only: no provider secrets.
  try {
    await resolveCwds(flags, preflightOpts);
    await resolveAgent(flags, env, { ...preflightOpts, errLog: log });
  } catch (err) {
    return out(FAILED, `daemon preflight failed: ${err?.message ?? String(err)}`);
  }

  const manual = () => {
    log("[chorus init] daemon config written to ~/.chorus/daemon.json.");
    log("[chorus init] start the daemon yourself: `chorus daemon` (foreground) or `chorus daemon -d` (background).");
  };

  // 2. Capability gate (decision: linux_and_mac). Only offer auto-start where a real
  //    boot service exists; unsupported platforms write the config + print manual steps.
  const capability = capabilityOf(serviceIo);
  if (capability === "unsupported") {
    const platformLabel = serviceIo?.platform ?? process.platform;
    manual();
    return out(SKIPPED, `daemon.json written; auto-start unsupported on ${platformLabel} — start with 'chorus daemon'`);
  }

  // 3. Decide whether to install (decision: default_off / explicit_flag).
  if (nonInteractive) {
    if (flags.daemonAutostart !== true) {
      manual();
      return out(SKIPPED, "daemon.json written; pass --daemon-autostart to install the boot service");
    }
  } else {
    const answer = typeof io.ask === "function"
      ? String((await io.ask("Install & enable the Chorus daemon to auto-start on boot? [y/N]: ")) ?? "").trim()
      : "";
    if (!/^y(es)?$/i.test(answer)) {
      manual();
      return out(SKIPPED, "declined auto-start; daemon.json written — start with 'chorus daemon'");
    }
  }

  // 4. Idempotency short-circuit (decision: report_skip_repair) — BEFORE the
  //    credential gate, so an already-installed healthy re-run neither re-validates
  //    (which could fail on a transient server outage) nor rewrites the unit. A
  //    missing/absent service falls through to install (which repairs the drift).
  const sup = detect(serviceIo);
  if ((sup.kind === "systemd" || sup.kind === "launchd") && sup.installed) {
    return out(SKIPPED, `daemon already configured for auto-start (${sup.kind}) — left unchanged`);
  }

  // 5. Credential validate-or-abort gate — reached only when actually installing.
  //    Reuse the SAME guarantee as `daemon install`: resolve → server-validate the
  //    key → persist url+key+identity; abort (install nothing) on failure. This does
  //    NOT lean on credential-seed, whose SKIPPED path performs no server validation
  //    and whose FAILED outcome does not stop runInit.
  let cred;
  try {
    cred = await resolveCreds(flags, env, {
      isTTY,
      skip,
      resolve: ctx.resolve,
      validate: ctx.validate,
      writeConfig: ctx.writeConfig,
      prompt: io.ask,
      log,
      errLog: log,
    });
  } catch (err) {
    return out(FAILED, `credential preflight failed: ${err?.message ?? String(err)}`);
  }
  if (!cred || !cred.ok) {
    return out(FAILED, "credentials could not be resolved/validated — no boot service installed");
  }

  // 6. Install & enable the boot service (decision: boot_and_now).
  const cwdList = Array.isArray(flags.cwd) ? flags.cwd : typeof flags.cwd === "string" ? [flags.cwd] : [];
  const spec = {
    ...servicePaths(env),
    // cwds/agent live in daemon.json (persisted above); the unit carries neither.
    cwds: cwdList,
    chorusOnly: flags.chorusOnly === true,
    workingDir: ctx.processCwd ?? process.cwd(),
  };
  const r = install(spec, serviceIo);
  if (r && r.installed) {
    log("[chorus init] daemon installed & enabled — it will auto-start on boot.");
    for (const s of r.steps ?? []) log(`[chorus init]   ${s}`);
    return out(INSTALLED, `boot service installed (${r.platform}); manage with 'chorus daemon status|stop|restart|logs'`);
  }
  return out(FAILED, `service install failed: ${r?.error ?? "unknown error"}`);
}

/** @type {import("../contracts.mjs").InitStep} */
export const daemonSetupStep = {
  id: STEP_ID,
  order: 30, // after credential-seed (10) and plugin-install (20)
  scope: STEP_SCOPES.ONCE,
  run: setupDaemon,
};
