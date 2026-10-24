import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { buildMcpConfig } from "./mcp-config.mjs";

export function ideaTeamRuntimeConfig({ runtime, env, cwd = process.cwd(), creds, ideaTeamTurn }) {
  if (!ideaTeamTurn) return { env: {}, cleanup() {} };
  if (!creds?.url || !creds?.apiKey) throw new Error("Idea Team runtime requires explicit connection credentials");
  const pi = runtime === "pi";
  if (!pi) {
    const roots = [join(cwd, ".kiro"), join(env.HOME || homedir(), ".kiro")];
    const source = roots.find((root) => existsSync(join(root, "agents", "chorus.json")));
    if (!source) throw new Error("Fenced Kiro wake requires an installed Chorus agent profile");
    const agent = JSON.parse(readFileSync(join(source, "agents", "chorus.json"), "utf8"));
    let servers = {};
    for (const root of [...roots].reverse()) {
      const path = join(root, "settings", "mcp.json");
      if (existsSync(path)) servers = { ...servers, ...JSON.parse(readFileSync(path, "utf8")).mcpServers };
    }
    const agentName = `chorus-turn-${randomUUID()}`;
    const path = join(source, "agents", `${agentName}.json`);
    const chorus = buildMcpConfig({ ...creds, ideaTeamTurn }).mcpServers.chorus;
    writeFileSync(path, JSON.stringify({ ...agent, name: agentName, includeMcpJson: false,
      mcpServers: { ...servers, ...agent.mcpServers, chorus } }), { mode: 0o600, flag: "wx" });
    return { env: {}, agentName, cleanup: () => rmSync(path, { force: true }) };
  }
  const key = "PI_CODING_AGENT_DIR";
  const source = resolve(env[key] || join(env.HOME || homedir(), ".pi", "agent"));
  const configs = ["mcp.json", "mcp-adapter.json"];
  const projects = [".mcp.json", ".pi/mcp-adapter.json"];
  for (const relative of projects) {
    const path = join(cwd, relative);
    if (existsSync(path) && JSON.parse(readFileSync(path, "utf8"))?.mcpServers?.chorus) {
      throw new Error("Project Chorus MCP override cannot carry isolated Idea Team admission; remove override before waking");
    }
  }
  const root = mkdtempSync(join(tmpdir(), `chorus-${runtime}-turn-`));
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  try {
    if (existsSync(source)) for (const name of readdirSync(source)) {
      if (!configs.includes(name)) symlinkSync(join(source, name), join(root, name), statSync(join(source, name)).isDirectory() ? "junction" : "file");
    }
    for (const relative of configs) {
      const original = join(source, relative);
      const config = existsSync(original) ? JSON.parse(readFileSync(original, "utf8")) : {};
      const { bearerToken: _bearerToken, ...settings } = config.mcpServers?.chorus ?? {};
      const chorus = { ...settings, ...buildMcpConfig({ ...creds, ideaTeamTurn }).mcpServers.chorus };
      config.mcpServers = { ...config.mcpServers, chorus };
      const path = join(root, relative);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
    }
    return { env: { [key]: root, PI_CODING_AGENT_SESSION_DIR: env.PI_CODING_AGENT_SESSION_DIR || join(source, "sessions") }, cleanup };
  } catch (error) { cleanup(); throw error; }
}
