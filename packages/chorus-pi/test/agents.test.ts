import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

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
