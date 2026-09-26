// Run: node --test plugins/chorus/tests/research-distribution.test.mjs
// Exercise real discovery/packaging paths without invoking hosts or the network.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { installFileTemplate } from "../../../cli/init/file-template.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const exec = promisify(execFile);
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const surfaces = [
  ["public/chorus-plugin/skills", "research", "", ""],
  ["plugins/chorus/skills", "research", "", ""],
  ["packages/openclaw-plugin/skills", "research", "", ""],
  ["public/kiro-plugin/.kiro/skills", "chorus-research", "chorus-", ""],
  ["packages/chorus-pi/skills", "research", "", ""],
  ["packages/chorus-dsh/skills", "research-chorus", "", "-chorus"],
  ["public/skill", "research-chorus", "", "-chorus"],
];

for (const [directory, name, prefix, suffix] of surfaces) {
  test(`${directory}: stage links resolve to the discovered research skill`, async () => {
    const skills = join(root, directory);
    const entries = await readdir(skills);
    assert.ok(entries.includes(name), `${name} missing from skill directory`);
    const target = join(skills, name, "SKILL.md");
    const text = await readFile(target, "utf8");
    assert.equal(text.match(/^name:\s*(\S+)$/m)?.[1], name);
    for (const stage of ["idea", "proposal", "brainstorm", "yolo"]) {
      const caller = join(skills, `${prefix}${stage}${suffix}`, "SKILL.md");
      const links = [...(await readFile(caller, "utf8")).matchAll(/\]\(([^)]+)\)/g)];
      assert.ok(
        links.some(([, link]) => resolve(dirname(caller), link) === target),
        `${caller} has no resolvable research route`,
      );
    }
  });
}

test("Codex manifest and Claude convention expose the research directory", async () => {
  const codex = join(root, "plugins/chorus");
  const manifest = await json(join(codex, ".codex-plugin/plugin.json"));
  assert.equal(
    await readFile(join(codex, manifest.skills, "research/SKILL.md"), "utf8"),
    await readFile(join(codex, "skills/research/SKILL.md"), "utf8"),
  );
  // Claude discovers skills/<name>/SKILL.md relative to its plugin root.
  const claude = join(root, "public/chorus-plugin");
  assert.equal((await json(join(claude, ".claude-plugin/plugin.json"))).name, "chorus");
  assert.ok((await readdir(join(claude, "skills"))).includes("research"));
});

test("Kiro installs the real manifest assets and exposes research to its main agent", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "chorus-research-kiro-"));
  try {
    const kiroDir = join(temporary, ".kiro");
    await installFileTemplate({
      chorusUrl: "https://chorus.invalid",
      kiroDir,
      fetchImpl: async (url) => {
        const pathname = new URL(url).pathname;
        assert.ok(pathname.startsWith("/kiro-plugin/"));
        return new Response(await readFile(join(root, "public", pathname), "utf8"));
      },
    });
    const installed = join(kiroDir, "skills/chorus-research/SKILL.md");
    assert.equal(
      await readFile(installed, "utf8"),
      await readFile(join(root, "public/kiro-plugin/.kiro/skills/chorus-research/SKILL.md"), "utf8"),
    );
    const agent = await json(join(kiroDir, "agents/chorus.json"));
    assert.ok(agent.resources.includes("skill://.kiro/skills/chorus-research/SKILL.md"));
    for (const stage of ["idea", "proposal"]) {
      const caller = join(kiroDir, "skills", `chorus-${stage}`, "SKILL.md");
      const links = [...(await readFile(caller, "utf8")).matchAll(/\]\(([^)]+)\)/g)];
      assert.ok(links.some(([, link]) => resolve(dirname(caller), link) === installed));
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("standalone file map resolves research and both callers to their static assets", async () => {
  const manifest = await json(join(root, "public/skill/package.json"));
  for (const name of ["research-chorus", "idea-chorus", "proposal-chorus"]) {
    const path = `${name}/SKILL.md`;
    const url = manifest.chorus.files[path];
    assert.equal(url, `/skill/${path}`);
    // This is the static file a manifest-driven client would download.
    const downloaded = await readFile(join(root, "public", url), "utf8");
    assert.equal(downloaded, await readFile(join(root, "public/skill", path), "utf8"));
  }
});

for (const [packageName, skillName] of [
  ["openclaw-plugin", "research"],
  ["chorus-pi", "research"],
  ["chorus-dsh", "research-chorus"],
]) {
  test(`${packageName}: npm pack includes research and both stage callers`, async () => {
    const cwd = join(root, "packages", packageName);
    const { stdout } = await exec("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
      cwd,
      maxBuffer: 4 * 1024 * 1024,
    });
    const packed = new Set(JSON.parse(stdout)[0].files.map((file) => file.path));
    for (const name of [skillName, skillName.replace("research", "idea"), skillName.replace("research", "proposal")]) {
      assert.ok(packed.has(`skills/${name}/SKILL.md`), `${name} is absent from npm package`);
    }
    if (packageName === "openclaw-plugin") {
      assert.deepEqual((await json(join(cwd, "openclaw.plugin.json"))).skills, ["./skills"]);
    } else if (packageName === "chorus-pi") {
      assert.deepEqual((await json(join(cwd, "package.json"))).pi.skills, ["./skills"]);
    }
  });
}
