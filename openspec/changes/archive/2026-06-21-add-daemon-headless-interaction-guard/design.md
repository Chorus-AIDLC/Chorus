# Design: Daemon headless interaction guard

## Context

The daemon's wake path is: SSE notification → `event-router` resolves lineage → `WakeQueue` serializes per direct-idea → `Waker.wake()` → `buildPrompt(notification)` (`cli/prompts.mjs`) produces the user-message prompt → `ClaudeSpawner.wake()` (`cli/claude-spawner.mjs`) spawns headless `claude -p`, writes the prompt to **stdin**, parses NDJSON stdout.

Two insertion points, both already single-responsibility and daemon-only:

1. **`cli/prompts.mjs#buildPrompt(n)`** — the one function that builds every wake user-message. Imported only by `cli/waker.mjs` and tests; never by interactive Claude Code. A preamble here reaches every wake and nothing else.
2. **`cli/claude-spawner.mjs#ClaudeSpawner.wake()`** — the one place that calls `spawnImpl(command, argv, opts)`. Today `opts` has **no `env` key**, so the child inherits `process.env` wholesale. Adding `env` is the single point to inject `CHORUS_DAEMON_HEADLESS=1`.

The elaboration answers (human-verified) fix the design choices; this document records the *how* and the non-obvious edge cases.

## Decisions

### D1 — Per-turn wake-prompt preamble, NOT `--append-system-prompt` (q1=C, q2=A)

The rule lives in a single exported constant `HEADLESS_PREAMBLE` in `cli/prompts.mjs`. `buildPrompt()` prepends it to every **non-null** wake body.

- **Why per-turn works across `--resume`:** the daemon builds a fresh prompt for *every* wake (new session or resume) — see `Waker.wake()` calling `buildPrompt(notification)` unconditionally before each `spawner.wake()`. So the preamble is present on turn 1 and every resumed turn. There is no turn that skips `buildPrompt`. This is the property that made the owner pick C over the `--append-system-prompt` option: we get cross-resume persistence without touching the spawn argv contract.
- **Why not `--append-system-prompt`:** rejected by the owner. It would change `buildArgs()` (the deliberately single-line-edit flag list) and add a second injection channel to keep coherent with the prompt. Re-injecting one preamble per turn is simpler and equally persistent given the daemon's build-every-wake behavior.
- **Soft only:** the preamble is guidance text. No deny-list, no argv change to strip tools, no runtime interception (q2=A).

### D2 — `CHORUS_DAEMON_HEADLESS=1` child env (q3=A)

`ClaudeSpawner.wake()` builds the spawn options with:

```js
env: { ...process.env, CHORUS_DAEMON_HEADLESS: "1" }
```

- Merged over `process.env` so the child keeps PATH, the Bedrock/credential vars, `CLAUDE_CONFIG_DIR`, etc. — only the one var is added.
- Set unconditionally for the daemon spawn (the spawner exists only to run headless daemon wakes; both `chorus` and `yolo` permission modes are headless).
- The preamble *states* the variable so the agent is aware of it. In default `chorus` permission mode the agent has only `mcp__chorus__*` tools (no Bash), so it cannot literally `echo $CHORUS_DAEMON_HEADLESS` — awareness comes from the prompt text. The env var's value is forward-looking: a future skill/hook (out of scope here) can branch on it. **No code in this change reads it back** — laying down the signal is the deliverable.
- Default `chorus` mode already can't call `AskUserQuestion` (it's not an `mcp__chorus__*` tool, so it's auto-denied). The guard's real bite is in `yolo`/`--dangerously-skip-permissions` mode (the verified live session above), where every tool is allowed and `AskUserQuestion` *would* fire — there the preamble is what stops it.

### D3 — Preamble content (q6=C — general rule + a few examples)

`HEADLESS_PREAMBLE` is a compact block (kept short — it rides every wake, so every token is paid per wake). It contains, in order:

