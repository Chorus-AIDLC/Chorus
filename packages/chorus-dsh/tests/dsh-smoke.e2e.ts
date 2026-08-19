import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterAll, beforeAll, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import {
  boot,
  healProfilesModuleFallback,
  loadProfile,
} from "@deepseek-ai/dsh-app-boot";
import { provideCmdline } from "@deepseek-ai/dsh-cmdline";
import { SessionId } from "@deepseek-ai/dsh-session";
import type { PatchOptions } from "@deepseek-ai/cordis-plugin-include";
import type {} from "@deepseek-ai/dsh-agent-presets";
import type {} from "@deepseek-ai/dsh-skill";
import type {} from "@deepseek-ai/dsh-tools";

const repoRoot = join(import.meta.dirname, "../../..");
const installAnchor = join(repoRoot, "apps/cli/package.json");
const home = process.env.CHORUS_DSH_SMOKE_HOME;
if (!home) throw new Error("CHORUS_DSH_SMOKE_HOME is required");

const profileDir = join(home, "profiles/web");
const expectedSkills = [
  "brainstorm-chorus",
  "chorus",
  "code-reviewer-chorus",
  "develop-chorus",
  "docs-chorus",
  "idea-chorus",
  "openspec-aware-chorus",
  "orchestrate-chorus",
  "proposal-chorus",
  "proposal-reviewer-chorus",
  "quick-dev-chorus",
  "review-chorus",
  "task-reviewer-chorus",
  "yolo-chorus",
];
const peerNames = [
  "@deepseek-ai/dsh-mcp-client",
  "@deepseek-ai/dsh-persona",
  "@deepseek-ai/dsh-skill-filesystem",
  "@deepseek-ai/dsh-tool-skill",
];

let ctx: Context;

beforeAll(async () => {
  healProfilesModuleFallback(installAnchor, home);
  const profile = loadProfile("dsh", "web", installAnchor, home);
  const patches: PatchOptions[] = [
    ...profile.layers.flatMap((layer) => layer.patches),
    ...profile.patches,
    { id: "webserver", disabled: true },
    { id: "web-runtime", disabled: true },
    { id: "session-telemetry-otel", disabled: true },
    { id: "modules", disabled: true },
    { id: "connection", disabled: true },
    { id: "client-hmr", disabled: true },
    { id: "directory-picker", disabled: true },
    {
      id: "agent-presets",
      config: {
        default: "standard",
        roots: [
          {
            path: join(repoRoot, "apps/cli/config/agent-presets"),
            trust: "system",
          },
        ],
        includeUserRoot: false,
      },
    },
    {
      insert: [
        {
          id: "directory-picker-browse",
          name: "@deepseek-ai/dsh-host-directory-picker-browse",
        },
        {
          id: "ui-directory-picker-browse",
          name: "@deepseek-ai/dsh-client-ui-directory-picker-browse",
        },
      ],
    },
  ];
  ctx = await boot("chorus-dsh-smoke", join(profileDir, "cordis.yml"), patches, (bootCtx) => {
    provideCmdline(bootCtx, { args: [], exit: () => {} });
  });
}, 120_000);

afterAll(async () => {
  await ctx?.fiber.dispose();
});

it("installs as a profile bundle with all four peers resolvable", async () => {
  const manifest = JSON.parse(
    await readFile(join(profileDir, "package.json"), "utf8"),
  ) as {
    dependencies: Record<string, string>;
    dsh: { profile: { bundles: string[] } };
  };
  expect(manifest.dependencies["@chorus-aidlc/chorus-dsh"]).toBeTruthy();
  expect(manifest.dsh.profile.bundles.at(-1)).toBe(
    "@chorus-aidlc/chorus-dsh",
  );

  const require = createRequire(join(profileDir, "package.json"));
  for (const peer of peerNames) {
    expect(require.resolve(peer)).toBeTruthy();
  }
});

it("loads package-local skills and inline Chorus prompt behavior", async () => {
  const handle = await ctx.agents.create({
    sessionId: SessionId("chorus-dsh-smoke"),
    meta: { cwd: repoRoot },
    setup: (agentCtx) =>
      ctx.agentPresets.mount(agentCtx, "standard").then(() => undefined),
  });
  try {
    const catalog = (
      await ctx.skills.list({ cwd: repoRoot, scope: handle.agent })
    ).map((skill) => skill.name);
    expect(catalog).toEqual(expect.arrayContaining(expectedSkills));
    expect(ctx.tools.schemas(handle.agent).map((tool) => tool.name)).toContain(
      "skill",
    );

    for (const name of ["chorus", "develop-chorus"]) {
      const loaded = await ctx.skills.get(name, {
        cwd: repoRoot,
        scope: handle.agent,
      });
      expect(loaded?.content).toContain("Chorus");
    }

    const assembly = await ctx.systemPrompt.assemble({ scope: handle.agent });
    expect(
      assembly.sections.find(
        (section) => section.name === "deployment:persona",
      )?.text,
    ).toContain("Chorus PM and developer agent");
  } finally {
    await handle.dispose();
  }
}, 120_000);

it("creates no copied Chorus home tree", async () => {
  const homeEntries = await readdir(home);
  expect(homeEntries).not.toContain("chorus");
  expect(homeEntries).not.toContain("skills");
  expect(homeEntries).not.toContain(".agent-presets");
});
