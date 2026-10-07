// Renders the prompt-parity fixtures through cli/prompts.mjs (the source of truth).
// Usage: node render_prompts.mjs <repoRoot> <fixtures.json>  -> JSON on stdout.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [repoRoot, fixturesPath] = process.argv.slice(2);
const prompts = await import(pathToFileURL(join(repoRoot, "cli", "prompts.mjs")).href);
const fixtures = JSON.parse(readFileSync(fixturesPath, "utf8"));

function render(fn) {
  try {
    return { ok: fn() };
  } catch (err) {
    return { error: String(err && err.message ? err.message : err) };
  }
}

const out = {
  wakeActions: [...prompts.WAKE_ACTIONS].sort(),
  single: fixtures.single.map((f) => ({ name: f.name, ...render(() => prompts.buildPrompt(f.notification)) })),
  batch: fixtures.batch.map((f) => ({ name: f.name, ...render(() => prompts.buildBatchPrompt(f.notifications)) })),
};
process.stdout.write(JSON.stringify(out));
