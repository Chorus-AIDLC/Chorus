// cli/__tests__/agents.test.mjs
// Covers `chorus agents` (cli/agents.mjs): lists ~/.chorus/daemon.json agents[]
// for CHORUS_AGENT_PROFILE / --agent discovery, NEVER printing the API key.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runAgents, collectAgents, removeAgent } from "../agents.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LOGIN_PATH = "/home/u/.chorus/daemon.json";

function cap() {
  const out = [];
  const err = [];
  return {
    out,
    err,
    stdout: { write: (s) => out.push(String(s)) },
    stderr: { write: (s) => err.push(String(s)) },
    text: () => out.join(""),
    errText: () => err.join(""),
  };
}

/** Build deps with a fake daemon.json + env. */
function deps({ file = null, env = {} } = {}, io) {
  return { env, loginPath: LOGIN_PATH, readJson: () => file, stdout: io.stdout, stderr: io.stderr };
}

const TWO_AGENTS = {
  agents: [
    {
      apiKey: "cho_ADMINSECRET",
      url: "https://chorus.example.dev",
      agentType: "claude-code",
      agentUuid: "daee0667-8487-4810-9cc0-8e4a0b2174c9",
      agentName: "Admin Claude",
    },
    {
      apiKey: "cho_CODEXSECRET",
      url: "https://chorus.example.dev",
      agentType: "codex",
      agentUuid: "b0e3a413-d812-44b7-a512-8c6dacd9e180",
      agentName: "Codex",
      daemonWake: false,
    },
  ],
};

describe("chorus agents — listing", () => {
  it("lists each agent with name, uuid, backend — and NEVER the API key", () => {
    const io = cap();
    const code = runAgents([], deps({ file: TWO_AGENTS }, io));
    expect(code).toBe(0);
    const text = io.text();
    expect(text).toContain("Admin Claude");
    expect(text).toContain("daee0667-8487-4810-9cc0-8e4a0b2174c9");
    expect(text).toContain("claude-code");
    expect(text).toContain("Codex");
    expect(text).toContain("wake:off"); // daemonWake:false surfaced
    expect(text).toContain("chorus.example.dev"); // url host
    // The secret must never appear anywhere.
    expect(text).not.toContain("cho_");
  });

  it("marks the agent matching CHORUS_AGENT_PROFILE as active (by uuid or name)", () => {
    const byName = cap();
    runAgents([], deps({ file: TWO_AGENTS, env: { CHORUS_AGENT_PROFILE: "Codex" } }, byName));
    // The Codex row is marked with the leading '*', Admin is not.
    expect(byName.text()).toMatch(/\*\s*\[1\] Codex/);
    expect(byName.text()).toMatch(/ {2}\[0\] Admin Claude/);
    expect(byName.text()).toContain('* = active (CHORUS_AGENT_PROFILE="Codex")');

    const byUuid = cap();
    runAgents(
      [],
      deps({ file: TWO_AGENTS, env: { CHORUS_AGENT_PROFILE: "daee0667-8487-4810-9cc0-8e4a0b2174c9" } }, byUuid),
    );
    expect(byUuid.text()).toMatch(/\*\s*\[0\] Admin Claude/);
  });

  it("marks nothing active when CHORUS_AGENT_PROFILE is unset", () => {
    const io = cap();
    runAgents([], deps({ file: TWO_AGENTS, env: {} }, io));
    expect(io.text()).not.toContain("* = active");
    expect(io.text()).not.toMatch(/\*\s*\[/);
  });

  it("warns (does not claim an active row) when CHORUS_AGENT_PROFILE matches no agent", () => {
    const io = cap();
    runAgents([], deps({ file: TWO_AGENTS, env: { CHORUS_AGENT_PROFILE: "ghost" } }, io));
    expect(io.text()).not.toMatch(/\*\s*\[/); // nothing marked
    expect(io.text()).not.toContain("* = active");
    expect(io.text()).toContain('CHORUS_AGENT_PROFILE="ghost" is set but matches no agent');
  });

  it("falls back to the flat single-agent config when there is no agents[]", () => {
    const io = cap();
    const flat = { url: "https://flat.example.dev", apiKey: "cho_FLATSECRET", agentUuid: "u-flat", agentName: "Solo", agent: "kiro" };
    runAgents([], deps({ file: flat }, io));
    const text = io.text();
    expect(text).toContain("Solo");
    expect(text).toContain("u-flat");
    expect(text).toContain("kiro");
    expect(text).not.toContain("cho_");
  });

  it("prints a friendly message when no agents are configured", () => {
    const io = cap();
    const code = runAgents([], deps({ file: null }, io));
    expect(code).toBe(0);
    expect(io.text()).toContain("No agents configured");
    expect(io.text()).toContain("chorus agents add");
  });
});

describe("chorus agents — --json", () => {
  it("emits redacted JSON (no apiKey, with an active flag)", () => {
    const io = cap();
    const code = runAgents(["--json"], deps({ file: TWO_AGENTS, env: { CHORUS_AGENT_PROFILE: "Codex" } }, io));
    expect(code).toBe(0);
    const text = io.text();
    expect(text).not.toContain("cho_");
    expect(text).not.toMatch(/apiKey/i);
    const parsed = JSON.parse(text);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ name: "Admin Claude", uuid: "daee0667-8487-4810-9cc0-8e4a0b2174c9", agentType: "claude-code", active: false });
    expect(parsed[1]).toMatchObject({ name: "Codex", active: true, daemonWake: false });
    // No apiKey key on any object.
    for (const row of parsed) expect(Object.keys(row)).not.toContain("apiKey");
  });

  it("emits only the url ORIGIN in --json (strips userinfo/path/query, so an embedded secret can't leak)", () => {
    const io = cap();
    const sneaky = {
      agents: [
        { apiKey: "cho_k", agentUuid: "u1", agentName: "A", url: "https://user:s3cr3t@host.example.dev/api/mcp?token=abc123" },
      ],
    };
    runAgents(["--json"], deps({ file: sneaky }, io));
    const text = io.text();
    expect(text).not.toContain("s3cr3t");
    expect(text).not.toContain("abc123");
    const parsed = JSON.parse(text);
    expect(parsed[0].url).toBe("https://host.example.dev");
  });
});

