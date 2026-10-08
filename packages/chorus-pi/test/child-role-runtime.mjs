import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { fixtureTools, forbiddenOperations, reviewOperations, startFixture, workOperations } from "./fixtures/child-role-mcp.mjs";

const { values } = parseArgs({ options: {
  "sdk-root": { type: "string" }, artifact: { type: "string" },
  host: { type: "string", default: "all" }, dispatcher: { type: "string", default: "all" },
  connection: { type: "string", default: "all" },
  timeout: { type: "string", default: "180" }, keep: { type: "boolean" },
  cell: { type: "boolean" }, help: { type: "boolean" },
} });
if (values.help) {
  console.log("node packages/chorus-pi/test/child-role-runtime.mjs --sdk-root /isolated/sdk " +
    "[--artifact /tmp/chorus.tgz] [--host all|native|adapter] [--dispatcher all|nicobailon|bundled] " +
    "[--connection all|env|file|file-stale] [--timeout 180] [--keep]\n" +
    "Requires isolated Pi >=1.1 <2, pi-subagents 0.76.1 and pi-mcp-adapter 5.1.0. " +
    "Defaults to the local package and all twelve host/dispatcher/connection cells (48 children). " +
    "env overrides conflicting file credentials; file-stale adds an inactive-backend config. " +
    "Only the model and loopback MCP are fixtures. " +
    "CHORUS_PI_SDK_ROOT and CHORUS_PI_PACKED_ARTIFACT are accepted. No external model/auth needed.");
  process.exit(0);
}
assert.ok(["all", "native", "adapter"].includes(values.host));
assert.ok(["all", "nicobailon", "bundled"].includes(values.dispatcher));
assert.ok(["all", "env", "file", "file-stale"].includes(values.connection));
const timeoutMs = Number(values.timeout) * 1000;
assert.ok(Number.isFinite(timeoutMs) && timeoutMs >= 1000, "--timeout must be positive seconds");
const sdkRootOption = values["sdk-root"] ?? process.env.CHORUS_PI_SDK_ROOT;
assert.ok(sdkRootOption, "Pass --sdk-root pointing to an isolated SDK installation");
const root = realpathSync(sdkRootOption);
const artifactOption = values.artifact ?? process.env.CHORUS_PI_PACKED_ARTIFACT;
const artifact = artifactOption ? realpathSync(artifactOption) : undefined;
const here = dirname(fileURLToPath(import.meta.url));
const sdkDir = join(root, "node_modules/@earendil-works/pi-coding-agent");
const adapterDir = join(root, "node_modules/pi-mcp-adapter");
const subagentsDir = join(root, "node_modules/pi-subagents");
const sdkRequire = createRequire(join(sdkDir, "package.json"));
const metadata = JSON.parse(await readFile(join(sdkDir, "package.json"), "utf8"));
assert.equal(metadata.name, "@earendil-works/pi-coding-agent");
assert.ok(sdkRequire("semver").satisfies(metadata.version, ">=1.1.0 <2"), `Unsupported Pi ${metadata.version}`);
for (const [directory, version] of [[subagentsDir, "0.76.1"], [adapterDir, "5.1.0"]]) {
  assert.equal(JSON.parse(await readFile(join(directory, "package.json"), "utf8")).version, version);
}
for (const directory of [sdkDir, adapterDir, subagentsDir]) {
  assert.ok(realpathSync(directory).startsWith(root + "/"), `${directory} escapes isolated SDK root`);
}

