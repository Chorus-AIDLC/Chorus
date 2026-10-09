import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { appendFile, copyFile, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { resolvePiMcpConfigPath, writePiMcpServer } from "../../../cli/init/pi-mcp-config.mjs";

const { values } = parseArgs({ options: {
  "sdk-root": { type: "string" }, artifact: { type: "string" }, version: { type: "string" },
  exposure: { type: "string", default: "direct" }, keep: { type: "boolean" }, help: { type: "boolean" },
  gate: { type: "string", default: "all" },
  connection: { type: "string", default: "env" }, "agent-dir": { type: "string", default: "custom" },
} });
if (values.help) {
  console.log("node test/compat-host.mjs --sdk-root /tmp/chorus-pi-compat-0.84.4 " +
    "--artifact /tmp/chorus.tgz --version 0.84.4 --exposure direct [--keep] [--gate all] " +
    "[--connection env|generated-fresh|generated-retained] [--agent-dir default|custom]\n" +
    "Env alternatives: CHORUS_PI_SDK_ROOT, CHORUS_PI_PACKED_ARTIFACT. " +
    "SDK root is an isolated installation containing node_modules; no workspace fallback.");
  process.exit(0);
}
const here = dirname(fileURLToPath(import.meta.url));
const root = realpathSync(values["sdk-root"] ?? process.env.CHORUS_PI_SDK_ROOT ?? "");
const artifact = realpathSync(values.artifact ?? process.env.CHORUS_PI_PACKED_ARTIFACT ?? "");
const artifactBytes = await readFile(artifact);
const artifactHash = createHash("sha256").update(artifactBytes).digest("hex");
const sdkDir = join(root, "node_modules/@earendil-works/pi-coding-agent");
const metadata = JSON.parse(await readFile(join(sdkDir, "package.json"), "utf8"));
assert.ok(["0.84.4", "0.87.1", "0.99.0", "1.0.2"].includes(metadata.version));
if (values.version) assert.equal(metadata.version, values.version);
assert.equal(metadata.name, "@earendil-works/pi-coding-agent");
assert.ok(realpathSync(sdkDir).startsWith(root + "/"), "SDK must resolve inside isolated installation");
const legacy = metadata.version.startsWith("0.8");
const toggles = {
  "chorus-proposal-reviewer": "CHORUS_ENABLE_PROPOSAL_REVIEWER",
  "chorus-task-reviewer": "CHORUS_ENABLE_TASK_REVIEWER",
  "chorus-code-reviewer": "CHORUS_ENABLE_CODE_REVIEWER",
};
assert.ok(["all", "none", "unconfigured", ...Object.keys(toggles)].includes(values.gate));
assert.ok(["direct", "codemode"].includes(values.exposure));
assert.ok(!legacy || values.exposure === "direct", "Legacy requires adapter direct exposure");
assert.ok(["env", "generated-fresh", "generated-retained"].includes(values.connection));
assert.ok(["default", "custom"].includes(values["agent-dir"]));
const adapterDir = join(root, "node_modules/pi-mcp-adapter");
let adapter;
if (legacy) {
  adapter = JSON.parse(await readFile(join(adapterDir, "package.json"), "utf8"));
  assert.equal(adapter.version, "5.0.0", "Only the pinned, evaluated adapter is accepted");
  const require = createRequire(join(sdkDir, "package.json"));
  const semver = require("semver");
  assert.ok(semver.satisfies(metadata.version, adapter.peerDependencies["@earendil-works/pi-ai"]));
  if (adapter.engines?.node) assert.ok(semver.satisfies(process.version, adapter.engines.node));
} else {
  assert.ok(!existsSync(adapterDir), "Native fixture installation must not contain the adapter");
}
const dependencies = {};
const sdkRequire = createRequire(join(sdkDir, "package.json"));
for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-agent-core", "@earendil-works/pi-tui"]) {
  const location = sdkRequire.resolve.paths(name).map((directory) => join(directory, name))
    .find((directory) => existsSync(join(directory, "package.json")));
  assert.ok(location, `${name} must be installed with the SDK`);
  const manifest = JSON.parse(await readFile(join(location, "package.json"), "utf8"));
  assert.equal(manifest.name, name);
  assert.ok(realpathSync(location).startsWith(root + "/"), `${name} escaped the isolated installation`);
  dependencies[name] = { version: manifest.version, location: realpathSync(location) };
}

