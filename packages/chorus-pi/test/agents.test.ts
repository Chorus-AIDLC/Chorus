import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { discoverAgents, expandReviewerTools } from "../extensions/subagent/agents.ts";
import { isRoleToolAllowed } from "../lib/role-policy.ts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mock, spyOn } from "bun:test";

const sdkDirectory = path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
for (const dependency of ["@earendil-works/pi-ai", "@earendil-works/pi-tui", "typebox"]) {
	const runtime = await import(Bun.resolveSync(dependency, sdkDirectory));
	mock.module(dependency, () => runtime);
}
const { default: subagentExtension } = await import("../extensions/subagent/index.ts");

// Regression for PR #572 (review round 3): the chorus-worker description was
// an UNQUOTED YAML scalar containing `tasks: [...]` — the `: ` inside the
// backticks made the runtime parser throw "Nested mappings are not allowed in
// compact mappings" BEFORE any agent could be chosen, because discoverAgents
// parses the whole bundled directory up front. One bad frontmatter therefore
// blocked every dispatch, reviewers included.
//
// These tests parse every shipped agents/*.md with the same runtime parser
// (parseFrontmatter) and apply the same acceptance checks loadAgentsFromDir
// does (name/description must be non-empty strings), so a file that fails to
// load is caught offline instead of at first dispatch.

type AgentFrontmatter = {
	name?: unknown;
	description?: unknown;
};

const AGENTS_DIR = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"agents",
);

const files = fs
	.readdirSync(AGENTS_DIR)
	.filter((n) => n.endsWith(".md"))
	.sort();

test("bundled agents dir is non-empty (regression target exists)", () => {
	expect(files.length).toBeGreaterThan(0);
});

for (const file of files) {
	test(`frontmatter parses with the runtime parser and loads: ${file}`, () => {
		const content = fs.readFileSync(path.join(AGENTS_DIR, file), "utf-8");
		// Throws (as chorus-worker.md did) → test fails with the parser message.
		const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content);
		// Same acceptance line loadAgentsFromDir applies before pushing an agent.
		expect(typeof frontmatter.name).toBe("string");
		expect(typeof frontmatter.description).toBe("string");
		expect(frontmatter.name as string).toBe(file.replace(/\.md$/, ""));
		expect((frontmatter.description as string).length).toBeGreaterThan(0);
		expect(body.trim().length).toBeGreaterThan(0);
	});
}

test("Pi 1 reviewer allowlist includes discovered native reads and comments, excluding mutations", () => {
	const declared = ["read", "bash", "codemode", "tool_search", "mcp"];
	const available = [
		"read", "write", "edit",
		"mcp__chorus__chorus_get_task",
		"mcp__other__chorus_get_document",
		"mcp__chorus__chorus_list_tasks",
		"mcp__chorus__chorus_list_projects",
		"mcp__chorus__chorus_checkin",
		"mcp__chorus__chorus_search",
		"mcp__chorus__chorus_query_relations",
		"mcp__chorus__chorus_add_comment",
		"mcp__chorus__chorus_update_task",
		"mcp__chorus__chorus_admin_verify_task",
		"mcp__chorus__chorus_submit_for_verify",
		"mcp__chorus__chorus_list_tasks_extra",
		"mcp__chorus__chorus_list_admin_keys",
		"mcp__chorus__delete_file",
		"other_get_task",
		"mcp__chorus__chorus_get_task",
	];
	for (const role of ["proposal", "task", "code"]) {
		const result = expandReviewerTools(`chorus-${role}-reviewer`, declared, available)!;
		expect(result).toEqual([...declared.slice(0, 2), ...available.slice(3, 9), available[10]]);
		expect(declared).toEqual(["read", "bash", "codemode", "tool_search", "mcp"]);
	}
});