if (!values.cell) {
  const hosts = values.host === "all" ? ["native", "adapter"] : [values.host];
  const dispatchers = values.dispatcher === "all" ? ["nicobailon", "bundled"] : [values.dispatcher];
  const connections = values.connection === "all" ? ["env", "file", "file-stale"] : [values.connection];
  const results = [];
  for (const connection of connections) for (const host of hosts) for (const dispatcher of dispatchers) {
    console.log(`CHILD_ROLE_START=${connection}/${host}/${dispatcher}`);
    const args = [fileURLToPath(import.meta.url), "--cell", "--sdk-root", root, "--host", host,
      "--dispatcher", dispatcher, "--connection", connection, "--timeout", values.timeout,
      ...(artifact ? ["--artifact", artifact] : []), ...(values.keep ? ["--keep"] : [])];
    const code = await new Promise((accept, reject) => {
      const child = spawn(process.execPath, args, { stdio: "inherit", detached: true });
      const timer = setTimeout(() => {
        console.error(`Timed out after ${values.timeout}s: ${connection}/${host}/${dispatcher}`);
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
      }, timeoutMs);
      child.on("error", reject);
      child.on("exit", (status) => { clearTimeout(timer); accept(status ?? 1); });
    });
    results.push({ host, dispatcher, connection, code });
  }
  console.log("CHILD_ROLE_MATRIX=" + JSON.stringify(results));
  process.exit(results.every((result) => result.code === 0) ? 0 : 1);
}

