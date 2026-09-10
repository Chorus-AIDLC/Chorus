# Tasks

> Mirrored 1:1 into Chorus task drafts (Chorus is the source of truth for task
> state; this file is the local OpenSpec view).

## 1. Config resolution — `model` / `thinking` in `agents[]` (+ top-level defaults)

- [ ] 1.1 `cli/daemon-config.mjs`: add `model` / `thinking` to the `AgentConfig` typedef and to **both** resolution paths (flat back-compat + `agents[]` merge over top-level defaults). Present-but-not-non-empty-string ⇒ throw naming `Agent <label>` **and** the field; value never validated. Extend `cli/__tests__/daemon-multi-agent-config.test.mjs`: per-agent override, top-level inheritance, invalid value throws (empty string / number / object), flat path, unknown value passes through, and absent ⇒ fields undefined.
- [ ] 1.2 `cli/daemon.mjs`: thread the two fields into each agent runtime's deps **and** into the flat single-agent branch (`runDaemon` without `agents[]` must resolve the file's top-level values and pass them into `buildDaemon`, otherwise a flat install keeps silently ignoring them); extend the per-agent startup line to print `model=` / `thinking=`; add `Model` / `Thinking` rows to the single-agent startup banner; allow-list the fields for the v1 backends and emit one warning line for a field set on an unsupported backend (`dsh` / `kiro` / `offline`). Runtime tests: two agents with different values build with those values in their deps; the flat path forwards the resolved values; an invalid flat value exits non-zero; the unsupported case warns and does not throw.

## 2. Wake-path delivery — spawners

- [ ] 2.1 `cli/spawner-select.mjs` + `cli/claude-spawner.mjs` + `cli/pi-spawner.mjs` + `cli/codex-spawner.mjs`: forward `model` / `thinking` from the spawner options into each argv builder (`--model` / `--effort`, `--model` / `--thinking`, `-m` / `-c model_reasoning_effort=` — the codex mapping in **both** the fresh-`exec` and `exec resume` shapes); for pi the mapped flags MUST be inserted **before the trailing `-p`**, which stays the last argument. `DshSpawner` / `KiroSpawner` unchanged and must not throw when the fields are present. Extend `claude-spawner.test.mjs` / `pi-spawner.test.mjs` / `codex-spawner.test.mjs`: each field alone, both together, neither (argv byte-identical to before), the pi `-p`-last invariant, and a resume-shape codex case.

## 3. Foreground parity — `chorus agents run`

- [ ] 3.1 `cli/credentials.mjs` (`resolveLaunchAgent` carries `model` / `thinking` from the selected entry, falling back to the file's **top-level default** when the entry omits it) + `cli/agent-launcher.mjs` (map them with the same per-backend table and prepend ahead of the passthrough; skip a knob whose flag the passthrough already carries; print the resolved values in the launch diagnostic; report the omission for an unsupported backend). Extend `agent-launcher.test.mjs`: applied when configured, top-level default inherited, suppressed when the passthrough overrides, no-op when unset, diagnostics name the values, unsupported backend still launches.

## 4. Docs + end-to-end verification

- [ ] 4.1 `docs/DAEMON.md`: add the two fields to the per-agent field table with their backend vocabulary, and extend the per-backend delivery section with the model/thinking mapping + the unsupported-backend caveat.
- [ ] 4.2 End-to-end: configure two agents in `~/.chorus/daemon.json` against the local server with different `model` / `thinking` values, start `chorus daemon`, and verify (a) both startup lines print their own values, (b) a live wake runs the turn, (c) an unsupported/omitted case produces no flag. Capture the evidence in the Chorus task report.
- [ ] 4.3 Full local gate: the CLI vitest suite for the touched files + `openspec validate add-daemon-per-agent-model-thinking`; then `openspec archive` and mirror the updated capability specs back to Chorus.
