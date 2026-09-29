#!/usr/bin/env node
// Live verification of the Claude daemon stream-json transport.
//
// Drives the PRODUCTION ClaudeSpawner (and the real killProcessTree for the
// interrupt) against an installed `claude` CLI, in a throwaway cwd with an
// isolated CLAUDE_CONFIG_DIR, and writes a JSON evidence record.
//
//   node docs/verification/claude-stream-json-live.mjs \
//     [--claude <path>] [--model haiku] [--out <file.json>]
//
// Not part of the vitest suite (vitest only includes *.test.* under __tests__).
// It spends real model tokens. The evidence contains no secrets and no absolute
// paths: argv and log lines are redacted before they are recorded.

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ClaudeSpawner, isNewSession, resolveClaudePath } from "../../cli/claude-spawner.mjs";
import { killProcessTree } from "../../cli/process-killer.mjs";

function flag(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const root = mkdtempSync(join(tmpdir(), "chorus-claude-stream-json-"));
const cwd = join(root, "cwd");
const configDir = join(root, "claude-config");
mkdirSync(cwd); mkdirSync(configDir);

// Inherit model-provider auth from the environment, but drop every Chorus and
// nested-Claude-session variable so the child never talks to a Chorus server or
// attaches to the calling session. Transcripts land in the isolated config dir.
const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir };
for (const key of Object.keys(env)) {
  if (/^CHORUS_/.test(key) || /^(CLAUDECODE|CLAUDE_PID|CLAUDE_CODE_(ENTRYPOINT|SESSION_ID|CHILD_SESSION|SESSION_ATTENDED|MESSAGING_.*|EXECPATH))$/.test(key)) delete env[key];
}

const claudePath = flag("--claude", resolveClaudePath({ env }));
if (!claudePath) throw new Error("claude not found on PATH");
const model = flag("--model", "haiku");
const claudeVersion = execFileSync(claudePath, ["--version"], { env, encoding: "utf8" }).trim().split(/\s+/)[0];
const out = flag("--out", join(import.meta.dirname, `claude-stream-json-live-${claudeVersion}.json`));

const redact = (s) => String(s).split(root).join("<tmp>").split(homedir()).join("<home>");

/**
 * One wake through the production spawner. A tapping spawnImpl records argv,
 * control frames (which the spawner deliberately does not forward) and what the
 * spawner wrote to stdin, without changing any behavior.
 */
async function wake({ sessionId, prompt, permissionMode = "chorus", onSpawn }) {
  const logs = [];
  const logger = {
    info: (m) => logs.push({ level: "info", msg: redact(m) }),
    warn: (m) => logs.push({ level: "warn", msg: redact(m) }),
    error: (m) => logs.push({ level: "error", msg: redact(m) }),
  };
  const tap = { argv: [], controlFrames: [], stdinWrites: [], stdinEnded: false };
  const spawnImpl = (command, argv, opts) => {
    tap.argv = argv.map(redact);
    const child = spawn(command, argv, opts);
    const write = child.stdin.write.bind(child.stdin);
    child.stdin.write = (chunk, ...rest) => {
      try {
        const frame = JSON.parse(String(chunk));
        tap.stdinWrites.push(frame.type === "user"
          ? { type: "user", contentIsPrompt: frame.message?.content === prompt }
          : { type: frame.type, subtype: frame.request?.subtype ?? frame.response?.subtype,
              behavior: frame.response?.response?.behavior, requestId: frame.request_id ?? frame.response?.request_id });
      } catch { tap.stdinWrites.push({ unparsed: true }); }
      return write(chunk, ...rest);
    };
    child.stdin.once("finish", () => { tap.stdinEnded = true; });
    let buf = "";
    child.stdout.on("data", (c) => {
      buf += String(c);
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        try {
          const f = JSON.parse(line);
          if (String(f.type).startsWith("control_")) {
            tap.controlFrames.push({ type: f.type, subtype: f.request?.subtype ?? f.response?.subtype,
              toolName: f.request?.tool_name, requestId: f.request_id ?? f.response?.request_id });
          }
        } catch { /* partial or non-JSON line; the spawner reports its own parse errors */ }
      }
    });
    onSpawn?.(child);
    return child;
  };
  const spawner = new ClaudeSpawner({ claudePath, spawnImpl, logger, permissionMode, env,
    cliConfig: { args: ["--model", model] } });
  // Mirror the daemon: the transcript probe (same env/platform as the spawner) decides new vs resume.
  const isNew = isNewSession(sessionId, cwd, { env: spawner.env, platform: spawner.platform });
  const forwarded = [];
  let init = null;
  let result = null;
  let stdinEndedWhenResultForwarded = null;
  const res = await spawner.wake({
    prompt, sessionId, isNew, cwd,
    onMessage: (m) => {
      forwarded.push(m.subtype ? `${m.type}:${m.subtype}` : m.type);
      if (m.type === "system" && m.subtype === "init") init = m;
      if (m.type === "result" && !result) {
        result = m;
        // handleFrame() runs before onMessage, so a closed stdin here means "closed on result".
        stdinEndedWhenResultForwarded = tap.childStdin?.writableEnded ?? null;
      }
    },
    onChild: (child) => { tap.childStdin = child.stdin; },
  });
  return {
    isNewProbe: isNew,
    wakeResult: { exitCode: res.exitCode, isNew: res.isNew, backendSessionIdIsAnchor: res.backendSessionId === sessionId },
    argv: tap.argv,
    initTools: init?.tools ?? null,
    initPermissionMode: init?.permissionMode ?? null,
    forwardedTypes: [...new Set(forwarded)],
    controlFramesForwarded: forwarded.filter((t) => t.startsWith("control_")).length,
    controlFramesSeenOnStdout: tap.controlFrames,
    stdinWrites: tap.stdinWrites,
    stdinClosedAtResult: stdinEndedWhenResultForwarded,
    stdinEnded: tap.stdinEnded,
    result: result && {
      subtype: result.subtype, isError: result.is_error, text: typeof result.result === "string" ? result.result.slice(0, 200) : null,
      permissionDenials: (result.permission_denials ?? []).map((d) => ({ toolName: d.tool_name })),
    },
    warnings: logs.filter((l) => l.level !== "info").map((l) => l.msg),
    infos: logs.filter((l) => l.level === "info").map((l) => l.msg),
  };
}