const scratch = await mkdtemp(join(tmpdir(), `chorus-packed-${metadata.version}-`));
const agentDir = values["agent-dir"] === "default" ? join(scratch, "home/.pi/agent") : join(scratch, "agent");
const packed = join(scratch, "package");
const events = [];
const queues = [];
const lifecycle = [];
const results = [];
let session;
let backend;
try {
  await mkdir(agentDir, { recursive: true });
  await mkdir(join(scratch, "home"), { recursive: true });
  const snapshot = join(scratch, "artifact.tgz");
  await writeFile(snapshot, artifactBytes);
  const entries = execFileSync("tar", ["-tzf", snapshot], { encoding: "utf8" }).trim().split("\n");
  assert.ok(entries.every((entry) => entry.startsWith("package/") && !entry.split("/").includes("..")),
    "Artifact must be an npm pack tarball");
  execFileSync("tar", ["-xzf", snapshot, "-C", scratch]);
  assert.ok(!existsSync(join(packed, "node_modules")), "Artifact cannot bundle a different Pi SDK");
  await symlink(join(root, "node_modules"), join(scratch, "node_modules"));
  const packageMetadata = JSON.parse(await readFile(join(packed, "package.json"), "utf8"));
  assert.equal(packageMetadata.name, "@chorus-aidlc/chorus-pi");
  const mcpLog = join(scratch, "mcp.jsonl");
  const modelLog = join(scratch, "models.jsonl");
  await writeFile(mcpLog, "");
  await writeFile(modelLog, "");
  await copyFile(join(here, "compat-provider.ts"), join(scratch, "provider.ts"));
  await copyFile(join(here, "compat-mcp-fixture.mjs"), join(scratch, "mcp-fixture.mjs"));
  for (const key of Object.keys(process.env)) {
    if (/(API_KEY|ACCESS_TOKEN|AUTH_TOKEN)$/.test(key) || key.startsWith("CHORUS_") ||
      key.startsWith("PI_") || key.startsWith("ANTHROPIC_") || key.startsWith("OPENAI_")) delete process.env[key];
  }
  Object.assign(process.env, { HOME: join(scratch, "home"), XDG_CONFIG_HOME: join(scratch, "home/.config"),
    PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0", CHORUS_SPEC_MODE: "off",
    CHORUS_API_KEY: "dummy-local-only", CHORUS_COMPAT_MCP_LOG: mcpLog, CHORUS_COMPAT_MODEL_LOG: modelLog,
    CHORUS_ENABLE_PROPOSAL_REVIEWER: "true", CHORUS_ENABLE_TASK_REVIEWER: "true",
    CHORUS_ENABLE_CODE_REVIEWER: "true", PATH: `${join(root, "node_modules/.bin")}:${process.env.PATH}` });
  for (const [reviewer, key] of Object.entries(toggles)) {
    process.env[key] = String(values.gate !== "none" && values.gate !== reviewer);
  }
  if (values.gate === "unconfigured") process.env.CHORUS_API_KEY = "";
  if (values["agent-dir"] === "default") delete process.env.PI_CODING_AGENT_DIR;
  const fixtureNames = ["chorus_pm_submit_proposal", "chorus_submit_for_verify", "chorus_admin_verify_task",
    "chorus_submit_for_verify_extra", "chorus_get_task", "chorus_list_tasks", "chorus_list_projects",
    "chorus_add_comment", "chorus_checkin"];
  process.chdir(scratch);
  process.argv[1] = join(sdkDir, metadata.bin.pi);
  backend = createServer(async (request, response) => {
    try {
      if (request.method !== "POST") {
        response.writeHead(request.method === "DELETE" ? 204 : 405).end();
        return;
      }
      let body = "";
      for await (const part of request) body += part;
      const rpc = JSON.parse(body);
      assert.equal(request.headers.authorization, "Bearer dummy-local-only");
      if (rpc.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      let result = {};
      if (rpc.method === "initialize") {
        result = { protocolVersion: rpc.params.protocolVersion, capabilities: { tools: {} },
          serverInfo: { name: "chorus-config-seam", version: "1.0.0" } };
      }
      if (rpc.method === "tools/list") {
        result = { tools: fixtureNames.map((name) => ({ name, description: "Local configuration seam fixture",
          inputSchema: { type: "object", properties: { fail: { type: "boolean" }, tool: { type: "string" },
            marker: { type: "string" } }, additionalProperties: false } })) };
      }
      if (rpc.method === "tools/call") {
        const bookkeeping = ["chorus_create_session", "chorus_close_session"].includes(rpc.params.name) ||
          (rpc.params.name === "chorus_checkin" && !rpc.params.arguments?.marker);
        if (bookkeeping) {
          lifecycle.push(rpc.params);
          const data = rpc.params.name === "chorus_create_session" ? { uuid: `fixture-session-${lifecycle.length}` } : {};
          result = { content: [{ type: "text", text: JSON.stringify(data) }] };
        } else {
          assert.ok(fixtureNames.includes(rpc.params.name));
          await appendFile(mcpLog, JSON.stringify({ pid: process.pid, ...rpc.params }) + "\n");
          result = { content: [{ type: "text", text: rpc.params.arguments?.fail ? "fixture failure" : "fixture success" }],
            isError: rpc.params.arguments?.fail === true };
        }
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
    } catch (error) {
      response.writeHead(500).end(error.message);
    }
  });
  await new Promise((accept) => backend.listen(0, "127.0.0.1", accept));
  const endpoint = `http://127.0.0.1:${backend.address().port}/mcp`;
  const configPath = resolvePiMcpConfigPath(process.env, { mode: legacy ? "legacy" : "native", supported: true });
  const stalePath = join(agentDir, legacy ? "mcp.json" : "mcp-adapter.json");
  let staleConfig;
  if (values.connection === "env") {
    process.env.CHORUS_URL = endpoint;
    await writeFile(configPath, JSON.stringify({ mcpServers: { chorus: {
      command: process.execPath, args: [join(scratch, "mcp-fixture.mjs")],
      env: { CHORUS_COMPAT_MCP_LOG: mcpLog },
      ...(legacy ? { directTools: true } : { exposure: values.exposure }),
    } } }));
  } else {
    assert.equal(process.env.CHORUS_URL, undefined);
    process.env.CHORUS_AGENT_PROFILE = "fixture";
    if (values.connection === "generated-retained") {
      staleConfig = JSON.stringify({ mcpServers: { chorus: { type: "http", url: "http://127.0.0.1:1/stale",
        headers: { Authorization: "Bearer cho_stale" } } } });
      await writeFile(stalePath, staleConfig);
    }
    if (!legacy) await writeFile(configPath, JSON.stringify({ mcpServers: { chorus: { exposure: values.exposure } } }));
    writePiMcpServer({ configPath, url: endpoint, backend: { mode: legacy ? "legacy" : "native", supported: true } });
  }
  const generatedConfig = await readFile(configPath, "utf8");
  const extensionPaths = [join(scratch, "provider.ts"), join(packed, "extensions/chorus.ts"),
    join(packed, "extensions/subagent/index.ts"), ...(legacy ? [join(adapterDir, "index.ts")] : [])];
  const settings = { compaction: { enabled: false }, retry: { enabled: false },
    defaultProjectTrust: "never", steeringMode: "all", cacheWarming: "off",
    defaultProvider: "chorus-fixture", defaultModel: "deterministic", defaultThinkingLevel: "off",
    extensions: extensionPaths };
  await writeFile(join(agentDir, "settings.json"), JSON.stringify(settings));
  await mkdir(join(agentDir, "agents"));
  await writeFile(join(agentDir, "agents/compat-custom.md"),
    "---\nname: compat-custom\ndescription: Local custom agent\n---\nComplete the local fixture probe.\n");
  const sdk = await import(pathToFileURL(join(sdkDir, "dist/index.js")).href);
  const settingsManager = sdk.SettingsManager.inMemory(settings);
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, "auth.json"),
    modelsPath: null, modelsStorePath: join(agentDir, "models-store.json"), refreshOnCreate: false });
  const loader = new sdk.DefaultResourceLoader({ cwd: scratch, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: extensionPaths,
    extensionFactories: [
      ...(!legacy ? [sdk.createCodemodeExtension(), sdk.createToolSearchExtension(), sdk.createMcpExtension()] : []),
      (pi) => {
        for (const type of ["tool_call", "tool_result", "tool_execution_end"]) {
          pi.on(type, (event) => { events.push({ type, name: event.toolName, id: event.toolCallId,
            parentId: event.parentToolCallId, isError: event.isError }); });
        }
      },
    ] });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  ({ session } = await sdk.createAgentSession({ cwd: scratch, agentDir, resourceLoader: loader,
    settingsManager, modelRuntime, sessionManager: sdk.SessionManager.inMemory(), noTools: "builtin" }));
  const extensionErrors = [];
  session.subscribe((event) => {
    if (event.type === "extension_error") extensionErrors.push(event);
    if (event.type === "queue_update") queues.push({ steering: event.steering, followUp: event.followUp });
  });
  await session.bindExtensions({});
  await session.setModel(modelRuntime.getModel("chorus-fixture", "deterministic"));
  const allNames = () => session.getAllTools().map((tool) => tool.name);
  const deadline = Date.now() + 20000;
  while (!allNames().some((name) => name.endsWith("chorus_get_task"))) {
    assert.ok(Date.now() < deadline, `MCP fixture failed to connect: ${allNames()}`);
    await new Promise((accept) => setTimeout(accept, 25));
  }
  assert.ok(allNames().includes("subagent"), "Packed bundled subagent must load");
  const names = Object.fromEntries(["chorus_get_task", "chorus_list_tasks", "chorus_list_projects",
    "chorus_add_comment", "chorus_checkin", "chorus_pm_submit_proposal", "chorus_submit_for_verify",
    "chorus_admin_verify_task", "chorus_submit_for_verify_extra"].map((operation) => {
    const matches = allNames().filter((name) => name.endsWith(operation));
    assert.equal(matches.length, 1, `${operation}: ${allNames()}`);
    return [operation, matches[0]];
  }));
  const action = (operation, args = {}) => values.exposure === "codemode"
    ? { name: "codemode", arguments: { code: `console.log(await tools.${names[operation]}(${JSON.stringify(args)}));` } }
    : { name: names[operation], arguments: args };
  const prompt = (id, actions) => `COMPAT_PROBE=${JSON.stringify({ id, actions })}`;
  const logs = async (path) => (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
  const workflows = [
    ["chorus_pm_submit_proposal", "chorus-proposal-reviewer"],
    ["chorus_submit_for_verify", "chorus-task-reviewer"],
    ["chorus_admin_verify_task", "chorus-code-reviewer"],
  ];
  const verifyWorkflows = async () => {
    for (const [index, [operation, reviewer]] of [
      ...workflows, ...workflows.map(([operation]) => [operation, null]),
      ["chorus_get_task", null], ["chorus_submit_for_verify_extra", null],
    ].entries()) {
      const before = session.messages.length;
      const eventStart = events.length;
      const queueStart = queues.length;
      const fail = index >= 3 && index < 6;
      await session.prompt(prompt(`workflow-${index}`, [action(operation,
        { fail, ...(operation === "chorus_get_task" ? { tool: "chorus_submit_for_verify" } : {}) })]));
      const toolEvents = events.slice(eventStart).filter((event) => event.type === "tool_result" && event.name === names[operation]);
      assert.equal(toolEvents.length, 1, JSON.stringify(events.slice(eventStart)));
      assert.equal(toolEvents[0].isError, fail);
      assert.equal(events.slice(eventStart).filter((event) => event.type === "tool_call" && event.name === names[operation]).length, 1);
      if (!legacy) assert.equal(toolEvents[0].parentId,
        values.exposure === "codemode" ? `compat-workflow-${index}-0` : undefined);
      const reminders = session.messages.slice(before).filter((message) => message.role === "user" &&
        JSON.stringify(message.content).includes("spawn chorus-"));
      const expected = reviewer && values.gate !== "unconfigured" && process.env[toggles[reviewer]] === "true" ? 1 : 0;
      assert.equal(reminders.length, expected, JSON.stringify(session.messages.slice(before)));
      if (expected) assert.match(JSON.stringify(reminders), new RegExp(reviewer));
      assert.equal(queues.slice(queueStart).some((queue) => queue.steering.some((text) => text.includes("spawn chorus-"))), expected === 1);
      assert.ok(queues.slice(queueStart).every((queue) => queue.followUp.length === 0));
      if (values.exposure === "codemode") {
        const parents = events.slice(eventStart).filter((event) => event.type === "tool_result" && event.name === "codemode");
        assert.equal(parents.length, 1);
        assert.equal(parents[0].isError, false);
      }
      results.push({ operation, fail, reminderCount: reminders.length });
    }
  };
  for (const reviewer of values.gate === "all" ? Object.keys(toggles) : []) {
    const marker = `reviewer-${reviewer}`;
    const before = (await logs(mcpLog)).length;
    const allowed = ["chorus_get_task", "chorus_list_tasks", "chorus_list_projects", "chorus_add_comment", "chorus_checkin"];
    const denied = ["chorus_pm_submit_proposal", "chorus_submit_for_verify", "chorus_admin_verify_task"];
    const childActions = [{ name: "chorus_review", arguments: { action: "discover" } },
      ...[...allowed, ...denied].map((operation) => ({ name: "chorus_review",
        arguments: { action: "call", tool: operation, arguments: { marker } } }))];
    const messageStart = session.messages.length;
    await session.prompt(prompt(marker, [{ name: "subagent", arguments: {
      agent: reviewer, task: prompt(marker, childActions), async: false,
    } }]));
    const childCalls = (await logs(mcpLog)).slice(before).filter((call) => call.arguments?.marker === marker);
    assert.deepEqual(childCalls.map((call) => call.name).sort(), allowed.sort(),
      `${reviewer} must reach allowed operations, never mutations: ${JSON.stringify(session.messages.slice(messageStart))}`);
    const childTurns = (await logs(modelLog)).filter((turn) => turn.id === marker && turn.pid !== process.pid);
    assert.ok(childTurns.some((turn) => turn.completed === childActions.length), `${reviewer} child did not finish`);
    const childResults = childTurns.at(-1).messages.filter((message) => message.toolCallId.startsWith(`compat-${marker}-`));
    assert.equal(childResults.length, childActions.length);
    assert.ok(childResults.slice(0, 1 + allowed.length).every((message) => !message.isError), JSON.stringify(childResults));
    assert.ok(childResults.slice(1 + allowed.length).every((message) => message.isError), JSON.stringify(childResults));
    assert.ok(childTurns.every((turn) => turn.tools.includes("chorus_review")));
    const forbiddenNames = [...denied.map((operation) => names[operation]),
      "mcp", "mcpScript", "codemode", "tool_search", "chorus_work"];
    assert.ok(childTurns.every((turn) => !turn.tools.some((name) => forbiddenNames.includes(name))),
      "Reviewer hard allowlist must not expose mutations");
    assert.ok(childTurns.every((turn) => !turn.hasSessionWorkflow));
    results.push({ reviewer, allowed: allowed.length, denied: denied.length, childPid: childTurns[0].pid });
  }
  for (const agent of values.gate === "all" ? ["chorus-worker", "compat-custom"] : []) {
    const before = lifecycle.length;
    const marker = `child-${agent}`;
    const childAction = (operation) => agent === "chorus-worker"
      ? { name: "chorus_work", arguments: { action: "call", tool: operation, arguments: { marker } } }
      : action(operation, { marker });
    await session.prompt(prompt(marker, [{ name: "subagent", arguments: { agent,
      task: prompt(marker, [childAction("chorus_get_task"), childAction("chorus_submit_for_verify")]) } }]));
    assert.deepEqual((await logs(mcpLog)).filter((call) => call.arguments?.marker === marker).map((call) => call.name),
      ["chorus_get_task", "chorus_submit_for_verify"], `${agent} must retain inherited tools`);
    const childTurns = (await logs(modelLog)).filter((turn) => turn.id === marker && turn.pid !== process.pid);
    assert.ok(childTurns.some((turn) => turn.completed === 2), `${agent} child must finish`);
    assert.ok(childTurns.every((turn) => turn.hasSessionWorkflow === (agent === "chorus-worker")));
    const created = lifecycle.slice(before).filter((call) => call.name === "chorus_create_session");
    const closed = lifecycle.slice(before).filter((call) => call.name === "chorus_close_session");
    assert.equal(created.length, agent === "chorus-worker" ? 1 : 0);
    assert.equal(closed.length, created.length);
    results.push({ agent, createdSessions: created.length, closedSessions: closed.length });
  }
  await verifyWorkflows();
  assert.equal(lifecycle.some((call) => call.name === "chorus_checkin"), values.gate !== "unconfigured");
  assert.deepEqual(extensionErrors, []);
  assert.equal(await readFile(configPath, "utf8"), generatedConfig);
  if (staleConfig) assert.equal(await readFile(stalePath, "utf8"), staleConfig);
  console.log("COMPAT_RESULT=" + JSON.stringify({ piVersion: metadata.version, sdkDir, dependencies,
    packageVersion: packageMetadata.version, artifact, sha256: artifactHash,
    nodeVersion: process.version, adapter: adapter ? { version: adapter.version, peers: adapter.peerDependencies,
      engines: adapter.engines } : null, exposure: values.exposure, gate: values.gate,
    connection: values.connection, agentDirMode: values["agent-dir"], names, results, lifecycle,
    verification: "Packed extension, real isolated Pi SDK and CLI children; only provider and local MCP/HTTP services are fixtures" }));
} catch (error) {
  console.error(`Compatibility failure; scratch=${scratch}\n${error.stack}\nCompleted checks: ${JSON.stringify(results)}`);
  process.exitCode = 1;
} finally {
  if (session) await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
  session?.dispose();
  if (backend) await new Promise((accept) => backend.close(accept));
  if (!values.keep) await rm(scratch, { recursive: true, force: true });
}