1. **Identity + fact:** "You are a headless `claude -p` session woken by the Chorus daemon. There is no human at the terminal. `CHORUS_DAEMON_HEADLESS=1` is set."
2. **Prohibition:** "Do NOT call `AskUserQuestion` or any interactive/blocking terminal prompt — it reaches no one and will hang or be dropped."
3. **General rule:** "Route every point that needs human input or confirmation through Chorus: post a comment with an `@mention`, or open an elaboration round the human answers in the UI."
4. **A few examples (illustrative, not exhaustive):**
   - skill says "present elaboration questions via `AskUserQuestion`" → open an elaboration round (described in prose) the human answers in the Chorus UI panel + a comment `@mention`.
   - skill says "ask the user before skipping elaboration" → don't silently skip; record the reason in a Chorus comment.
   - skill says "invite a report via `AskUserQuestion`" → create the report directly or skip it; don't prompt.
5. **Async hand-off (q7=A):** "After posting a question to Chorus, end the turn and leave the work pending. Do not poll or wait for a synchronous reply — the human's reply wakes a fresh turn that continues."

The block is delimited so it reads as a framing preamble, then the existing per-action text follows (`[Chorus] …`).

> **Wording constraint (discovered during implementation).** The preamble rides **every** wake, including `elaboration_verified` — and a prior change (`add-elaboration-verify-wake`) established an invariant, asserted in `wake-orchestration.test.mjs`, that the `elaboration_verified` "write the proposal" prompt MUST NOT contain the answer-questions tool names `chorus_pm_start_elaboration` / `chorus_pm_validate_elaboration`. So the preamble's re-routing guidance names **`chorus_add_comment`** and describes the elaboration panel **in prose**, and deliberately does NOT embed those two literal tool names. This satisfies q6=C (general rule + a few examples) while preserving the sibling invariant — no existing test needed editing.

### D4 — Null-prompt actions stay null

`buildPrompt()` returns `null` for unknown actions and for an empty `human_instruction` (no body to act on). The wrapper prepends the preamble **only when the underlying body is non-null** — a null stays null so the router still skips the wake (no contentless spawn). Implementation: compute the body first, `if (body == null) return null;` then return `HEADLESS_PREAMBLE + "\n\n" + body`.

### D5 — Surface scope: daemon-only, skills untouched (q4=C + q5=A reconciled)

q4=C says keep the rule in the wake prompt, not in skill bodies. q5=A says keep the 4 skill surfaces in sync. These only *appear* to conflict: since the rule lives entirely in `cli/` (the daemon, effectively the Claude Code surface — the only one with a spawner) and **no skill markdown is edited**, there is nothing to fan out, so all four surfaces stay byte-identical-as-before = "in sync." The reconciliation was put to the owner explicitly and verified. Net: this change touches `cli/prompts.mjs`, `cli/claude-spawner.mjs`, and `cli/__tests__/` only.

## Risks / Trade-offs

- **Per-wake token cost.** The preamble is added to every wake prompt. Mitigation: keep it compact (a handful of lines); it is far cheaper than a stalled or wrongly-auto-decided turn.
- **Soft guidance is not a guarantee.** A model could still emit `AskUserQuestion` despite the preamble. Accepted (q2=A); the env var is laid down so a hard block or hook-based enforcement can be added later without re-plumbing.
- **`yolo` vs `chorus` mode asymmetry.** In `chorus` mode `AskUserQuestion` is already auto-denied (not an allowed tool); the preamble is belt-and-braces there and load-bearing in `yolo` mode. Documented in D2 so a future reader doesn't think the preamble is redundant.

## Test Plan

- `cli/prompts.mjs`: assert every action in `WAKE_ACTIONS` yields a prompt that **starts with / contains** the headless preamble and the literal `AskUserQuestion` prohibition; assert unknown action and empty `human_instruction` still return `null` (preamble did not resurrect them); assert the existing per-action `[Chorus] …` text and `@mention` guidance are still present after the preamble.
- `cli/claude-spawner.mjs`: with an injected `spawnImpl`, assert the spawn options' `env.CHORUS_DAEMON_HEADLESS === "1"` and that an inherited var (e.g. a sentinel set on `process.env`) survives in the merged env; assert `buildArgs(...)` output does **not** include `--append-system-prompt` (locks in q1=C).
- Existing daemon integration / wake-orchestration tests continue to pass (the prompt is longer but structurally unchanged; argv is unchanged).