const scenarios = {};
const word = `PELICAN${Math.floor(Math.random() * 9000 + 1000)}`;

// 1. New session.
const anchor = randomUUID();
scenarios.newSession = await wake({
  sessionId: anchor,
  prompt: `For this conversation, the project tag is ${word}. Reply with exactly: OK`,
});

// 2. Resume the same anchor; context must be retained.
scenarios.resume = await wake({
  sessionId: anchor,
  prompt: "What project tag did I mention earlier in this conversation? Reply with only the tag.",
});
scenarios.resume.recalledWord = scenarios.resume.result?.text?.includes(word) ?? false;

// 3. --chorus-only: a mutating Bash request is denied over can_use_tool.
const marker = join(cwd, "chorus-only-marker.txt");
const secretish = "chorus-only-marker.txt";
scenarios.chorusOnlyDenial = await wake({
  sessionId: randomUUID(),
  prompt: `Use the Bash tool to run exactly this command: touch ${marker}\nDo not use any other tool. If it is denied, reply with the word DENIED.`,
});
scenarios.chorusOnlyDenial.markerCreated = existsSync(marker);
scenarios.chorusOnlyDenial.permissionPromptToolStdioInArgv =
  scenarios.chorusOnlyDenial.argv.join(" ").includes("--permission-prompt-tool stdio");
scenarios.chorusOnlyDenial.denyWarnHasNoCommandText =
  scenarios.chorusOnlyDenial.warnings.filter((w) => w.includes("denied tool")).every((w) => !w.includes("touch") && !w.includes(secretish));

// 4. Protocol interrupt mid-turn through the stop hook, then resume.
const interruptAnchor = randomUUID();
let killResult = null;
let interruptSentAfterMs = null;
const t0 = Date.now();
scenarios.interrupt = await wake({
  sessionId: interruptAnchor,
  prompt: `Reminder: the project tag is ${word}. Now, directly in your reply (no tools, no files), write a complete, heavily commented Python module implementing a red-black tree with insert, delete, search, in-order iteration and a full unittest suite. Make it long and thorough.`,
  onSpawn: (child) => {
    let fired = false;
    child.stdout.on("data", (c) => {
      // Interrupt once the turn has visibly started (init frame seen), after a short delay.
      if (fired || !String(c).includes('"subtype":"init"')) return;
      fired = true;
      setTimeout(async () => {
        interruptSentAfterMs = Date.now() - t0;
        killResult = await killProcessTree(child, { sigintTimeoutMs: 10_000 });
      }, 2500);
    });
  },
});
scenarios.interrupt.interruptSentAfterMs = interruptSentAfterMs;
scenarios.interrupt.killProcessTree = killResult;
scenarios.interruptResume = await wake({
  sessionId: interruptAnchor,
  prompt: "Never mind that task. What project tag did I mention earlier in this conversation? Reply with only the tag.",
});
scenarios.interruptResume.recalledWord = scenarios.interruptResume.result?.text?.includes(word) ?? false;

// 5. Yolo: AskUserQuestion is absent from the init tools list.
scenarios.yoloNoAskUserQuestion = await wake({
  sessionId: randomUUID(),
  permissionMode: "yolo",
  prompt: "Reply with exactly: OK",
});
const yoloTools = scenarios.yoloNoAskUserQuestion.initTools ?? [];
scenarios.yoloNoAskUserQuestion.askUserQuestionInTools = yoloTools.includes("AskUserQuestion");
scenarios.yoloNoAskUserQuestion.bashInTools = yoloTools.includes("Bash");