describe("chorus agents — flags", () => {
  it("--help prints usage and exits 0", () => {
    const io = cap();
    const code = runAgents(["--help"], deps({ file: TWO_AGENTS }, io));
    expect(code).toBe(0);
    expect(io.text()).toContain("USAGE");
    expect(io.text()).toContain("chorus agents");
    expect(io.text()).toContain("API key");
  });

  it("an unknown flag errors to stderr with exit 2", () => {
    const io = cap();
    const code = runAgents(["--bogus"], deps({ file: TWO_AGENTS }, io));
    expect(code).toBe(2);
    expect(io.errText()).toContain("unknown flag");
  });
});

describe("chorus agents remove", () => {
  // deps with a fake daemon.json + a writeConfig that captures the partial (no disk).
  function rmDeps(file, io) {
    const captured = {};
    return {
      dep: {
        loginPath: LOGIN_PATH,
        readJson: () => file,
        writeConfig: (partial) => {
          captured.partial = partial;
        },
        stdout: io.stdout,
        stderr: io.stderr,
      },
      captured,
    };
  }

  it("removes the matching agent by uuid, rewriting agents[] without the key", () => {
    const io = cap();
    const { dep, captured } = rmDeps(TWO_AGENTS, io);
    const code = removeAgent(["b0e3a413-d812-44b7-a512-8c6dacd9e180"], dep);
    expect(code).toBe(0);
    expect(captured.partial.agents).toHaveLength(1);
    expect(captured.partial.agents[0].agentName).toBe("Admin Claude");
    expect(io.text()).toContain("Removed agent Codex");
    expect(io.text()).not.toContain("cho_");
    // dsh note NOT printed for a claude-code/codex agent.
    expect(io.text()).not.toContain("$DSH_HOME");
  });

  it("removes by agentName", () => {
    const io = cap();
    const { dep, captured } = rmDeps(TWO_AGENTS, io);
    expect(removeAgent(["Admin Claude"], dep)).toBe(0);
    expect(captured.partial.agents.map((a) => a.agentName)).toEqual(["Codex"]);
  });

  it("no match → exit 1, lists configured agents, writes nothing", () => {
    const io = cap();
    const { dep, captured } = rmDeps(TWO_AGENTS, io);
    expect(removeAgent(["ghost"], dep)).toBe(1);
    expect(captured.partial).toBeUndefined();
    expect(io.errText()).toContain("no configured agent matches");
    expect(io.errText()).toContain("Admin Claude");
    expect(io.errText()).not.toContain("cho_");
  });

  it("ambiguous name → exit 2, writes nothing", () => {
    const dup = {
      agents: [
        { apiKey: "cho_1", url: "https://c", agentUuid: "u1", agentName: "Twin" },
        { apiKey: "cho_2", url: "https://c", agentUuid: "u2", agentName: "Twin" },
      ],
    };
    const io = cap();
    const { dep, captured } = rmDeps(dup, io);
    expect(removeAgent(["Twin"], dep)).toBe(2);
    expect(captured.partial).toBeUndefined();
    expect(io.errText()).toContain("ambiguous");
    // ...but the unique uuid removes cleanly.
    const io2 = cap();
    const d2 = rmDeps(dup, io2);
    expect(removeAgent(["u2"], d2.dep)).toBe(0);
    expect(d2.captured.partial.agents.map((a) => a.agentUuid)).toEqual(["u1"]);
  });

  it("missing target → exit 2; --help → exit 0", () => {
    const io = cap();
    expect(removeAgent([], rmDeps(TWO_AGENTS, io).dep)).toBe(2);
    expect(io.errText()).toContain("requires an agent name or UUID");
    const io2 = cap();
    expect(removeAgent(["--help"], rmDeps(TWO_AGENTS, io2).dep)).toBe(0);
    expect(io2.text()).toContain("chorus agents remove");
  });

  it("prints the dsh $DSH_HOME/.env note when removing an offline-bucket (dsh) agent", () => {
    const io = cap();
    const file = { agents: [{ apiKey: "cho_d", url: "https://c", agentUuid: "u-d", agentName: "DSH", agentType: "offline" }] };
    expect(removeAgent(["u-d"], rmDeps(file, io).dep)).toBe(0);
    expect(io.text()).toContain("$DSH_HOME/.env");
  });

  it("prints the ~/.claude/settings.json clear-manually note when removing a claude-code agent", () => {
    const io = cap();
    const file = { agents: [{ apiKey: "cho_c", url: "https://c", agentUuid: "u-c", agentName: "Admin Claude", agentType: "claude-code" }] };
    expect(removeAgent(["u-c"], rmDeps(file, io).dep)).toBe(0);
    expect(io.text()).toContain("~/.claude/settings.json");
    expect(io.text()).toContain("clear them manually");
    expect(io.text()).not.toContain("cho_"); // key never printed
  });

  it("prints the ~/.codex/.env clear-manually note when removing a codex agent", () => {
    const io = cap();
    const file = { agents: [{ apiKey: "cho_x", url: "https://c", agentUuid: "u-x", agentName: "Codex", agentType: "codex" }] };
    expect(removeAgent(["u-x"], rmDeps(file, io).dep)).toBe(0);
    expect(io.text()).toContain("~/.codex/.env"); // the credential sink
    expect(io.text()).toContain("~/.codex/config.toml"); // the untouched literal Bearer
    expect(io.text()).toContain("clear them manually");
    expect(io.text()).not.toContain("cho_"); // key never printed
  });
});

