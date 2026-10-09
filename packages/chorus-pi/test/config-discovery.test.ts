import { expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePiMcpConfigPath, writePiMcpServer } from "../../../cli/init/pi-mcp-config.mjs";
import { chorusConfigPaths, chorusMcpBackend, resolveChorusConfigFromMcpJson } from "../lib/lib.ts";

const config = (url: unknown, authorization: unknown = "Bearer cho_file") => JSON.stringify({
  mcpServers: { chorus: { url, headers: { Authorization: authorization } } },
});

test("host paths keep native discovery and prefer legacy primary", () => {
  for (const version of ["0.84.4", "0.87.1"]) {
    expect(chorusConfigPaths("/project", "/agent", version, { existsSync: () => true })).toEqual([
      "/project/.mcp.json", "/agent/mcp-adapter.json",
    ]);
    expect(chorusConfigPaths("/project", "/agent", version, { existsSync: () => false })).toEqual([
      "/project/.mcp.json", "/agent/mcp.json",
    ]);
  }
  for (const version of ["0.99.0", "1.0.2", "unknown"]) {
    expect(chorusConfigPaths("/project", "/agent", version, { existsSync: () => true })).toEqual([
      "/project/.mcp.json", "/agent/mcp.json",
    ]);
  }
});

test("active adapter on modern Pi overrides version routing without changing native precedence", () => {
  const native = { name: "mcp", sourceInfo: { path: "builtin:mcp" } };
  expect(chorusMcpBackend([native])).toBe("native");
  expect(chorusMcpBackend([native, { name: "mcp-adapter" }])).toBe("adapter");
  expect(chorusMcpBackend([{ name: "mcp-adapter:2" }])).toBe("adapter");
  expect(chorusMcpBackend([{ name: "mcp-adapter-unrelated" }])).toBeUndefined();
  expect(chorusMcpBackend([])).toBeUndefined();
  const files: Record<string, string> = {
    "/agent/mcp.json": config("https://native", "Bearer cho_native"),
    "/agent/mcp-adapter.json": config("https://adapter", "Bearer cho_adapter"),
  };
  const fs = { existsSync: (path: string) => path in files };
  const resolve = (backend: "native" | "adapter", env: Record<string, string> = {}) => resolveChorusConfigFromMcpJson(
    chorusConfigPaths("/project", "/agent", "1.1.0", fs, backend), fs, (path) => files[path], env,
  );
  expect(resolve("adapter")).toEqual({ url: "https://adapter", apiKey: "cho_adapter" });
  expect(resolve("native")).toEqual({ url: "https://native", apiKey: "cho_native" });
  expect(resolve("adapter", { CHORUS_URL: "https://env", CHORUS_API_KEY: "cho_env" }))
    .toEqual({ url: "https://env", apiKey: "cho_env" });
  files["/project/.pi/mcp-adapter.json"] = config("https://project-adapter");
  files["/project/.mcp.json"] = config("https://project-shared");
  expect(resolve("adapter").url).toBe("https://project-adapter");
  expect(resolve("native").url).toBe("https://project-shared");
  delete files["/project/.pi/mcp-adapter.json"];
  delete files["/project/.mcp.json"];
  files["/agent/mcp-adapter.json"] = "{";
  expect(resolve("adapter")).toEqual({ url: "", apiKey: "" });
});

test("malformed, partial and unreadable candidates safely fall through without mixing credentials", () => {
  const files = ["{", "null", "[]", config(42), config("https://partial", null),
    config(null), config("https://template", "Bearer ${MISSING}"),
    config("${MISSING}", "Bearer cho_literal"), config("https://valid")];
  const paths = ["denied", ...files.map((_, index) => String(index))];
  expect(resolveChorusConfigFromMcpJson(paths, { existsSync: () => true }, (path) => {
    if (path === "denied") throw new Error("EACCES");
    return files[Number(path)];
  })).toEqual({ url: "https://valid", apiKey: "cho_file" });
  expect(resolveChorusConfigFromMcpJson(["denied"], { existsSync: () => { throw new Error("EACCES"); } },
    () => "")).toEqual({ url: "", apiKey: "" });
});

test("environment references resolve safely and field overrides complete a partial candidate", () => {
  const resolve = (raw: string, env: Record<string, string | undefined>) => resolveChorusConfigFromMcpJson(
    ["config"], { existsSync: () => true }, () => raw, env,
  );
  expect(resolve(config("https://file", "Bearer ${CHORUS_API_KEY}"), {})).toEqual({ url: "", apiKey: "" });
  expect(resolve(config("https://file", "Bearer ${env:TOKEN}"), { TOKEN: "cho_resolved" }))
    .toEqual({ url: "https://file", apiKey: "cho_resolved" });
  expect(resolve(config("https://file", "Bearer ${TOKEN}"), { TOKEN: "${NESTED}" }))
    .toEqual({ url: "", apiKey: "" });
  expect(resolve(config("https://file", null), { CHORUS_API_KEY: "cho_env" }))
    .toEqual({ url: "https://file", apiKey: "cho_env" });
  expect(resolve(config(null), { CHORUS_URL: "https://env" }))
    .toEqual({ url: "https://env", apiKey: "cho_file" });
  expect(resolve(config("https://file"), { CHORUS_URL: "https://env", CHORUS_API_KEY: "${MISSING}" }))
    .toEqual({ url: "https://env", apiKey: "cho_file" });
  expect(resolveChorusConfigFromMcpJson(["unread"], { existsSync: () => { throw new Error("must not read"); } },
    () => "", { CHORUS_URL: "https://env", CHORUS_API_KEY: "cho_env" }))
    .toEqual({ url: "https://env", apiKey: "cho_env" });
});

