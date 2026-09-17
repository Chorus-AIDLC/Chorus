# Design — Claude Code sub-agent session naming

## Context

Two Bash hooks cooperate to create one Chorus session per Claude Code sub-agent:

| Hook | Event | What it knows |
|---|---|---|
| `on-pre-spawn-agent.sh` | `PreToolUse:Task` | the full `tool_input` (`subagent_type`, `description`), the CC `session_id` |
| `on-subagent-start.sh` | `SubagentStart` | `agent_id`, `agent_type` — **not** the `Task` tool input |

Because `SubagentStart` historically appeared not to carry the sub-agent's identity, the plugin passes the name across the two events through a per-spawn file under `<state>/pending/`, claimed by an atomic `mv` into `<state>/claimed/<agent_id>`.

**Premise check — is `SubagentStart.agent_type` the same value the `Task` call passed as `subagent_type`?** Yes, verified empirically rather than assumed: spawning `chorus:proposal-reviewer` during this change's own review round left an *unclaimed* pending file (`.../pending/unknown-1789437813321976762`), which only happens when `on-subagent-start.sh` exits early on its `agent_type` skip list — and the only value in that list matching this spawn is the literal `chorus:proposal-reviewer` passed as `subagent_type`. The existing skip list has therefore been matching on `agent_type == subagent_type` in production all along.

The defect is entirely in the *name* leg of that handoff: `tool_input.name` does not exist on CC's `Task` tool, so the name is empty at write time, the pending filename becomes `unknown-$(date +%s%N)`, and `on-subagent-start.sh` ends up using that filename as the session name.

## Decision

**The session name comes from the `SubagentStart` event's own `agent_type`, not from the pending file.**

The elaboration settled the name source as `subagent_type` only (parity with Pi's `{ name: item.agent }`). `agent_type` on the `SubagentStart` event is that same value, delivered directly to the hook that creates the session. So the cross-event file handoff is no longer needed *for naming* at all — it keeps exactly one job:

> **The pending file is a spawn gate, not a name channel.** Its presence proves this `SubagentStart` corresponds to a real `Task` spawn rather than one of Claude Code's internal/cleanup agents (which bypass `PreToolUse:Task`). No pending file → skip session creation, unchanged from today.

Consequences:

1. `SESSION_NAME` = `agent_type`, falling back to `worker-<agent_id first 8>` when `agent_type` is empty. The pending file's *name* content and its *filename* never feed the session name again.
2. Because the name no longer travels through the file, a FIFO mis-pairing in a mixed parallel batch can no longer mis-name a session — which is why the elaboration's "keep plain FIFO" answer is safe. The previous "Strategy 1: exact filename match on `agent_type`" branch could never hit once filenames carry a uniqueness suffix, so claiming collapses to the single FIFO loop.
3. Pending filenames still need to be unique per spawn (parallel spawns must not overwrite each other). They become `<sanitized subagent_type>__<epoch seconds>-<pid>` instead of `unknown-<ns>`, which also makes the directory legible while debugging.

### Rejected alternatives

- **`"<subagent_type>: <description>"` as the name** — more informative, but it re-introduces the file as the name channel (only `PreToolUse` sees `description`) and defeats reuse-by-name. Not chosen by the elaboration.
- **Fresh session per spawn (Pi-style ephemeral)** — the elaboration explicitly kept reuse/reopen-by-name.
- **Type-prefix-matched claiming** — unnecessary once the name comes from the event; the elaboration chose plain FIFO.

## Implementation notes

### `on-pre-spawn-agent.sh`

- Name resolution order becomes `tool_input.name` (kept: forward-compatible if CC ever adds it) → `subagent_type`. The JSON body written to the pending file carries that resolved name plus the type, so a future consumer has real data instead of `""`.
- Pending filename: sanitize the type with `tr` (Bash 3.2 has no `${VAR//…}` case ops beyond plain substitution; `tr -c '[:alnum:]._-' '_'` maps `:` and `/` to `_`), then append `__$(date +%s)-$$`.
  `$$` is required for uniqueness: BSD `date` (macOS) does not support `%N`, so a nanosecond suffix is not portable and two same-second spawns would otherwise collide on one filename — the exact class of bug the current `unknown-$(date +%s%N)` masks.
- Empty type (no `subagent_type` in the input) falls back to a `worker` stem so the filename is still deterministic and non-`unknown`.
- **Skip-list alignment (fixes an orphan-file leak).** The two hooks disagree today: `on-subagent-start.sh` exits early on `chorus:proposal-reviewer` / `chorus:task-reviewer`, but `on-pre-spawn-agent.sh` does not, so every reviewer spawn leaves a pending file nobody claims. A later internal/cleanup agent can then FIFO-claim that stale file and be granted a session, defeating the spawn gate this design leans on. Add the two reviewer types to `on-pre-spawn-agent.sh`'s skip `case` so the two lists match exactly. (Observed instance of the leak: `.../pending/unknown-1789437813321976762`, left by this change's own review round.)

### `on-subagent-start.sh`

