// Real Pi 1.x session + built-in MCP/codemode + local stdio server.
// Only the model is deterministic; tool execution, events, and steering are real.
// Run: node test/pi1-native-mcp.mjs
// Optional: PI_SDK_DIR=/path/to/@earendil-works/pi-coding-agent
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
function findPackage(name, from) {
  return createRequire(from).resolve.paths(name).map((path) => join(path, name))
    .find((path) => existsSync(join(path, "package.json")));
}
const sdkDir = realpathSync(process.env.PI_SDK_DIR ??
  findPackage("@earendil-works/pi-coding-agent", import.meta.url) ??
  join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(),
    "@earendil-works/pi-coding-agent"));
const pkg = JSON.parse(await readFile(join(sdkDir, "package.json"), "utf8"));
assert.equal(pkg.name, "@earendil-works/pi-coding-agent");
assert.match(pkg.version, /^1\./, "This host probe requires Pi 1.x");
const toggles = {
  "chorus-proposal-reviewer": "CHORUS_ENABLE_PROPOSAL_REVIEWER",
  "chorus-task-reviewer": "CHORUS_ENABLE_TASK_REVIEWER",
  "chorus-code-reviewer": "CHORUS_ENABLE_CODE_REVIEWER",
};

if (!process.argv.includes("--scenario")) {
  const results = [];
  const scenarios = ["codemode", "direct"].flatMap((exposure) =>
    ["all", "none", ...Object.keys(toggles), "unconfigured"].map((gate) => ({ exposure, gate })));
  scenarios.push(...Object.keys(toggles).map((profile) => ({ exposure: "codemode", gate: "all", profile })));
  scenarios.push({ exposure: "codemode", gate: "all", profile: "legacy-native-reviewer" });
  for (const { exposure, gate, profile } of scenarios) {
      const output = execFileSync(process.execPath,
        [fileURLToPath(import.meta.url), "--scenario", exposure, gate, ...(profile ? [profile] : [])], {
          encoding: "utf8",
          timeout: 60_000,
          env: {
            ...process.env,
            PI_SDK_DIR: sdkDir,
            PI_OFFLINE: "1",
            PI_TELEMETRY: "0",
            CHORUS_SPEC_MODE: "off",
            ...Object.fromEntries(Object.entries(toggles).map(([reviewer, name]) =>
              [name, String(gate !== "none" && gate !== reviewer)])),
            PI_PROBE_NATIVE_TOOLS: JSON.stringify(results[0]?.availableToolNames ?? []),
          },
        });
      results.push(JSON.parse(output));
  }
  console.log(JSON.stringify({
    piVersion: pkg.version,
    nodeVersion: process.version,
    sdkDir,
    verification: "real Pi SDK, native MCP fixture, deterministic model; no production state writes",
    scenarios: results,
  }, null, 2));
} else {
  const [, exposure, gate, profile] = process.argv.slice(2);
  const legacyProfile = profile === "legacy-native-reviewer";
  const roleProvider = profile && !legacyProfile;
  const {
    createAgentSession, createCodemodeExtension, createMcpExtension, createToolSearchExtension,
    DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, parseFrontmatter,
  } = await import(pathToFileURL(join(sdkDir, "dist/index.js")).href);
  const { createAssistantMessageEventStream } = await import(
    pathToFileURL(join(findPackage("@earendil-works/pi-ai", join(sdkDir, "package.json")),
      "dist/index.js")).href);

  const scratch = await mkdtemp(join(tmpdir(), "chorus-pi1-native-"));
  process.env.HOME = scratch;
  const agentDir = join(scratch, "agent");
  await mkdir(agentDir);
  process.chdir(scratch);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const backendCalls = [];
  const backend = createServer(async (request, response) => {
    let body = "";
    for await (const part of request) body += part;
    const rpc = JSON.parse(body);
    if (rpc.method === "tools/call") backendCalls.push(rpc.params.name);
    response.setHeader("content-type", "application/json");
    // Chorus's bookkeeping uses this HTTP fixture, not the real Chorus server.
    response.end(JSON.stringify({
      jsonrpc: "2.0", id: rpc.id,
      result: rpc.method === "tools/call"
        ? { content: [{ type: "text", text: "{}" }] }
        : { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "local", version: "1" } },
    }));
  });
  await new Promise((accept) => backend.listen(0, "127.0.0.1", accept));
  process.env.CHORUS_URL = `http://127.0.0.1:${backend.address().port}/mcp`;
  process.env.CHORUS_API_KEY = gate === "unconfigured" ? "" : "fixture-key";
  await writeFile(join(agentDir, "mcp.json"), JSON.stringify({
    mcpServers: {
      chorus: {
        command: process.execPath,
        args: [join(here, "fixtures/native-mcp-server.mjs")],
        // Omission deliberately tests native default codemode exposure.
        ...(exposure === "direct" ? { exposure: "direct" } : {}),
      },
    },
  }));

  const operations = [
    ["chorus_pm_submit_proposal", "chorus-proposal-reviewer"],
    ["chorus_submit_for_verify", "chorus-task-reviewer"],
    ["chorus_admin_verify_task", "chorus-code-reviewer"],
  ];
  const events = [];
  const queues = [];
  const modelRequests = [];
  const dispatched = new Set();
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false }, retry: { enabled: false },
    defaultProjectTrust: "never", steeringMode: "all", cacheWarming: "off",
  });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(agentDir, "models-store.json"),
    refreshOnCreate: false,
  });
  modelRuntime.registerProvider("chorus-fixture", {
    api: "chorus-fixture-api",
    apiKey: "fixture-key",
    baseUrl: "http://127.0.0.1",
    models: [{
      id: "deterministic", name: "Deterministic local tool driver", reasoning: false,
      input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000, maxTokens: 4096,
    }],
    streamSimple(model, context) {
      modelRequests.push(context);
      const texts = context.messages.flatMap((message) => {
        if (message.role !== "user") return [];
        return typeof message.content === "string" ? [message.content] :
          message.content.filter((item) => item.type === "text").map((item) => item.text);
      });
      const text = texts.findLast((item) => item.startsWith("native-probe:"));
      const probe = JSON.parse(text.slice("native-probe:".length));
      const args = { fail: probe.fail, ...(probe.decoy ? { tool: "chorus_submit_for_verify" } : {}) };
      const fresh = !dispatched.has(probe.id);
      dispatched.add(probe.id);
      const content = fresh ? [{
        type: "toolCall", id: `fixture-${probe.id}`,
        name: roleProvider ? "chorus_review" : exposure === "codemode" ? "codemode" : `mcp__chorus__${probe.operation}`,
        arguments: roleProvider ? { action: "call", tool: probe.operation, arguments: args } : exposure === "codemode"
          ? { code: `console.log(await tools.mcp__chorus__${probe.operation}(${JSON.stringify(args)}));` }
          : args,
      }] : [{ type: "text", text: "Local probe complete." }];
      const message = {
        role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: fresh ? "toolUse" : "stop", timestamp: Date.now(),
      };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end();
      });
      return stream;
    },
  });

  let session;
  try {
    const profileFrontmatter = legacyProfile ? { tools: "read, bash, codemode, tool_search, mcp, mcpScript" } : profile ? parseFrontmatter(
      await readFile(resolve(here, `../agents/${profile}.md`), "utf8"),
    ).frontmatter : undefined;
    const profileTools = profileFrontmatter?.tools.split(",").map((name) => name.trim());
    const { expandReviewerTools } = await import(
      pathToFileURL(resolve(here, "../extensions/subagent/agents.ts")).href);
    const allowedTools = expandReviewerTools(legacyProfile ? "chorus-task-reviewer" : profile, profileTools,
      JSON.parse(process.env.PI_PROBE_NATIVE_TOOLS ?? "[]"));
    if (roleProvider) {
      assert.ok(profileTools.includes("chorus_review"));
      for (const conditional of ["codemode", "tool_search", "mcp", "mcpScript"]) {
        assert.ok(!profileTools.includes(conditional));
      }
      assert.ok(!profileTools.includes("write") && !profileTools.includes("edit"));
      assert.deepEqual(allowedTools, profileTools);
    }
    if (legacyProfile) {
      assert.ok(allowedTools.includes("codemode"));
      for (const forbidden of ["tool_search", "mcp", "mcpScript", "mcp__chorus__chorus_admin_verify_task"]) {
        assert.ok(!allowedTools.includes(forbidden));
      }
    }
    const resourceLoader = new DefaultResourceLoader({
      cwd: scratch, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true,
      noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [
        resolve(here, "../extensions/chorus.ts"), resolve(here, "../extensions/subagent/index.ts"),
        ...(roleProvider ? [resolve(here, "../agents", profileFrontmatter.subagentOnlyExtensions)] : []),
      ],
      extensionFactories: [
        createCodemodeExtension(),
        createToolSearchExtension(),
        createMcpExtension(),
        (pi) => {
          for (const type of ["tool_call", "tool_result", "tool_execution_end"]) {
            pi.on(type, (event) => {
              events.push({
                type, name: event.toolName, id: event.toolCallId,
                parentId: event.parentToolCallId, isError: event.isError,
              });
            });
          }
        },
      ],
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    ({ session } = await createAgentSession({
      cwd: scratch, agentDir, resourceLoader, settingsManager, modelRuntime,
      sessionManager: SessionManager.inMemory(),
      model: modelRuntime.getModel("chorus-fixture", "deterministic"),
      noTools: "builtin",
      ...(allowedTools ? { tools: allowedTools } : {}),
    }));
    const extensionErrors = [];
    session.subscribe((event) => {
      if (event.type === "extension_error") extensionErrors.push(event);
      if (event.type === "queue_update") queues.push({
        steering: event.steering, followUp: event.followUp,
      });
    });
    await session.bindExtensions({});
    // Native servers connect in the background; this driver can produce a tool
    // call faster than that startup completes. Wait for the real registrations.
    const readyDeadline = Date.now() + 10_000;
    while (!session.getCallableToolNames().includes(roleProvider ? "chorus_review" : "mcp__chorus__chorus_get_task")) {
      assert.ok(Date.now() < readyDeadline, "Native MCP fixture did not connect");
      await new Promise((accept) => setTimeout(accept, 10));
    }
    if (!roleProvider && exposure === "codemode") assert.ok(session.getActiveToolNames().includes("codemode"));
    if (roleProvider) assert.deepEqual(
      session.getCallableToolNames().filter((name) => name.startsWith("mcp__")).sort(),
      [],
      "The packaged reviewer uses its restricted provider, not ambient MCP tools",
    );
    const probes = profile ? [
      { operation: "chorus_get_task", fail: false, decoy: true },
      { operation: "chorus_list_tasks", fail: false },
      { operation: "chorus_list_projects", fail: false },
      { operation: "chorus_add_comment", fail: false },
      { operation: "chorus_admin_verify_task", fail: true },
      { operation: "chorus_submit_for_verify", fail: true },
    ] : [
      ...operations.map(([operation, reviewer]) => ({ operation, reviewer, fail: false })),
      ...operations.map(([operation]) => ({ operation, fail: true })),
      { operation: "chorus_submit_for_verify_extra", fail: false },
      { operation: "chorus_get_task", fail: false, decoy: true },
      { operation: "chorus_add_comment", fail: false },
    ];
    const results = [];
    for (const [index, probe] of probes.entries()) {
      const beforeMessages = session.messages.length;
      const beforeEvents = events.length;
      const beforeQueues = queues.length;
      await session.prompt("native-probe:" + JSON.stringify({ ...probe, id: index }));
      const newEvents = events.slice(beforeEvents);
      const resultsForTool = newEvents.filter((event) =>
        event.type === "tool_result" && event.name === (roleProvider ? "chorus_review" :
          legacyProfile && probe.fail ? "codemode" : `mcp__chorus__${probe.operation}`));
      assert.equal(resultsForTool.length, 1, JSON.stringify({
        events: newEvents,
        results: session.messages.slice(beforeMessages).filter((message) => message.role === "toolResult"),
      }));
      const result = resultsForTool[0];
      assert.equal(result.isError, probe.fail);
      assert.equal(result.parentId, !roleProvider && !(legacyProfile && probe.fail) && exposure === "codemode" ? `fixture-${index}` : undefined);
      assert.equal(newEvents.filter((event) =>
        event.type === "tool_call" && event.name === result.name).length, 1);
      const reminders = session.messages.slice(beforeMessages).filter((message) =>
        message.role === "user" && JSON.stringify(message.content).includes("spawn chorus-"));
      const expected = gate !== "unconfigured" && probe.reviewer &&
        process.env[toggles[probe.reviewer]] === "true" ? 1 : 0;
      assert.equal(reminders.length, expected, JSON.stringify(session.messages.slice(beforeMessages)));
      if (expected) assert.match(JSON.stringify(reminders[0].content), new RegExp(probe.reviewer));
      const newQueues = queues.slice(beforeQueues);
      assert.equal(newQueues.some((queue) => queue.steering.some((text) =>
        text.includes("spawn chorus-"))), expected === 1);
      assert.ok(newQueues.every((queue) => queue.followUp.length === 0));
      if (!roleProvider && exposure === "codemode") {
        const parents = newEvents.filter((event) =>
          event.type === "tool_result" && event.name === "codemode");
        assert.equal(parents.length, 1);
        assert.equal(parents[0].isError, legacyProfile && probe.fail);
      }
      results.push({ ...probe, toolName: result.name, parentId: result.parentId,
        reminderCount: reminders.length,
        steeringText: reminders.map((message) => message.content) });
    }
    assert.deepEqual(extensionErrors, []);
    if (roleProvider) {
      assert.deepEqual(backendCalls.filter((name) => name !== "chorus_checkin"),
        probes.filter((probe) => !probe.fail).map((probe) => probe.operation));
    }
    assert.ok(modelRequests.length >= probes.length * 2);
    console.log(JSON.stringify({
      exposure, gate, profile, profileTools, allowedTools, configured: gate !== "unconfigured",
      nativeToolNames: session.getCallableToolNames().filter((name) => name.startsWith("mcp__")),
      availableToolNames: session.getAllTools().map((tool) => tool.name),
      reviewerSettings: Object.fromEntries(Object.entries(toggles).map(([reviewer, name]) =>
        [reviewer, process.env[name] === "true"])), cases: results, events,
      eventCount: events.length, modelRequests: modelRequests.length,
    }));
  } finally {
    if (session) await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
    session?.dispose();
    await new Promise((accept) => backend.close(accept));
    await rm(scratch, { recursive: true, force: true });
  }
}