assert.notEqual(values.host, "all");
assert.notEqual(values.dispatcher, "all");
assert.notEqual(values.connection, "all");
const scratch = await mkdtemp(join(tmpdir(), `chorus-child-${values.connection}-${values.host}-${values.dispatcher}-`));
const agentDir = join(scratch, "home/.pi/agent");
const modelLog = join(scratch, "model.jsonl");
const networkLog = join(scratch, "network.jsonl");
const results = [];
let session;
let fixture;
let shadowFixture;
const configSnapshots = new Map();
let passed = false;
const prompt = (id, actions) => `CHILD_ROLE_PROBE=${JSON.stringify({ id, actions })}`;
const readLog = async () => (await readFile(modelLog, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
const lifecycleCalls = () => fixture.requests.filter((request) => request.method === "tools/call" &&
  !request.params.arguments?.marker && ["chorus_checkin", "chorus_create_session", "chorus_close_session"].includes(request.params.name));
const parsedObjects = (value) => {
  if (typeof value === "string") {
    try { return parsedObjects(JSON.parse(value)); } catch { return []; }
  }
  if (!value || typeof value !== "object") return [];
  return [value, ...Object.values(value).flatMap(parsedObjects)];
};
try {
  await mkdir(agentDir, { recursive: true });
  await mkdir(join(scratch, "tmp"));
  await writeFile(modelLog, "");
  await writeFile(networkLog, "");
  await symlink(join(root, "node_modules"), join(scratch, "node_modules"), "dir");
  let packageDir = resolve(here, "..");
  let sha256;
  if (artifact) {
    const bytes = await readFile(artifact);
    sha256 = createHash("sha256").update(bytes).digest("hex");
    const entries = execFileSync("tar", ["-tzf", artifact], { encoding: "utf8" }).trim().split("\n");
    assert.ok(entries.every((entry) => entry.startsWith("package/") && !entry.split("/").includes("..")),
      "Packed artifact must contain only package-relative entries");
    execFileSync("tar", ["-xzf", artifact, "-C", scratch]);
    packageDir = join(scratch, "package");
  }
  const packageMetadata = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
  assert.equal(packageMetadata.name, "@chorus-aidlc/chorus-pi");
  for (const file of ["lib/child-review.ts", "lib/child-work.ts"]) {
    assert.ok(existsSync(join(packageDir, file)), `Provider not ready: ${file}`);
  }
  const provider = join(scratch, "provider.ts");
  await copyFile(join(here, "fixtures/child-role-provider.ts"), provider);
  for (const key of Object.keys(process.env)) {
    if (/(API_KEY|ACCESS_TOKEN|AUTH_TOKEN)$/.test(key) || /^(CHORUS_|PI_|ANTHROPIC_|OPENAI_)/.test(key)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, { HOME: join(scratch, "home"), XDG_CONFIG_HOME: join(scratch, "home/.config"),
    TMPDIR: join(scratch, "tmp"),
    PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0", CHORUS_SPEC_MODE: "off",
    CHORUS_CHILD_MODEL_LOG: modelLog,
    CHORUS_CHILD_NETWORK_LOG: networkLog,
    PATH: `${join(root, "node_modules/.bin")}:${process.env.PATH}` });
  process.chdir(scratch);
  process.argv[1] = join(sdkDir, metadata.bin.pi);
  fixture = await startFixture(networkLog);
  if (values.connection !== "file") {
    shadowFixture = await startFixture(networkLog, "shadow-fixture-only");
  }
  if (values.connection === "env") {
    process.env.CHORUS_URL = fixture.endpoint;
    process.env.CHORUS_API_KEY = "fixture-only";
  }
  const configPath = join(agentDir, values.host === "native" ? "mcp.json" : "mcp-adapter.json");
  const inactiveConfigPath = join(agentDir, values.host === "native" ? "mcp-adapter.json" : "mcp.json");
  const config = JSON.stringify({ mcpServers: { chorus: {
    url: values.connection === "env" ? shadowFixture.endpoint : fixture.endpoint,
    headers: { Authorization: `Bearer ${values.connection === "env" ? "shadow-fixture-only" : "fixture-only"}` },
    ...(values.host === "native" ? { exposure: "direct" } : {}) } } }, null, 2) + "\n";
  await writeFile(configPath, config);
  configSnapshots.set(configPath, Buffer.from(config));
  if (values.connection === "file-stale") {
    const inactiveConfig = JSON.stringify({ mcpServers: { chorus: { url: shadowFixture.endpoint,
      headers: { Authorization: "Bearer shadow-fixture-only" } } } }, null, 2) + "\n";
    await writeFile(inactiveConfigPath, inactiveConfig);
    configSnapshots.set(inactiveConfigPath, Buffer.from(inactiveConfig));
  } else {
    configSnapshots.set(inactiveConfigPath, null);
  }
  const extensionPaths = [provider, join(packageDir, "extensions/chorus.ts"),
    values.dispatcher === "bundled" ? join(packageDir, "extensions/subagent/index.ts") : join(subagentsDir, "index.js"),
    ...(values.host === "adapter" ? [join(adapterDir, "index.ts")] : [])];
  const settings = { compaction: { enabled: false }, retry: { enabled: false },
    defaultProjectTrust: "never", cacheWarming: "off", defaultThinkingLevel: "off",
    defaultProvider: "chorus-child-fixture", defaultModel: "deterministic",
    packages: [{ source: packageDir, extensions: [], skills: [] }],
    extensions: [...extensionPaths, "-builtin:codemode", ...(values.host === "adapter" ? ["-builtin:mcp"] : [])] };
  await writeFile(join(agentDir, "settings.json"), JSON.stringify(settings));
  const sdk = await import(pathToFileURL(join(sdkDir, "dist/index.js")).href);
  const settingsManager = sdk.SettingsManager.inMemory(settings);
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, "auth.json"),
    modelsPath: null, modelsStorePath: join(agentDir, "models-store.json"), refreshOnCreate: false });
  const loader = new sdk.DefaultResourceLoader({ cwd: scratch, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: extensionPaths,
    extensionFactories: values.host === "native" ? [sdk.createMcpExtension()] : [] });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, [], "Host extensions must load");
  ({ session } = await sdk.createAgentSession({ cwd: scratch, agentDir, resourceLoader: loader,
    settingsManager, modelRuntime, sessionManager: sdk.SessionManager.inMemory(), noTools: "builtin" }));
  const extensionErrors = [];
  session.subscribe((event) => { if (event.type === "extension_error") extensionErrors.push(event); });
  await session.bindExtensions({});
  await session.setModel(modelRuntime.getModel("chorus-child-fixture", "deterministic"));
  const parentCheckins = lifecycleCalls().filter((request) => request.params.name === "chorus_checkin");
  const parentTools = session.getAllTools().map((tool) => tool.name);
  assert.ok(parentTools.includes("subagent"), `Dispatcher not registered: ${parentTools}`);
  if (values.host === "adapter") {
    assert.ok(parentTools.includes("mcp"), "Adapter default gateway missing");
    assert.ok(!parentTools.includes("mcpScript"), "Adapter must use default, non-script mode");
  }
  for (const agent of ["chorus-proposal-reviewer", "chorus-task-reviewer", "chorus-code-reviewer", "chorus-worker"]) {
    const worker = agent === "chorus-worker";
    const tool = worker ? "chorus_work" : "chorus_review";
    const marker = `${values.connection}-${values.host}-${values.dispatcher}-${agent}`;
    const lifecycleStart = lifecycleCalls().length;
    const allowed = [...reviewOperations, ...(worker ? workOperations : [])];
    const denied = [...forbiddenOperations, ...(worker ? [] : workOperations)];
    const call = (operation, args = {}) => ({ name: tool,
      arguments: { action: "call", tool: operation, arguments: { marker, ...args } } });
    const actions = [{ name: tool, arguments: { action: "discover" } },
      ...allowed.map((operation) => call(operation)), ...denied.map((operation) => call(operation)),
      call("chorus_get_task", { fail: true })];
    const parentId = `parent-${marker}`;
    const parentActions = [{ name: "subagent", arguments: { agent, task: prompt(marker, actions),
      ...(values.dispatcher === "nicobailon" ? { async: true } : {}) } },
    ...(values.dispatcher === "nicobailon" ? [{ name: "bg_wait",
      arguments: { all: true, stopOnAttention: false, timeoutMs: Math.min(timeoutMs, 120000) } },
    { name: "subagent", arguments: { action: "status" } }] : [])];
    await session.prompt(prompt(parentId, parentActions));
    await writeFile(join(scratch, `${agent}-session.json`), JSON.stringify(session.messages, null, 2));
    const log = await readLog();
    const parent = log.filter((turn) => turn.id === parentId).at(-1);
    assert.equal(parent?.completed, parentActions.length,
      `${agent}: parent did not finish: ${JSON.stringify(session.messages.at(-1))}`);
    assert.ok(parent.results.every((result) => !result.isError), `${agent}: dispatch/wait failed: ${JSON.stringify(parent.results)}`);
    await writeFile(join(scratch, `${agent}-dispatch.json`), JSON.stringify(parent.results, null, 2));
    const turns = log.filter((turn) => turn.id === marker);
    const child = turns.at(-1);
    assert.ok(child, `${agent}: no child model turn; dispatch=${JSON.stringify(parent.results)}`);
    assert.notEqual(child.pid, process.pid, `${agent}: must launch an actual child process`);
    assert.equal(child.completed, actions.length, `${agent}: incomplete child; dispatch=${JSON.stringify(parent.results)}`);
    for (const turn of turns) {
      assert.deepEqual(turn.connectionEnv, { url: values.connection === "env", apiKey: values.connection === "env" },
        `${agent}: file modes must not receive connection environment overrides`);
      assert.equal(turn.piVersion, metadata.version, `${agent}: child must use the isolated Pi version`);
      for (const surface of [turn.registry, turn.activeTools]) {
        assert.ok(surface.includes(tool), `${agent}: ${tool} absent from child registry`);
      }
      assert.ok(!turn.activeTools.includes(worker ? "chorus_review" : "chorus_work"));
      assert.ok(!turn.activeTools.some((name) => ["mcp", "mcpScript", "codemode", "tool_search"].includes(name)),
        `${agent}: unexpected unrestricted gateway: ${turn.activeTools}`);
      if (!worker) assert.ok(!turn.activeTools.some((name) => ["edit", "write"].includes(name)));
    }
    assert.ok(child.results.slice(0, 1 + allowed.length).every((result) => !result.isError),
      `${agent}: discovery/allowed call failed: ${JSON.stringify(child.results.find((result) => result.isError))}`);
    const discovered = parsedObjects(child.results[0]).filter((value) => value.inputSchema && value.name);
    assert.deepEqual([...new Set(discovered.map((value) => value.name))].sort(), [...allowed].sort(),
      `${agent}: discovery must return precisely the available role schemas`);
    for (const operation of allowed) {
      assert.deepEqual(discovered.find((value) => value.name === operation).inputSchema,
        fixtureTools.find((value) => value.name === operation).inputSchema);
    }
    const rejected = child.results.slice(1 + allowed.length, -1);
    assert.equal(rejected.length, denied.length);
    assert.ok(rejected.every((result) => result.isError), `${agent}: forbidden call succeeded`);
    for (const result of rejected) assert.match(JSON.stringify(result.content), /not allowed|forbidden|denied/i);
    const denialTurns = turns.filter((turn) => turn.completed >= 1 + allowed.length &&
      turn.completed <= 1 + allowed.length + denied.length);
    assert.equal(denialTurns.length, denied.length + 1);
    assert.equal(new Set(denialTurns.map((turn) => turn.networkBytes)).size, 1,
      `${agent}: forbidden calls must fail before ANY fixture network request`);
    assert.ok(!/tool (?:not found|unavailable)|unknown tool|unavailable tool/i.test(JSON.stringify(child.results)),
      `${agent}: unresolved tool, rather than role enforcement`);
    assert.ok(child.results.at(-1).isError, `${agent}: backend error must propagate`);
    assert.match(JSON.stringify(child.results.at(-1)), /fixture-requested-failure/);
    const calls = fixture.requests.filter((request) => request.method === "tools/call" && request.params.arguments?.marker === marker);
    assert.deepEqual(calls.map((request) => request.params.name), [...allowed, "chorus_get_task"],
      `${agent}: allowed calls must reach fixture exactly once; denied calls must never reach network`);
    assert.ok(fixture.requests.some((request) => request.method === "tools/list" && request.params?.cursor === "second"));
    const terminalResults = [...parent.results];
    if (values.dispatcher === "nicobailon") {
      const completions = parent.results.find((result) => result.toolName === "bg_wait")?.details?.completions;
      assert.equal(completions?.length, 1, `${agent}: bg_wait must observe one terminal child`);
      assert.equal(completions[0].state, "complete");
      assert.equal(completions[0].success, true);
      for (const result of completions[0].results) {
        assert.equal(result.success, true);
        const metadataPath = result.artifactPaths?.metadataPath;
        assert.ok(metadataPath?.startsWith(scratch + "/"), `${agent}: missing isolated child metadata`);
        terminalResults.push(JSON.parse(await readFile(metadataPath, "utf8")));
      }
    }
    const outcomes = parsedObjects(terminalResults).filter((value) => typeof value.exitCode === "number");
    assert.ok(outcomes.length > 0, `${agent}: no terminal exit status; dispatch is not completion: ${JSON.stringify(parent.results)}`);
    assert.ok(outcomes.every((value) => value.exitCode === 0), `${agent}: child exit failure: ${JSON.stringify(outcomes)}`);
    assert.ok(!/unavailable tool|unknown tool|tool not found/i.test(JSON.stringify(parent.results)));
    if (worker) {
      const deadline = Date.now() + 5000;
      while (!lifecycleCalls().slice(lifecycleStart).some((request) => request.params.name === "chorus_close_session") &&
        Date.now() < deadline) await new Promise((accept) => setTimeout(accept, 25));
    }
    const lifecycle = lifecycleCalls().slice(lifecycleStart);
    const created = lifecycle.filter((request) => request.params.name === "chorus_create_session");
    const closed = lifecycle.filter((request) => request.params.name === "chorus_close_session");
    assert.equal(created.length, worker ? 1 : 0, `${agent}: only workers must create a session`);
    assert.equal(closed.length, created.length, `${agent}: created worker session must close after completion`);
    if (worker) {
      assert.equal(created[0].params.arguments.name, agent);
      assert.ok(turns.every((turn) => turn.sessionUuid === "fixture-worker-session"), `${agent}: missing injected session UUID`);
      assert.equal(closed[0].params.arguments.sessionUuid, "fixture-worker-session");
    } else assert.ok(turns.every((turn) => turn.sessionUuid === null), `${agent}: reviewers must not receive worker sessions`);
    results.push({ agent, pid: child.pid, allowed: allowed.length, denied: denied.length, exitCode: 0,
      createdSessions: created.length, closedSessions: closed.length });
    console.log("CHILD_ROLE_PASS=" + JSON.stringify({ host: values.host, dispatcher: values.dispatcher,
      connection: values.connection, ...results.at(-1) }));
  }
  assert.equal(parentCheckins.length, 1, "Parent extension must check in before any child dispatch, including file-only modes");
  const parentTurns = (await readLog()).filter((turn) => turn.id.startsWith("parent-"));
  assert.ok(parentTurns.every((turn) => turn.connectionEnv.url === (values.connection === "env") &&
    turn.connectionEnv.apiKey === (values.connection === "env")), "Parent connection environment must match selected mode");
  assert.deepEqual(extensionErrors, []);
  assert.deepEqual(fixture.errors, []);
  if (shadowFixture) {
    assert.deepEqual(shadowFixture.errors, []);
    assert.deepEqual(shadowFixture.requests.filter((request) => request.method === "tools/call"), [],
      "Environment override / active backend must win: no operations may reach conflicting configuration");
  }
  for (const [path, expected] of configSnapshots) {
    assert.deepEqual(existsSync(path) ? await readFile(path) : null, expected, `${path}: MCP config bytes must remain unchanged`);
  }
  console.log("CHILD_ROLE_RESULT=" + JSON.stringify({ piVersion: metadata.version, subagentsVersion: "0.76.1",
    adapterVersion: values.host === "adapter" ? "5.1.0" : null, host: values.host, dispatcher: values.dispatcher,
    connection: values.connection, parentCheckins: parentCheckins.length, lifecycle: lifecycleCalls(),
    configsUnchanged: [...configSnapshots.keys()],
    packageVersion: packageMetadata.version, packageDir, artifact, sha256, results, scratch,
    verification: "Real Pi CLI children and dispatcher; deterministic model and loopback MCP fixtures only" }));
  passed = true;
} catch (error) {
  console.error(`Child role runtime failure (${values.connection}/${values.host}/${values.dispatcher}); evidence=${scratch}\n${error.stack}`);
} finally {
  if (session) {
    try { await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" }); }
    catch (error) { console.error(error); passed = false; }
    session.dispose();
  }
  const configEvidence = [];
  for (const [path, expected] of configSnapshots) {
    const actual = existsSync(path) ? await readFile(path) : null;
    const hash = (bytes) => bytes === null ? null : createHash("sha256").update(bytes).digest("hex");
    configEvidence.push({ path, before: hash(expected), after: hash(actual) });
    try { assert.deepEqual(actual, expected, `${path}: MCP config changed, including shutdown`); }
    catch (error) { console.error(error.message); passed = false; }
  }
  await writeFile(join(scratch, "config-evidence.json"), JSON.stringify(configEvidence, null, 2));
  if (fixture) {
    await writeFile(join(scratch, "mcp-requests.json"), JSON.stringify(fixture.requests, null, 2));
    await writeFile(join(scratch, "mcp-errors.json"), JSON.stringify(fixture.errors, null, 2));
    await fixture.close();
  }
  if (shadowFixture) {
    await writeFile(join(scratch, "shadow-mcp-requests.json"), JSON.stringify(shadowFixture.requests, null, 2));
    await writeFile(join(scratch, "shadow-mcp-errors.json"), JSON.stringify(shadowFixture.errors, null, 2));
    await shadowFixture.close();
  }
  if (passed && !values.keep) await rm(scratch, { recursive: true, force: true });
}
process.exit(passed ? 0 : 1);
