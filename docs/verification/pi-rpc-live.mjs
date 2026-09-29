#!/usr/bin/env node
// Live verification of the Pi daemon RPC transport (`pi --mode rpc`).
//
// Drives the PRODUCTION PiSpawner (and the real killProcessTree for the
// interrupt) against an installed `pi` CLI in a throwaway cwd, and writes a JSON
// evidence record.
//
//   node docs/verification/pi-rpc-live.mjs [--pi <path>] [--out <file.json>] [--with-chorus]
//
// Not part of the vitest suite (vitest only includes *.test.* under __tests__).
// It spends real model tokens with pi's configured default provider/model.
// CHORUS_* variables are dropped unless --with-chorus is passed, so by default the
// woken pi never talks to a Chorus server (the chorus-pi SessionStart check then
// reports whatever the extension does offline). The evidence contains no secrets
// and no absolute paths.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PiSpawner, PI_CONTINUITY_NOTICE, resolvePiPath } from "../../cli/pi-spawner.mjs";
import { killProcessTree } from "../../cli/process-killer.mjs";
import { extractTranscriptText } from "../../cli/upload-hooks.mjs";

function flag(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const withChorus = process.argv.includes("--with-chorus");
const env = { ...process.env };
if (!withChorus) for (const key of Object.keys(env)) if (/^CHORUS_/.test(key)) delete env[key];

const piPath = flag("--pi", resolvePiPath({ env }));
if (!piPath) {
  console.error("pi not found on PATH (use --pi <path>)");
  process.exit(2);
}
const piVersion = execFileSync(piPath, ["--version"], { env, encoding: "utf8" }).trim();

const root = mkdtempSync(join(tmpdir(), "chorus-pi-rpc-"));
const cwd = join(root, "cwd");
mkdirSync(cwd);
// A throwaway extension: one blocking dialog before each run and one slash command
// that pi handles without starting an agent run.
const extensionPath = join(root, "fixture-ext.ts");
writeFileSync(extensionPath, `export default function (pi) {
  pi.registerCommand("chorus-noop", { description: "noop", handler: async (_a, ctx) => { ctx.ui.notify("noop handled", "info"); } });
  pi.on("before_agent_start", async (_e, ctx) => { await ctx.ui.confirm("Fixture dialog", "Proceed?"); });
}
`);
const sessionsRoot = join(env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "sessions");

const redact = (s) => String(s).split(root).join("<tmp>").split(homedir()).join("~");

async function wake(prompt, { sessionId = randomUUID(), args, interruptOnTool = false } = {}) {
  const logs = [];
  const logger = {
    info: (m) => logs.push(`info ${redact(m)}`),
    warn: (m) => logs.push(`warn ${redact(m)}`),
    error: (m) => logs.push(`error ${redact(m)}`),
  };
  const spawner = new PiSpawner({ piPath, env, logger, cliConfig: args ? { args } : undefined });
  const texts = [];
  const types = [];
  let child;
  let killResult = null;
  let interrupt = null;
  const t0 = Date.now();
  const result = await spawner.wake({
    prompt, sessionId, isNew: true, cwd,
    onChild: (c) => { child = c; },
    onMessage: (o) => {
      types.push(o.type === "message_end" ? `message_end:${o.message?.role}${o.message?.customType ? `:${o.message.customType}` : ""}` : o.type);
      const t = extractTranscriptText(o);
      if (t) texts.push(t.text);
      if (interruptOnTool && o.type === "tool_execution_start" && !interrupt) {
        interrupt = new Promise((r) => setTimeout(async () => {
          killResult = await killProcessTree(child, { logger, sigintTimeoutMs: 10_000 });
          r();
        }, 1500));
      }
    },
  });
  await interrupt;
  return { sessionId, seconds: Number(((Date.now() - t0) / 1000).toFixed(1)), result, texts, types, killResult, logs };
}

const leftover = (pattern) => spawnSync("pgrep", ["-f", pattern], { encoding: "utf8" }).stdout.trim() !== "";
const findSessionFile = (sid) => {
  for (const dir of readdirSync(sessionsRoot)) {
    const hit = readdirSync(join(sessionsRoot, dir)).find((n) => n.endsWith(`_${sid}.jsonl`));
    if (hit) return join(sessionsRoot, dir, hit);
  }
  return null;
};

const runs = {};
const checks = {};
try {
  runs.newSession = await wake("Reply with exactly: LIVE-ALPHA");
  checks.newSessionExit0 = runs.newSession.result.exitCode === 0;
  checks.newSessionIsNew = runs.newSession.result.isNew === true;
  checks.newSessionReplyExtracted = runs.newSession.texts.includes("LIVE-ALPHA");
  checks.protocolFramesNotForwarded = !runs.newSession.types.includes("response") && !runs.newSession.types.includes("extension_ui_request");
  checks.settledForwardedLast = runs.newSession.types.at(-1) === "agent_settled";

  runs.resume = await wake("What exact word did you reply last time? Answer only that word.", { sessionId: runs.newSession.sessionId });
  checks.resumeIsNewFalse = runs.resume.result.isNew === false;
  checks.resumeRetainedContext = runs.resume.texts.some((t) => t.includes("LIVE-ALPHA"));

  const legacyId = randomUUID();
  const legacyOut = execFileSync(piPath, ["--mode", "json", "--session-id", legacyId, "-p"], {
    input: "Reply with exactly: LEGACY-JSON", cwd, env, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
  });
  runs.legacyResume = await wake("What exact word did you reply last time? Answer only that word.", { sessionId: legacyId });
  checks.legacyJsonSessionCreated = legacyOut.includes("LEGACY-JSON");
  checks.legacyJsonSessionResumed = runs.legacyResume.result.isNew === false && runs.legacyResume.texts.some((t) => t.includes("LEGACY-JSON"));

  runs.interrupt = await wake("Run exactly this bash command and nothing else: sleep 60 && echo done", { interruptOnTool: true });
  await new Promise((r) => setTimeout(r, 300));
  checks.interruptSentAbort = runs.interrupt.logs.some((l) => l.includes("sent pi abort"));
  checks.interruptNoEscalation = runs.interrupt.killResult?.escalated === false && runs.interrupt.killResult?.killed === true;
  checks.interruptCleanExit = runs.interrupt.result.exitCode === 0;
  checks.interruptNoLeftoverSleep = !leftover("^sleep 60");

  runs.dialog = await wake("Reply with exactly: DIALOG-OK", { args: ["--extension", extensionPath] });
  checks.dialogCancelledWithWarning = runs.dialog.logs.some((l) => l.includes("cancelled pi extension confirm dialog"));
  checks.dialogRunCompleted = runs.dialog.result.exitCode === 0 && runs.dialog.texts.includes("DIALOG-OK");

  runs.handled = await wake("/chorus-noop", { args: ["--extension", extensionPath] });
  checks.handledWithoutRunSettled = runs.handled.result.exitCode === 0 && runs.handled.logs.some((l) => l.includes("without an agent run"));

  runs.corruptSeed = await wake("Reply with exactly: SEED");
  const seedFile = findSessionFile(runs.corruptSeed.sessionId);
  if (seedFile) writeFileSync(seedFile, "garbage{{{\n");
  runs.corrupt = await wake("Reply with exactly: FRESH", { sessionId: runs.corruptSeed.sessionId });
  checks.lostHistoryWarned = runs.corrupt.logs.some((l) => l.includes("could not be restored"));
  checks.lostHistoryNoticeInTranscript = runs.corrupt.texts[0] === PI_CONTINUITY_NOTICE && runs.corrupt.texts.includes("FRESH");
  checks.lostHistoryIsNew = runs.corrupt.result.isNew === true;

  // Only meaningful when the chorus-pi extension can reach a Chorus server.
  if (withChorus) checks.chorusSessionStartContext = runs.newSession.types.includes("message_end:custom:chorus");
} finally {
  for (const dir of readdirSync(sessionsRoot)) {
    if (dir.includes("chorus-pi-rpc-")) rmSync(join(sessionsRoot, dir), { recursive: true, force: true });
  }
  rmSync(root, { recursive: true, force: true });
}

const evidence = {
  piVersion,
  platform: process.platform,
  withChorus,
  recordedAt: new Date().toISOString(),
  script: "docs/verification/pi-rpc-live.mjs",
  checks,
  runs,
};
const out = flag("--out", null);
if (out) writeFileSync(out, JSON.stringify(evidence, null, 2) + "\n");
console.log(JSON.stringify(checks, null, 2));
const failed = Object.entries(checks).filter(([, v]) => v !== true).map(([k]) => k);
if (failed.length) {
  console.error(`failed: ${failed.join(", ")}`);
  process.exit(1);
}