describe("runAgents — sub-verb dispatch", () => {
  it("`add` delegates to runInit with the remaining args", async () => {
    const io = cap();
    let seen = null;
    const code = await runAgents(["add", "--all", "--yes"], {
      stdout: io.stdout,
      stderr: io.stderr,
      version: "9.9.9",
      runInit: async (args, o) => {
        seen = { args, o };
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(seen.args).toEqual(["--all", "--yes"]);
    expect(seen.o).toMatchObject({ version: "9.9.9" });
  });

  it("`remove` delegates to removeAgent", () => {
    const io = cap();
    let wrote = null;
    const code = runAgents(["remove", "b0e3a413-d812-44b7-a512-8c6dacd9e180"], {
      loginPath: LOGIN_PATH,
      readJson: () => TWO_AGENTS,
      writeConfig: (p) => {
        wrote = p;
      },
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(0);
    expect(wrote.agents).toHaveLength(1);
  });

  it("bare / `list` both list; unknown sub-verb → exit 2 + group usage", () => {
    const listed = cap();
    expect(runAgents(["list"], deps({ file: TWO_AGENTS }, listed))).toBe(0);
    expect(listed.text()).toContain("Admin Claude");

    const bad = cap();
    expect(runAgents(["bogus"], deps({ file: TWO_AGENTS }, bad))).toBe(2);
    expect(bad.errText()).toContain("unknown `chorus agents` subcommand");
  });
});

describe("collectAgents — pure shape", () => {
  it("skips non-object entries and carries daemonWake through", () => {
    const rows = collectAgents({ agents: [null, TWO_AGENTS.agents[1]] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ index: 1, name: "Codex", daemonWake: false });
  });
});

describe("chorus agents — router dispatch (real entry)", () => {
  it("`node chorus.mjs agents --help` prints usage and exits 0 without starting the server", () => {
    const out = execFileSync(process.execPath, ["chorus.mjs", "agents", "--help"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(out).toContain("manage this machine's configured agents");
    expect(out).toContain("USAGE");
    expect(out).not.toContain("Starting embedded PostgreSQL");
  });

  it("`node chorus.mjs agents add --help` prints the add (former init) help, exits 0, no server boot", () => {
    const out = execFileSync(process.execPath, ["chorus.mjs", "agents", "add", "--help"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(out).toContain("Chorus agents add");
    expect(out).toContain("chorus agents add --agents claude,codex");
    expect(out).not.toContain("Starting embedded PostgreSQL");
  });

  it("`node chorus.mjs init` is retired — prints the rename hint, exits non-zero, no server boot", () => {
    let stdout = "";
    let status = 0;
    try {
      stdout = execFileSync(process.execPath, ["chorus.mjs", "init"], { cwd: REPO_ROOT, encoding: "utf8" });
    } catch (e) {
      status = e.status ?? 1;
      stdout = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }
    expect(status).not.toBe(0);
    expect(stdout).toContain("`chorus init` has been renamed to `chorus agents add`");
    expect(stdout).not.toContain("Starting embedded PostgreSQL");
  });
});
