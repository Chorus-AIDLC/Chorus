# Proposal: Daemon-woken headless Claude SHALL avoid AskUserQuestion and route human interaction through Chorus

## Why

The 0.11.0 daemon (root idea `9b76ccd7`) spawns a **headless `claude -p` subprocess** to do work when a notification arrives. Verified against the live process tree, a woken session runs as:

```
claude -p --output-format stream-json --verbose --session-id <idea-uuid> --dangerously-skip-permissions
```

There is **no human at the terminal**. Yet the woken agent still follows skills that mandate terminal-interactive prompts:

- `idea/SKILL.md` — "MUST ask the user for permission first via `AskUserQuestion`" before skipping elaboration; "MUST use `AskUserQuestion`" to present elaboration questions; "Use `AskUserQuestion` for all interactive questions — never plain text."
- `brainstorm/SKILL.md` — the whole loop is one `AskUserQuestion` per round.
- `develop/SKILL.md` — invites a completion report via `AskUserQuestion`.

When a headless session calls `AskUserQuestion`, the call either **hangs waiting for input that never arrives**, or is silently dropped by the host — so the agent **stalls** or **makes a unilateral decision** a human should have made. Meanwhile the real human *is* reachable, asynchronously, through the Chorus UI (comments, the elaboration question panel) — channels built for exactly this.

Two facts make the gap concrete (verified 2026-06-21):

1. **No daemon-specific context reaches the woken Claude.** `cli/claude-spawner.mjs#buildArgs()` runs headless with no `--append-system-prompt`; the only channel that injects daemon context is the wake prompt (`cli/prompts.mjs#buildPrompt()`). The prompts' file-header comment *claims* "The spawned Claude is headless," but **no actual wake prompt tells Claude that** — so Claude does not know.
2. **No machine-checkable headless signal exists.** `CHORUS_DAEMON_HEADLESS` is unset; nothing marks a daemon-woken process as headless.

This change closes the behavior gap so a daemon-woken session never blocks on a terminal prompt and always routes human-decision points to Chorus.

