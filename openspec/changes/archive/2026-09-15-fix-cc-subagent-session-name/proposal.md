# Fix Claude Code sub-agent session names showing as `unknown-xxxx`

## Why

When Claude Code spawns a task-level sub-agent, the Chorus session the plugin creates for it is named `unknown-<nanosecond-timestamp>`. Every worker looks identical and anonymous in the Chorus session list, so the swarm-mode observability the session model exists for is lost: you cannot tell which worker is which, and the reuse-by-name path degenerates into "one new junk session per spawn".

The Pi extension does not have this problem — it names each worker session after the real sub-agent — so the two harnesses are visibly inconsistent for the same user.

Root cause (read from the code, not inferred):

1. `public/chorus-plugin/bin/on-pre-spawn-agent.sh` reads the sub-agent name from `tool_input.name`. Claude Code's `Task` tool input has **no** `name` field — it carries `description` and `subagent_type` — so `AGENT_NAME` is always empty.
2. With an empty name, the pending file is written as `unknown-$(date +%s%N)` and its JSON body carries `"name":""`.
3. `public/chorus-plugin/bin/on-subagent-start.sh` claim Strategy 1 (exact filename match on `agent_type`) can therefore never hit; Strategy 2 (FIFO) claims the file, reads the empty `.name`, and falls back to **the pending filename** as the session name — producing `unknown-<ns>`, which is what `chorus_create_session` receives.

Reference implementation for the desired behavior: `packages/chorus-pi/extensions/chorus.ts` creates the worker session with `{ name: item.agent }` — the agent identity taken straight from the tool input at `tool_call` time.

## What Changes

- **`on-subagent-start.sh`**: derive the session name from the `agent_type` field of the `SubagentStart` event itself (the value Claude Code actually provides), falling back to `worker-<agentId first 8>` only when `agent_type` is empty. The "use the pending filename as the session name" path — the sole source of `unknown-<ns>` — is removed.
- **`on-pre-spawn-agent.sh`**: keep writing one pending file per spawn (it is the gate that distinguishes a real `Task` spawn from Claude Code's internal cleanup agents), but write `subagent_type` into the file body and use a `subagent_type`-derived, collision-free filename instead of `unknown-<ns>`. The `tool_input.name` read stays as a forward-compatible first choice.
- **Pending-file claiming stays plain FIFO** — deliberately unchanged. Because the name now comes from the event, a FIFO mis-pairing can no longer mis-name a session.
- **Session reuse/reopen-by-name stays as-is**: a same-named session that is `active` is reused (with a heartbeat), a `closed`/`inactive` one is reopened, otherwise a new session is created.
- **`on-subagent-stop.sh` becomes holder-aware.** Type-based names make reuse actually reachable, so several concurrent same-type workers now share one session — and the stop hook assumed one session per agent, closing the shared session (plus checking out and possibly auto-verifying a *sibling's* task) on the first exit. A filesystem refcount under `<state>/holders/<name>/<agentId>` gates teardown on being the last holder. Found by the ship-time code review; see the design doc.
- **Skip lists aligned across the two hooks**: `on-pre-spawn-agent.sh` currently writes a pending file for agent types that `on-subagent-start.sh` skips (`chorus:proposal-reviewer`, `chorus:task-reviewer`), leaving orphan files that a later internal agent can FIFO-claim — which leaks the "no pending file → no session" gate. Confirmed empirically during this change's own review round: the proposal-reviewer spawn left `~/.chorus/plugin/<cwd>/<session>/pending/unknown-1789437813321976762` unclaimed.
- **`sessions/<name>.json` metadata filename sanitized**: namespaced types (e.g. `chorus:code-reviewer`, which is *not* in the skip list) become filename components for the first time under this change, so the metadata filename gets the same sanitization as the pending filename. The session name sent to Chorus stays the unsanitized `agent_type`.
- **Regression test** under `public/chorus-plugin/bin/tests/` asserting that a `Task`-spawned sub-agent never yields a session name matching `unknown-*`, and that the name equals the event's `agent_type`, **wired into the CI step that runs plugin shell tests**.

## Capabilities

- `plugin-subagent-session-naming` — how the Claude Code plugin names the Chorus session it creates for a spawned sub-agent.

## Impact

- **Scope: Claude Code plugin only** — `public/chorus-plugin/bin/on-pre-spawn-agent.sh`, `public/chorus-plugin/bin/on-subagent-start.sh`, `public/chorus-plugin/bin/on-subagent-stop.sh` (sanitized metadata filename + holder-aware teardown), `public/chorus-plugin/bin/test-syntax.sh` (one assertion encoding the old name-as-filename convention), a new test under `public/chorus-plugin/bin/tests/`, and one added line in `.github/workflows/test.yml` to run that test. The Codex, dsh, and OpenClaw surfaces are explicitly out of scope for this change.
- **CI:** the `Run plugin shell tests` step in `.github/workflows/test.yml` enumerates each test file explicitly (no glob discovery), so the new test must be added to that list or it will never run.
- **No server, schema, API, or UI change.** No i18n keys, no Prisma migration.
- **Existing `unknown-*` sessions in the database are left as-is** — no rename script, no data migration (project policy bars DML in migrations anyway). Only newly created sessions get meaningful names.
- `on-subagent-stop.sh` keeps reading the name from plugin state (`name_for_agent_<agentId>`), which this change keeps writing; it gains the sanitized metadata-filename delete and the holder refcount. `on-teammate-idle.sh` heartbeats a live session by looking it up under the `session_<name>` state key, which the holder gate now keeps alive while any sibling is running.
- Scripts must remain Bash 3.2 compatible (macOS `/bin/bash` runs Claude Code hooks).