- Keep: the non-worker `agent_type` skip list, the `agent_id` guard, the claim-or-skip gate, reuse/reopen/create, plugin state writes (`session_<agentId>`, `agent_for_session_<uuid>`, `session_<name>`, `name_for_agent_<agentId>`), the `<state>/sessions/<name>.json` metadata file, and the injected workflow text.
- Change: `SESSION_NAME="${AGENT_TYPE:-worker-${AGENT_ID:0:8}}"`, and drop the two name-from-file assignments (`AGENT_NAME="$AGENT_TYPE"` / `AGENT_NAME="${FILE_NAME:-$candidate}"`) along with the never-hitting exact-match claim branch. `${AGENT_ID:0:8}` substring expansion is Bash 3.2-safe and already used in this file.
- Change: the `<state>/sessions/<name>.json` metadata file uses a **sanitized** form of the name for its filename (same `tr` sanitization as the pending stem). Namespaced types such as `chorus:code-reviewer` — not in the skip list, so it does reach this code — would otherwise put a `:` into a path for the first time. The `name` sent to `chorus_create_session`, the state keys, and the injected workflow text keep the raw `agent_type`; only the on-disk filename is sanitized.

### Reuse interaction

With type-based names, repeated `claude` workers converge on **one** long-lived session named `claude` that is reused (heartbeat) or reopened. That is the elaborated intent (`keep-reuse`) and is what Pi effectively does too. No change to the list/match/reuse block.

### Holder-aware teardown (found by the ship-time code review)

Reuse-by-name only became *reachable* with this change, and it exposed an assumption in `on-subagent-stop.sh`: one session per agent. With two same-type workers sharing a session, the first exit closed it, checked out the **sibling's** open task, deleted the `session_<name>` state key (`on-teammate-idle.sh` looks the live session up by that key to heartbeat it) and removed `sessions/<name>.json`. Pre-fix the two `unknown-*` sessions were distinct, so this is a regression introduced here, not pre-existing — and the "interleaved activity" risk accepted below does not cover premature close or cross-agent checkout.

Fix: reference-count holders on the filesystem, no new service and no new MCP tool.

- `on-subagent-start.sh` touches `<state>/holders/<sanitized session name>/<agentId>` once the session UUID is resolved (created, reused or reopened). `mkdir -p` + `: >` are atomic enough — concurrent registrations cannot lose an entry.
- `on-subagent-stop.sh` removes its own entry **first**, then counts what remains. Zero → today's full teardown (checkout, close, all four state keys, metadata file, claimed file, auto-verify, `rmdir`). Non-zero → clean up only this agent's id-keyed state and `claimed/<agentId>`; no close, no checkout (those check-ins belong to siblings; each sub-agent checks its own task out per the injected workflow), no auto-verify, no name-keyed deletes.
- `agent_for_session_<uuid>` is a single-valued reverse map siblings overwrite, so it is deleted only on the last-holder path.
- No locking. If a sibling's start has not registered yet the stopping agent may see zero holders and close the session; the next start finds a `closed`/`inactive` row and reopens it through the existing path. Benign by construction.

## Risks

| Risk | Mitigation |
|---|---|
| Sessions named after a type collide across concurrent workers of the same type, interleaving their activity in one session | Accepted by the elaboration (`keep-reuse`); it is the pre-existing reuse semantics, now actually reachable |
| A shared session is closed — and a sibling's task checked out or auto-verified — when the *first* of several same-type workers exits | Holder refcount under `<state>/holders/<name>/<agentId>`; teardown only on the last holder (see "Holder-aware teardown") |
| A sub-agent whose `SubagentStop` never fires (crash, kill) leaks its holder entry, so the shared session stays `active` and its check-ins stay open | Accepted, and it fails in the safe direction: an over-long-lived session goes `inactive` after an hour without a heartbeat, and `on-session-end.sh` wipes the per-session state partition (holder dir included) when the Claude Code session ends. No TTL or sweeper — that would risk closing a session a live worker still holds |
| `agent_type` empty on some CC build → name regresses to an opaque id | Explicit `worker-<agentId8>` fallback; still never `unknown-*` |
| Bash 4-only syntax slips in (macOS runs 3.2) | `tr` instead of `${VAR^^}`/`${VAR,,}`; verified with `public/chorus-plugin/bin/test-syntax.sh` |
| Regression re-introduced later | New test asserts both the positive (name == `agent_type`) and negative (`unknown-*` never produced) case |

## Verification

- New `public/chorus-plugin/bin/tests/test-subagent-session-name.sh`: drives `on-pre-spawn-agent.sh` then `on-subagent-start.sh` with a synthetic CC `Task` / `SubagentStart` event pair against a stubbed `chorus-api.sh`, and asserts the `chorus_create_session` payload's `name` equals the event `agent_type` and does not match `unknown-*`. Covers the empty-`agent_type` fallback and a two-spawn parallel batch (no filename collision, both sessions named).
- **Shim mechanism:** the hooks resolve the wrapper as `API="${SCRIPT_DIR}/chorus-api.sh"` from `dirname "$0"` — a `PATH` shim would not be picked up. Follow the convention already established by `public/chorus-plugin/bin/tests/test-on-post-verify-task.sh`: **copy the hook into a sandbox dir next to a stub `chorus-api.sh`** that records payloads instead of calling the server, and point `CHORUS_STATE_DIR` at a temp dir.
- **CI wiring (required, not optional):** the `Run plugin shell tests` step in `.github/workflows/test.yml` lists each test file explicitly — there is no glob discovery, and half the files in `bin/tests/` are consequently never run. Add `bash public/chorus-plugin/bin/tests/test-subagent-session-name.sh` to that step, otherwise the regression mitigation above does not exist in practice.
- `bash public/chorus-plugin/bin/test-syntax.sh` for Bash 3.2 compatibility.
