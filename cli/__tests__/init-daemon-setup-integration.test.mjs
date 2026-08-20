// cli/__tests__/init-daemon-setup-integration.test.mjs
// End-to-end integration checkpoint for the daemon-setup step (proposal-review
// BLOCKER-2): drive the REAL runInit orchestrator → the REAL daemon-setup step →
// the REAL installService, with only the leaf IO faked (io.platform="linux" + a
// fake spawnSync/writeFileSync, and hermetic credential resolve/validate + a
// capturing writeConfig). Asserts the modules COMPOSE — a coherent systemd unit is
// rendered and `enable --now` runs — AND that on the init SELECTION path daemon-setup
// writes NO deprecated top-level fields to daemon.json (per-agent creds/cwds/agentType
// live in agents[], written by credential-seed; the gate validates without persisting).
import { describe, it, expect } from "vitest";
import { runInit } from "../init.mjs";
import { daemonSetupStep } from "../init/steps/daemon-setup.mjs";
import { systemdUnitPath } from "../daemon-service.mjs";

describe("chorus init → daemon-setup → installService (integration, linux)", () => {
  it("installs a coherent systemd unit and (selection path) writes NO deprecated top-level fields to daemon.json", async () => {
    const spawnCalls = [];
    const fileWrites = [];
    const serviceIo = {
      platform: "linux",
      home: "/home/u",
      mkdirSync: () => {},
      writeFileSync: (p, t) => fileWrites.push([p, t]),
      // unit not yet installed → detectSupervisor returns kind:none → not idempotent-skip
      existsSync: () => false,
      unlinkSync: () => {},
      spawnSync: (cmd, args) => {
        spawnCalls.push([cmd, ...(args ?? [])]);
        // systemctl --version (capability probe) and all install verbs succeed.
        return { status: 0, stdout: "systemd 255", stderr: "" };
      },
    };

    const configWrites = [];
    const deps = {
      env: { PATH: "/usr/bin:/bin" },
      io: { log: () => {}, isTTY: false }, // non-interactive
      detectAgents: async () => [{ id: "claude", displayName: "Claude Code", binaryOnPath: false, configDirPresent: false, detected: false }],
      resolveSelection: async () => ({ selectedIds: ["claude"] }),
      // Run ONLY the real daemon-setup step through the real orchestrator.
      orderedSteps: () => [daemonSetupStep],
      ctxExtras: {
        serviceIo,
        // Hermetic preflight IO threaded into the REAL resolveInstall* resolvers.
        writeConfig: (partial) => { configWrites.push(partial); return "/home/u/.chorus/daemon.json"; },
        readJson: () => null, // unconfigured → cwds default to process cwd, agent → default
        resolve: () => ({ url: "https://c.example", apiKey: "cho_k", source: "env" }),
        validate: async () => ({ uuid: "agent-1", name: "Bot" }),
        processCwd: "/proj",
      },
    };

    // --daemon-autostart makes the non-interactive run actually install.
    const code = await runInit(["--daemon-autostart", "--yes"], deps);
    expect(code).toBe(0);

    // 1. A coherent systemd unit was written to the right path.
    const unitWrite = fileWrites.find(([p]) => p === systemdUnitPath({ home: "/home/u" }));
    expect(unitWrite).toBeTruthy();
    expect(unitWrite[1]).toMatch(/Type=simple/);
    expect(unitWrite[1]).toMatch(/ExecStart=.*chorus\.mjs daemon/);

    // 2. enable --now ran (start now + at boot).
    expect(spawnCalls).toContainEqual(["systemctl", "--user", "daemon-reload"]);
    expect(spawnCalls).toContainEqual(["systemctl", "--user", "enable", "--now", "chorus-daemon.service"]);

    // 3. Selection path: daemon-setup persisted NOTHING top-level. Per-agent creds +
    //    cwds + agentType are written by credential-seed into agents[] (not run here);
    //    step 1 skips resolveInstallCwds/Agent, and the gate validates with a no-op
    //    writeConfig — so the deprecated flat url/apiKey/agentUuid/cwds/agent never
    //    reappear outside the array. The credentials were still server-validated
    //    (the install proceeded, proving the gate ran) — just not persisted flat.
    const merged = Object.assign({}, ...configWrites);
    expect(configWrites).toEqual([]);
    for (const k of ["url", "apiKey", "agentUuid", "agentName", "cwds", "agent"]) {
      expect(merged).not.toHaveProperty(k);
    }
    // connection-only: never a provider-secret field.
    expect(JSON.stringify(configWrites)).not.toMatch(/AWS_|BEDROCK|ANTHROPIC/);
  });
});