test("template bindings must be own nonempty environment strings", () => {
  for (const name of ["toString", "constructor", "__proto__"]) {
    const raw = config("https://file", `Bearer \${${name}}`);
    const resolve = (env: Record<string, string | undefined>) => resolveChorusConfigFromMcpJson(
      ["config"], { existsSync: () => true }, () => raw, env,
    );
    expect(resolve({})).toEqual({ url: "", apiKey: "" });
    for (const value of [undefined, "", 123, {}, () => "not an env string"]) {
      const env = Object.fromEntries([[name, value]]) as Record<string, string | undefined>;
      expect(resolve(env)).toEqual({ url: "", apiKey: "" });
    }
    expect(resolve(Object.fromEntries([[name, "cho_own"]]))).toEqual({ url: "https://file", apiKey: "cho_own" });
  }
});

test("legacy primary is authoritative when malformed, partial or unreadable; project and env remain usable", () => {
  for (const primary of ["{", "null", config(null), config("https://partial", null), "unreadable"]) {
    const files: Record<string, string> = {
      "/agent/mcp-adapter.json": primary,
      "/agent/mcp.json": config("https://stale"),
    };
    const fs = { existsSync: (path: string) => path in files };
    const read = (path: string) => {
      if (files[path] === "unreadable") throw new Error("EACCES");
      return files[path];
    };
    const paths = chorusConfigPaths("/project", "/agent", "0.84.4", fs);
    expect(resolveChorusConfigFromMcpJson(paths, fs, read)).toEqual({ url: "", apiKey: "" });
    expect(resolveChorusConfigFromMcpJson(paths, fs, read,
      { CHORUS_URL: "https://env", CHORUS_API_KEY: "cho_env" })).toEqual({ url: "https://env", apiKey: "cho_env" });
    files["/project/.mcp.json"] = config("https://project");
    expect(resolveChorusConfigFromMcpJson(paths, fs, read)).toEqual({ url: "https://project", apiKey: "cho_file" });
  }
  const fs = { existsSync: (path: string) => path.endsWith("/mcp.json") };
  expect(resolveChorusConfigFromMcpJson(chorusConfigPaths("/project", "/agent", "0.84.4", fs), fs,
    () => config("https://retained"))).toEqual({ url: "https://retained", apiKey: "cho_file" });
  expect(chorusConfigPaths("/project", "/agent", "0.84.4", { existsSync: () => { throw new Error("EACCES"); } }))
    .toEqual(["/project/.mcp.json", "/agent/mcp-adapter.json"]);
});