test("every bundled reviewer can call its prescribed Chorus operations", () => {
	for (const file of files.filter((name) => name.endsWith("-reviewer.md"))) {
		const content = fs.readFileSync(path.join(AGENTS_DIR, file), "utf-8");
		const { frontmatter } = parseFrontmatter<{ name: string; tools: string }>(content);
		const required = [...new Set(content.split("\n")
			.filter((line) => line.startsWith("- chorus_"))
			.flatMap((line) => [...line.matchAll(/chorus_[a-z_]+(?=\()/g)].map((match) => match[0])))];
		expect(required.length).toBeGreaterThan(0);
		const nativeNames = required.map((name) => `mcp__chorus__${name}`);
		const tools = frontmatter.tools.split(",").map((tool) => tool.trim());
		const expanded = expandReviewerTools(frontmatter.name, tools, nativeNames)!;
		expect(expanded).toEqual(tools);
		for (const name of required) expect(isRoleToolAllowed("reviewer", name)).toBe(true);
	}
});

test("legacy native reviewers retain only an available restricted codemode entrypoint", () => {
	const declared = ["read", "bash", "codemode", "tool_search", "mcp", "mcpScript"];
	const native = ["codemode", "mcp__chorus__chorus_get_task", "mcp__chorus__chorus_admin_verify_task"];
	expect(expandReviewerTools("chorus-task-reviewer", declared, native)).toEqual([
		"read", "bash", "mcp__chorus__chorus_get_task", "codemode",
	]);
	expect(expandReviewerTools("chorus-task-reviewer", declared, native.slice(1))).not.toContain("codemode");
	expect(expandReviewerTools("chorus-task-reviewer", declared, [...native, "chorus_get_task"])).not.toContain("codemode");
});

test("packaged role tools have explicit providers and never expand ambient tools", async () => {
	for (const file of files) {
		const { frontmatter } = parseFrontmatter<{ name: string; tools: string; subagentOnlyExtensions: string }>(
			fs.readFileSync(path.join(AGENTS_DIR, file), "utf-8"),
		);
		const worker = frontmatter.name === "chorus-worker";
		const roleTool = worker ? "chorus_work" : "chorus_review";
		const expected = ["read", "grep", "find", "ls", "bash", ...(worker ? ["edit", "write"] : []), roleTool];
		const tools = frontmatter.tools.split(",").map((tool) => tool.trim());
		expect(tools).toEqual(expected);
		expect(frontmatter.subagentOnlyExtensions).toBe(`../lib/child-${worker ? "work" : "review"}.ts`);
		const providerPath = path.resolve(AGENTS_DIR, frontmatter.subagentOnlyExtensions);
		const { default: provider } = await import(providerPath);
		const registered: string[] = [];
		provider({ registerTool: (tool: { name: string }) => registered.push(tool.name) });
		expect(registered).toEqual([roleTool]);
		for (const available of [[], ["mcp__chorus__chorus_get_task", "chorus_chorus_add_comment", "mcp", "chorus_work"]]) {
			expect(expandReviewerTools(frontmatter.name, tools, available)).toEqual(expected);
		}
	}
});

test("implementation reviewers allow incidental verification outputs without source edits", () => {
	for (const role of ["task", "code"]) {
		const content = fs.readFileSync(path.join(AGENTS_DIR, `chorus-${role}-reviewer.md`), "utf-8");
		expect(content).toContain("incidental test/build outputs are allowed");
		expect(content).toContain("Do not deliberately create, modify, or delete project source, tests, configuration, or documentation.");
		expect(content).toContain("no source-rewriting or autofix modes");
		expect(content).not.toContain("no file writes");
		expect(content).not.toContain("Creating, modifying, or deleting any files IN THE PROJECT DIRECTORY");
	}
});

test("legacy declared reviewer mutations and obsolete operations are filtered by the shared policy", () => {
	const tools = ["read", "chorus_work", "chorus_chorus_update_task", "mcp__chorus__chorus_admin_verify_task",
		"chorus_query_relations", "chorus_get_new_query", "chorus_list_projects"];
	expect(expandReviewerTools("chorus-task-reviewer", tools, tools)).toEqual([
		"read", "chorus_get_new_query", "chorus_list_projects",
	]);
});

test("Pi 1 worker inheritance and custom agents keep their declared tools", () => {
	const available = ["mcp__chorus__chorus_add_comment"];
	expect(expandReviewerTools("chorus-worker", undefined, available)).toBeUndefined();
	expect(expandReviewerTools("custom", ["codemode"], available)).toEqual(["codemode"]);
	expect(expandReviewerTools("chorus-task-reviewer", ["read", "mcp"], available)).toEqual(["read", ...available]);
});

test("legacy reviewer direct tools exclude unrestricted gateways and business mutations", () => {
	const declared = ["read", "bash", "codemode", "tool_search", "mcp", "mcpScript"];
	const available = [
		"chorus_chorus_get_task", "chorus_chorus_add_comment", "chorus_list_tasks",
		"chorus_checkin", "chorus_chorus_submit_for_verify", "chorus_admin_verify_task",
		"chorus_list_admin_keys", "unrelated_get_task", "mcp", "mcpScript",
	];
	for (const role of ["proposal", "task", "code"]) {
		const expanded = expandReviewerTools(`chorus-${role}-reviewer`, declared, available)!;
		expect(expanded).toEqual([...declared.slice(0, 2), ...available.slice(0, 4)]);
	}
	expect(expandReviewerTools("chorus-worker", declared, available)).toEqual(declared);
	expect(expandReviewerTools("custom", declared, available)).toEqual(declared);
});

test("reviewer discovery failure does not retain unrestricted gateways", () => {
	const declared = ["read", "bash", "mcp", "mcpScript", "codemode", "tool_search"];
	for (const available of [[], ["read", "mcp", "mcpScript", "tool_search"]]) {
		expect(expandReviewerTools("chorus-task-reviewer", declared, available)).toEqual(["read", "bash"]);
	}
	expect(expandReviewerTools("chorus-task-reviewer", undefined, [])).toEqual([]);
});

test("provider paths resolve against the winning agent file, preserving user and project overrides", () => {
	const directory = mkdtempSync(path.join(tmpdir(), "chorus-agent-paths-"));
	const previousDirectory = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = path.join(directory, "user");
	const userAgents = path.join(directory, "user", "agents");
	const project = path.join(directory, "project");
	const projectAgents = path.join(project, CONFIG_DIR_NAME, "agents");
	mkdirSync(userAgents, { recursive: true });
	mkdirSync(projectAgents, { recursive: true });
	try {
		const bundled = discoverAgents(project, "user").agents;
		for (const agent of bundled) {
			expect(agent.subagentOnlyExtensions).toEqual([
				path.resolve(AGENTS_DIR, `../lib/child-${agent.name === "chorus-worker" ? "work" : "review"}.ts`),
			]);
		}
		const userFile = path.join(userAgents, "chorus-task-reviewer.md");
		writeFileSync(userFile, "---\nname: chorus-task-reviewer\ndescription: User override\ntools: [read, chorus_review]\nsubagentOnlyExtensions: [../providers/review.ts, /tmp/absolute-provider.ts]\n---\nUser review\n");
		const userAgent = discoverAgents(project, "both").agents.find((agent) => agent.name === "chorus-task-reviewer")!;
		expect(userAgent.filePath).toBe(userFile);
		expect(userAgent.tools).toEqual(["read", "chorus_review"]);
		expect(userAgent.subagentOnlyExtensions).toEqual([
			path.join(directory, "user/providers/review.ts"), "/tmp/absolute-provider.ts",
		]);
		const projectFile = path.join(projectAgents, "chorus-task-reviewer.md");
		writeFileSync(projectFile, "---\nname: chorus-task-reviewer\ndescription: Project override\ntools: read, chorus_review\nsubagentOnlyExtensions: ./review.ts, ../providers/extra.ts\n---\nProject review\n");
		const projectAgent = discoverAgents(project, "both").agents.find((agent) => agent.name === "chorus-task-reviewer")!;
		expect(projectAgent.filePath).toBe(projectFile);
		expect(projectAgent.subagentOnlyExtensions).toEqual([
			path.join(projectAgents, "review.ts"), path.resolve(projectAgents, "../providers/extra.ts"),
		]);
		writeFileSync(projectFile, "---\nname: chorus-task-reviewer\ndescription: No provider override\ntools: read\n---\nCustom review\n");
		expect(discoverAgents(project, "both").agents.find((agent) => agent.name === "chorus-task-reviewer")!.subagentOnlyExtensions).toBeUndefined();
	} finally {
		if (previousDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDirectory;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("actual dispatcher launches each role provider separately from the tool allowlist", async () => {
	const directory = mkdtempSync(path.join(tmpdir(), "chorus-child-launch-"));
	const previousDirectory = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	let registered: { execute: (...args: unknown[]) => Promise<{ isError?: boolean }> } | undefined;
	const calls: string[][] = [];
	const spawn = spyOn(childProcess, "spawn").mockImplementation((_command, args) => {
		calls.push(args as string[]);
		const process = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
		queueMicrotask(() => process.emit("close", 0));
		return process as ReturnType<typeof childProcess.spawn>;
	});
	try {
		subagentExtension({
			registerTool: (tool: unknown) => { registered = tool; },
			getAllTools: () => [{ name: "mcp__chorus__chorus_get_task" }, { name: "mcp" }],
			getThinkingLevel: () => "off",
		} as unknown as Parameters<typeof subagentExtension>[0]);
		for (const file of files) {
			const agent = file.replace(/\.md$/, "");
			const worker = agent === "chorus-worker";
			const result = await registered!.execute("role-launch", {
				agent, task: "Local launch fixture", async: false,
			}, undefined, undefined, { cwd: directory, hasUI: false });
			expect(result.isError).not.toBe(true);
			const args = calls.at(-1)!;
			expect(args[args.indexOf("-e") + 1]).toBe(path.resolve(AGENTS_DIR, `../lib/child-${worker ? "work" : "review"}.ts`));
			expect(args[args.indexOf("--tools") + 1].split(",")).toEqual([
				"read", "grep", "find", "ls", "bash", ...(worker ? ["edit", "write"] : []), worker ? "chorus_work" : "chorus_review",
			]);
		}
		expect(calls).toHaveLength(4);
	} finally {
		spawn.mockRestore();
		if (previousDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDirectory;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("actual dispatcher refuses an empty reviewer allowlist instead of spawning with inherited tools", async () => {
	const directory = mkdtempSync(path.join(tmpdir(), "chorus-reviewer-permissions-"));
	const previousDirectory = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	mkdirSync(path.join(directory, "agents"));
	let registered: { execute: (...args: unknown[]) => Promise<{ isError?: boolean }> } | undefined;
	const spawn = spyOn(childProcess, "spawn").mockImplementation(() => {
		throw new Error("Unexpected subprocess with empty reviewer permissions");
	});
	try {
		subagentExtension({
			registerTool: (tool: unknown) => { registered = tool; },
			getAllTools: () => [],
			getThinkingLevel: () => "off",
		} as unknown as Parameters<typeof subagentExtension>[0]);
		for (const permissions of ["tools: mcp, mcpScript, codemode, tool_search\n", ""]) {
			writeFileSync(path.join(directory, "agents/chorus-task-reviewer.md"),
				`---\nname: chorus-task-reviewer\ndescription: Local permission fixture\n${permissions}---\nReview only.\n`);
			const result = await registered!.execute("empty-reviewer", {
				agent: "chorus-task-reviewer", task: "No external operations", async: false,
			}, undefined, undefined, { cwd: directory, hasUI: false });
			expect(result.isError).toBe(true);
			expect(JSON.stringify(result)).toContain("refusing unrestricted tool inheritance");
		}
		expect(spawn).not.toHaveBeenCalled();
	} finally {
		spawn.mockRestore();
		if (previousDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDirectory;
		rmSync(directory, { recursive: true, force: true });
	}
});
