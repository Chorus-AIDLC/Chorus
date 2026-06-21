# Tasks: add-daemon-headless-interaction-guard

## 1. Wake-prompt headless preamble (`cli/prompts.mjs`)
- [ ] 1.1 Add exported `HEADLESS_PREAMBLE` constant: headless + no-human-at-terminal + `CHORUS_DAEMON_HEADLESS=1` declaration; `AskUserQuestion`/blocking-prompt prohibition; general route-through-Chorus rule; a few illustrative skill→Chorus mappings (q6=C); async hand-off (post to Chorus, end turn, leave pending — q7=A)
- [ ] 1.2 Wrap `buildPrompt(n)` so it computes the per-action body first, returns `null` unchanged when the body is null (unknown action / empty `human_instruction`), and otherwise returns `HEADLESS_PREAMBLE + body`
- [ ] 1.3 Update the file-header comment to point at the preamble instead of merely asserting headlessness

## 2. Headless env signal (`cli/claude-spawner.mjs`)
- [ ] 2.1 In `ClaudeSpawner.wake()`, pass `env: { ...process.env, CHORUS_DAEMON_HEADLESS: "1" }` to the spawn options (merged over inherited env); leave `buildArgs()` unchanged — explicitly NO `--append-system-prompt`
- [ ] 2.2 Update the header comment to document the env signal

## 3. Tests (`cli/__tests__/`)
- [ ] 3.1 prompts: every `WAKE_ACTIONS` entry yields a prompt containing the preamble + the `AskUserQuestion` prohibition + the async-hand-off line, with the original `[Chorus] …`/`@mention` body still present after it
- [ ] 3.2 prompts: unknown action and empty `human_instruction` still return `null` (preamble did not resurrect them)
- [ ] 3.3 spawner: injected `spawnImpl` receives `env.CHORUS_DAEMON_HEADLESS === "1"` and a sentinel inherited var survives the merge; assert in both `chorus` and `yolo` permission modes
- [ ] 3.4 spawner: `buildArgs(...)` output does not contain `--append-system-prompt` (locks q1=C)

## 4. Integration checkpoint
- [ ] 4.1 Run the existing daemon suite green end-to-end — `cli/__tests__/wake-orchestration.test.mjs` (where the `buildPrompt` wake-prompt assertions live), `daemon-integration.test.mjs`, `claude-spawner.test.mjs` — the preamble lengthens prompts but argv and wake flow are structurally unchanged; confirm no existing assertion on exact prompt text breaks (update any that pin the full body)
- [ ] 4.2 Verify the daemon-only scope guard manually (the spec's "no skill bodies modified" negative requirement has no automated test): confirm `git diff --stat` shows changes ONLY under `cli/` (`prompts.mjs`, `claude-spawner.mjs`, `__tests__/`) — no skill markdown under any of the four surfaces (Claude Code plugin, Codex plugin, `public/skill/`, OpenClaw) and no `--append-system-prompt` added to `buildArgs`