for (const version of ["0.84.4", "0.87.1", "0.99.0", "1.0.2"]) {
  for (const custom of [false, true]) {
    for (const retained of [false, true]) {
      test.each(version === "0.84.4" && custom && retained
        ? ["generated", "missing-key", "template-key", "prototype-key-toString", "prototype-key-constructor", "prototype-key-__proto__", "prototype-config-toString", "prototype-config-constructor", "prototype-config-__proto__", "malformed", "partial", "env-override"] : ["generated"])(
        `writer -> extension: ${version}, custom=${custom}, retained=${retained}, %s`, async (variant) => {
        const scratch = mkdtempSync(join(tmpdir(), "chorus-discovery-"));
        const savedEnv = { ...process.env };
        const savedCwd = process.cwd();
        const savedFetch = globalThis.fetch;
        const calls: string[] = [];
        const messages: string[] = [];
        const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<unknown>> = {};
        try {
          for (const name of Object.keys(process.env)) {
            if (name.startsWith("CHORUS_") || name === "PI_CODING_AGENT_DIR") delete process.env[name];
          }
          process.env.HOME = join(scratch, "home");
          if (custom) process.env.PI_CODING_AGENT_DIR = join(scratch, "custom-agent");
          Object.assign(process.env, { CHORUS_API_KEY: "cho_env", CHORUS_AGENT_PROFILE: "fixture",
            CHORUS_SPEC_MODE: "off" });
          process.chdir(scratch);
          const agentDir = custom ? process.env.PI_CODING_AGENT_DIR! : join(process.env.HOME, ".pi/agent");
          const legacy = version.startsWith("0.8");
          const backend = { mode: legacy ? "legacy" : "native", supported: true };
          const configPath = resolvePiMcpConfigPath(process.env, backend);
          const stalePath = join(agentDir, legacy ? "mcp.json" : "mcp-adapter.json");
          mkdirSync(agentDir, { recursive: true });
          if (retained) writeFileSync(stalePath, config("https://stale.invalid/api/mcp", "Bearer cho_stale"));
          writePiMcpServer({ configPath, url: "https://generated.invalid", backend });
          expect(readFileSync(configPath, "utf8")).toContain("${CHORUS_API_KEY}");
          if (variant === "missing-key") delete process.env.CHORUS_API_KEY;
          if (variant === "template-key") process.env.CHORUS_API_KEY = "${MISSING}";
          if (variant.startsWith("prototype-key-")) {
            const name = variant.slice("prototype-key-".length);
            delete process.env[name];
            process.env.CHORUS_API_KEY = `\${${name}}`;
          }
          if (variant.startsWith("prototype-config-")) {
            const name = variant.slice("prototype-config-".length);
            delete process.env[name];
            delete process.env.CHORUS_API_KEY;
            writeFileSync(configPath, config("https://generated.invalid/api/mcp", `Bearer \${${name}}`));
          }
          if (variant === "malformed" || variant === "env-override") writeFileSync(configPath, "{");
          if (variant === "partial") writeFileSync(configPath, "{}");
          if (variant === "env-override") process.env.CHORUS_URL = "https://override.invalid/api/mcp";
          const configured = variant === "generated" || variant === "env-override";
          const generated = readFileSync(configPath, "utf8");
          const stale = retained ? readFileSync(stalePath, "utf8") : null;
          expect(generated).not.toContain("cho_env");
          mock.module("@earendil-works/pi-coding-agent", () => ({ VERSION: version, getAgentDir: () => agentDir }));
          globalThis.fetch = (async (url: unknown, init: RequestInit) => {
            expect(configured).toBe(true);
            expect(String(url)).toBe(variant === "env-override" ? "https://override.invalid/api/mcp" : "https://generated.invalid/api/mcp");
            expect(new Headers(init.headers).get("Authorization")).toBe("Bearer cho_env");
            const rpc = JSON.parse(String(init.body));
            if (rpc.method === "tools/call") calls.push(rpc.params.name);
            const data = rpc.params?.name === "chorus_create_session" ? { uuid: "fixture-session" } : {};
            return new Response(JSON.stringify({ jsonrpc: "2.0", id: rpc.id,
              result: { content: [{ type: "text", text: JSON.stringify(data) }] } }),
            { headers: { "content-type": "application/json" } });
          }) as typeof fetch;
          const extension = await import(`../extensions/chorus.ts?discovery=${version}-${custom}-${retained}-${variant}`);
          extension.default({
            on: (name: string, handler: typeof handlers[string]) => { handlers[name] = handler; },
            events: { on: () => {} }, sendUserMessage: (message: string) => messages.push(message),
          });
          const ctx = { cwd: scratch, ui: { notify: () => {} } };
          await handlers.session_start({}, ctx);
          expect(calls).toEqual(configured ? ["chorus_checkin"] : []);
          const input = { agent: "chorus-worker", task: "test writer discovery" };
          await handlers.tool_call({ toolName: "subagent", toolCallId: "worker", input }, ctx);
          if (configured) expect(input.task).toContain("Session UUID: fixture-session");
          else expect(input.task).toBe("test writer discovery");
          await handlers.tool_result({ toolName: "subagent", toolCallId: "worker", input, content: [], isError: false }, ctx);
          for (const operation of ["chorus_pm_submit_proposal", "chorus_submit_for_verify", "chorus_admin_verify_task"]) {
            await handlers.tool_result({ toolName: `${legacy ? "chorus_" : "mcp__chorus__"}${operation}`,
              toolCallId: operation, input: {}, content: [], isError: false }, ctx);
          }
          expect(messages).toHaveLength(configured ? 3 : 0);
          for (const reviewer of configured ? ["proposal", "task", "code"] : []) {
            expect(messages.some((message) => message.includes(`chorus-${reviewer}-reviewer`))).toBe(true);
          }
          await handlers.session_shutdown({}, ctx);
          expect(calls).toEqual(configured ? ["chorus_checkin", "chorus_create_session", "chorus_close_session"] : []);
          expect(readFileSync(configPath, "utf8")).toBe(generated);
          if (retained) expect(readFileSync(stalePath, "utf8")).toBe(stale);
          else expect(existsSync(stalePath)).toBe(false);
        } finally {
          mock.restore();
          globalThis.fetch = savedFetch;
          process.chdir(savedCwd);
          for (const name of Object.keys(process.env)) if (!(name in savedEnv)) delete process.env[name];
          Object.assign(process.env, savedEnv);
          rmSync(scratch, { recursive: true, force: true });
        }
      });
    }
  }
}