> Provenance: derived from daemon root idea `9b76ccd7`; idea `aa1b1dcc` (this proposal's input). The idea was elaborated and **human-verified** (Round 1, 7 questions) — the design below encodes those verified answers. The elaboration itself dogfooded the target behavior: it was conducted from a headless session that routed its questions to the Chorus elaboration panel + a comment instead of calling `AskUserQuestion`.

## What Changes

- **Wake-prompt headless preamble (q1=C, per-turn injection).** `cli/prompts.mjs` gains a shared `HEADLESS_PREAMBLE` block that `buildPrompt()` prepends to **every** non-null wake prompt (all `WAKE_ACTIONS`). It declares: you are a headless `claude -p` session; there is no human at the terminal; `CHORUS_DAEMON_HEADLESS=1` is set; do NOT call `AskUserQuestion` or any blocking terminal prompt. Because every wake — new **or** `--resume` — carries a freshly built prompt, the rule rides every turn (this is why a per-turn wake-prefix, not `--append-system-prompt`, satisfies cross-resume persistence).

- **Machine-checkable headless env signal (q3=A).** `cli/claude-spawner.mjs#wake()` sets `CHORUS_DAEMON_HEADLESS=1` in the spawned child's environment (merged over inherited `process.env`). The preamble also states the variable in-prompt, so the agent is aware of it even though, in default `chorus` permission mode, it cannot run a shell to read it.

- **Chorus-channel re-routing guidance (q6=C, general rule + a few examples).** The preamble gives a general rule plus a short illustrative mapping (not an exhaustive table): present elaboration questions → `chorus_pm_start_elaboration` (human answers in the UI panel); need a decision/confirmation → `chorus_add_comment` with an `@mention`; never silently skip a step that needs human input — record it in Chorus and stop.

- **Async hand-off behavior (q7=A).** The preamble instructs: when a point genuinely needs a human decision, post it to Chorus, then **end the turn and leave the work pending** — do not block waiting for a synchronous reply. The human's later comment / elaboration answer wakes a fresh turn that continues.

- **Soft guidance only (q2=A).** No tool-layer hard block of `AskUserQuestion`, no permission-deny, no runtime interceptor. The wake prompt + env signal guide behavior; revisiting a hard block is deferred unless guidance proves insufficient.

## Capabilities

### New Capabilities

- `daemon-headless-interaction-guard`: the behavioral contract for a daemon-woken headless session — the wake-prompt preamble (headless declaration + `AskUserQuestion` prohibition), the `CHORUS_DAEMON_HEADLESS=1` environment signal, the skill-instruction → Chorus-channel re-routing guidance, the post-to-Chorus-then-end-turn async hand-off, and the explicit injection-layer scope guard (wake-prompt only — not the system prompt, not a tool-layer block, not skill bodies).

### Modified Capabilities

- None. This change is purely additive. The existing `cli-daemon` spawn and wake requirements are unchanged — the spawn argv is byte-for-byte the same except for the added child env var, which is a new requirement in the new capability rather than a rewrite of the cross-platform-spawn requirement.

## Impact

- **Schema**: none. No migration, no model, no enum.
- **Daemon client code** (in-repo, `cli/`):
  - `cli/prompts.mjs` — add `HEADLESS_PREAMBLE`; wrap `buildPrompt()` to prepend it to every non-null wake body (null-returning actions — empty `human_instruction`, unknown actions — stay null, so no spurious spawn). Update the file-header comment to stop merely *claiming* headlessness and point at the preamble.
  - `cli/claude-spawner.mjs` — `wake()` passes `env: { ...process.env, CHORUS_DAEMON_HEADLESS: "1" }` to the spawn; `buildArgs()` is unchanged (explicitly **no** `--append-system-prompt`). Update the header comment.
  - `cli/__tests__/` — unit tests for the preamble (every wake action carries it; non-wake actions still null) and the env signal (child env contains the var, inherited env preserved, `buildArgs` excludes `--append-system-prompt`).
- **Skill docs**: **none.** Reconciling the two verified scope answers — q4=C (keep the rule in the wake prompt only; do **not** add `if headless` branches to skill bodies) and q5=A (keep the 4 skill surfaces in sync) — the net is that **no skill body changes**, so there is nothing to fan out across the Claude Code / Codex / standalone / OpenClaw surfaces; "in sync" is satisfied by leaving them all untouched.
- **MCP tools / `docs/MCP_TOOLS.md`**: unchanged — no new tool.
- **`docs/design.pen`**: not applicable — this is a daemon CLI behavior change with no user-facing screen or component.
- **Runtime**: no new dependencies, no new permission bit, no protocol change.
- **Backward compat**: fully additive. Interactive (human-at-terminal) Claude Code sessions never go through `cli/prompts.mjs` or `cli/claude-spawner.mjs`, so they are entirely unaffected — the preamble and env var exist only on the daemon spawn path.

## Out of Scope

- **Editing skill bodies.** No `if headless` conditional is added to `idea` / `brainstorm` / `develop` / `proposal` / `yolo` (q4=C). The `AskUserQuestion` interactive path stays intact for human-at-terminal runs; it is only soft-bypassed in headless via the wake prompt.
- **A tool-layer hard block** of `AskUserQuestion` (deny / strip / runtime interceptor) — deferred (q2=A); revisit only if soft guidance proves insufficient.
- **`--append-system-prompt` / system-level injection** — explicitly rejected (q1=C). Persistence across `--resume` is achieved by re-injecting the preamble in each per-turn wake prompt.
- **A skill/hook consumer of `CHORUS_DAEMON_HEADLESS`.** The env var is laid down now as a forward-looking, machine-checkable signal (and stated in the prompt for the agent's awareness), but wiring skills or hooks to programmatically branch on it is deferred (follows from q4=C). No code in this change reads the variable back.
- Daemon protocol, concurrency/queue model, transcript, and connection observability — owned by sibling ideas.