// Control (raw CLI, NOT the spawner): the same stream-json flags WITHOUT
// `--disallowedTools AskUserQuestion`, to show what the flag actually changes on
// this CLI version in each permission mode.
async function rawInitTools(extra) {
  const child = spawn(claudePath, ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--session-id", randomUUID(), ...extra, "--model", model], { cwd, env, stdio: ["pipe", "pipe", "ignore"] });
  let buf = "";
  let tools = null;
  child.stdout.on("data", (c) => {
    buf += String(c);
    for (const line of buf.split("\n")) {
      try { const f = JSON.parse(line); if (f.type === "system" && f.subtype === "init") tools ??= f.tools; } catch { /* partial */ }
    }
  });
  child.stdin.end(`${JSON.stringify({ type: "user", message: { role: "user", content: "Reply with exactly: OK" }, parent_tool_use_id: null })}\n`);
  const exitCode = await new Promise((resolve) => child.on("exit", resolve));
  return { exitCode, askUserQuestionInTools: tools ? tools.includes("AskUserQuestion") : null };
}
const withoutDisallowFlag = {
  chorusOnly: await rawInitTools(["--allowedTools", "mcp__chorus__*", "--permission-prompt-tool", "stdio"]),
  yolo: await rawInitTools(["--dangerously-skip-permissions"]),
};

// Keep evidence compact: the full tool list is only needed for scenario 5.
for (const [name, s] of Object.entries(scenarios)) {
  s.askUserQuestionInTools = s.initTools ? s.initTools.includes("AskUserQuestion") : null;
  if (name !== "yoloNoAskUserQuestion") s.initToolCount = s.initTools?.length ?? null, delete s.initTools;
}

const checks = {
  newSessionExit0: scenarios.newSession.wakeResult.exitCode === 0 && scenarios.newSession.isNewProbe === true,
  newSessionResultForwarded: scenarios.newSession.result?.subtype === "success",
  newSessionStdinClosedAfterResult: scenarios.newSession.stdinClosedAtResult === true,
  resumeUsedResumeFlag: scenarios.resume.isNewProbe === false && scenarios.resume.argv.includes("--resume"),
  resumeRetainedContext: scenarios.resume.recalledWord && scenarios.resume.wakeResult.exitCode === 0,
  chorusOnlyCanUseToolDenied: scenarios.chorusOnlyDenial.controlFramesSeenOnStdout.some((f) => f.subtype === "can_use_tool" && f.toolName === "Bash") &&
    scenarios.chorusOnlyDenial.stdinWrites.some((w) => w.behavior === "deny"),
  chorusOnlyVisibleWarnWithoutCommand: scenarios.chorusOnlyDenial.warnings.some((w) => w.includes("denied tool Bash")) && scenarios.chorusOnlyDenial.denyWarnHasNoCommandText,
  chorusOnlyNoSideEffect: !scenarios.chorusOnlyDenial.markerCreated,
  chorusOnlyPermissionPromptToolStdio: scenarios.chorusOnlyDenial.permissionPromptToolStdioInArgv,
  controlFramesNotForwarded: Object.values(scenarios).every((s) => s.controlFramesForwarded === 0),
  interruptViaProtocolNoEscalation: scenarios.interrupt.stdinWrites.some((w) => w.subtype === "interrupt") && killResult?.escalated === false && killResult?.signaled === false,
  interruptEndedTurn: scenarios.interrupt.result?.subtype === "error_during_execution",
  interruptResumeWorks: scenarios.interruptResume.wakeResult.exitCode === 0 && scenarios.interruptResume.isNewProbe === false,
  interruptResumeRetainedContext: scenarios.interruptResume.recalledWord === true,
  yoloAskUserQuestionAbsent: !scenarios.yoloNoAskUserQuestion.askUserQuestionInTools && scenarios.yoloNoAskUserQuestion.bashInTools &&
    scenarios.yoloNoAskUserQuestion.wakeResult.exitCode === 0,
  chorusOnlyAskUserQuestionAbsent: Object.entries(scenarios).filter(([n]) => n !== "yoloNoAskUserQuestion").every(([, s]) => s.askUserQuestionInTools === false),
};

const evidence = {
  claudeVersion,
  platform: process.platform,
  model,
  recordedAt: new Date().toISOString(),
  script: "docs/verification/claude-stream-json-live.mjs",
  checks,
  // Informational control, not a check: which mode's tool list the flag changes.
  controlWithoutDisallowedToolsFlag: withoutDisallowFlag,
  allPassed: Object.values(checks).every(Boolean),
  scenarios,
};
const json = `${JSON.stringify(evidence, null, 2)}\n`;
if (json.includes(homedir()) || json.includes(root)) throw new Error("evidence still contains a local path");
writeFileSync(out, json);
rmSync(root, { recursive: true, force: true });
console.log(`claude ${claudeVersion}: ${evidence.allPassed ? "ALL PASSED" : "FAILED"} → ${redact(out)}`);
for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? "ok  " : "FAIL"} ${k}`);
process.exitCode = evidence.allPassed ? 0 : 1;
