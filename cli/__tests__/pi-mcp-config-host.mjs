import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parsePiVersion } from "../init/pi-mcp-backend.mjs";
import { resolvePiMcpConfigPath, writePiMcpServer } from "../init/pi-mcp-config.mjs";

const version = process.argv[2];
if (!version) {
  for (const host of ["0.84.4", "0.87.1", "0.99.0", "1.0.2"]) {
    const root = mkdtempSync(join(tmpdir(), "chorus-cli-pi-config-"));
    try {
      const cwd = join(root, "project");
      mkdirSync(cwd);
      const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), host], {
        cwd, encoding: "utf8", timeout: 30_000,
        env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: join(root, "custom-agent"),
          CHORUS_API_KEY: "cho_isolated_dummy", PI_PACKAGE_DIR: `/tmp/chorus-pi-compat-${host}/node_modules/@earendil-works/pi-coding-agent` },
      });
      assert.equal(result.status, 0, `${host}: ${result.error ?? ""}\n${result.stderr}\n${result.stdout}`);
      process.stdout.write(result.stdout);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
} else {
  const sdkRoot = `/tmp/chorus-pi-compat-${version}`;
  const sdk = join(sdkRoot, "node_modules/@earendil-works/pi-coding-agent");
  assert.equal(JSON.parse(readFileSync(join(sdk, "package.json"), "utf8")).version, version);
  const backend = parsePiVersion(version);
  const configPath = resolvePiMcpConfigPath(process.env, backend);
  const url = "http://127.0.0.1:12345/api/mcp";
  writePiMcpServer({ configPath, url, backend });
  assert.ok(!readFileSync(configPath, "utf8").includes(process.env.CHORUS_API_KEY));
  const hostConfig = await import(pathToFileURL(join(sdk, "dist/config.js")));
  assert.equal(hostConfig.getAgentDir(), process.env.PI_CODING_AGENT_DIR);
  if (backend.mode === "legacy") {
    const adapter = join(sdkRoot, "node_modules/pi-mcp-adapter");
    assert.equal(JSON.parse(readFileSync(join(adapter, "package.json"), "utf8")).version, "5.0.0");
    const require = createRequire(join(sdk, "package.json"));
    const { createJiti } = require("jiti");
    const loader = await createJiti(import.meta.url).import(join(adapter, "config.ts"));
    loader.setPiMcpConfigEnabled(false);
    assert.equal(loader.getPiGlobalConfigPath(), configPath);
    const config = loader.loadMcpConfig(undefined, process.cwd());
    assert.equal(config.mcpServers.chorus.url, url);
    assert.equal(config.mcpServers.chorus.directTools, true);
    writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "mcp.json"), JSON.stringify({ mcpServers: { chorus: { url: "http://127.0.0.1:9", directTools: false } } }));
    writePiMcpServer({ configPath, url, backend });
    assert.equal(loader.loadMcpConfig(undefined, process.cwd()).mcpServers.chorus.directTools, true);
    rmSync(configPath);
    writePiMcpServer({ configPath, url, backend });
    assert.equal(loader.loadMcpConfig(undefined, process.cwd()).mcpServers.chorus.directTools, false);
    console.log(`${version}: adapter5 primary discovery, fresh directTools, primary precedence and preserved legacy migration PASS`);
  } else {
    const loader = await import(pathToFileURL(join(sdk, "dist/extensions/mcp/config.js")));
    const config = loader.loadMcpConfig({ agentDir: hostConfig.getAgentDir(), cwd: process.cwd(), projectTrusted: true });
    assert.deepEqual(config.errors, []);
    const chorus = config.servers.find((server) => server.name === "chorus");
    assert.equal(chorus.source, configPath);
    assert.equal(chorus.config.url, url);
    assert.equal(chorus.config.headers.Authorization, "Bearer ${CHORUS_API_KEY}");
    assert.equal(loader.getMcpToolExposure(chorus.config, "chorus_checkin"), "codemode");
    console.log(`${version}: native agent-dir discovery, accepted generated server and default codemode PASS`);
  }
}
