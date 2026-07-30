# Design — global plugin state layout

## Context

The Claude Code plugin's hooks (`public/chorus-plugin/bin/*.sh`) coordinate through files under `${CLAUDE_PROJECT_DIR:-.}/.chorus/`. The anchor is defined in two places today:

- `chorus-api.sh:17` — `STATE_DIR="${CLAUDE_PROJECT_DIR:-.}/.chorus"` (+ `STATE_FILE`, `SESSIONS_DIR`).
- `on-session-end.sh:8` — a second, independent copy of the same expression.

Four more hooks build sub-paths inline off the same base: `on-subagent-start.sh` (`pending/`, `claimed/`, `sessions/`), `on-subagent-stop.sh` (`sessions/`, `claimed/`), `on-pre-spawn-agent.sh` (`pending/`), `on-user-prompt.sh` (`sessions/`).

`chorus-api.sh` itself **never reads the hook event JSON** — it only sees environment variables. The Claude Code session id lives in each hook's stdin payload (`.session_id`), so it must be lifted by the hooks and passed down.

### Which hooks touch STATE_DIR (verified enumeration)

Not every hook uses on-disk state. A hook touches STATE_DIR only if it calls `chorus-api.sh` in a mode that reaches `ensure_state` — i.e. `state-get` / `state-set` / `state-delete` / `mcp-tool` / `session-*` — or builds a `pending/`/`claimed/`/`sessions/` path itself. `hook-output` does **not** call `ensure_state`, so hooks that only emit output never touch STATE_DIR.

| Hook | Touches STATE_DIR? | Why / how |
|---|---|---|
| `on-session-start.sh` | yes | `state-set` owner/permissions + `mcp-tool` checkin |
| `on-user-prompt.sh` | yes | reads `sessions/` for a local count |
| `on-pre-spawn-agent.sh` | yes | writes `pending/<name>` |
| `on-subagent-start.sh` | yes | `pending/`→`claimed/`, writes `sessions/`, `state-set` mappings |
| `on-subagent-stop.sh` | yes | `state-get`/`state-delete` mappings, removes `sessions/`+`claimed/` |
| **`on-teammate-idle.sh`** | **yes** | **`state-get "session_<teammateName>"`** then heartbeat — cross-hook read |
| **`on-task-completed.sh`** | **yes** | **`state-get "session_<agentId>"`** then checkout — cross-hook read |
| **`on-post-verify-task.sh`** | **yes** | `mcp-tool` calls → `ensure_state` writes `.mcp_*` temp files under STATE_DIR |
| `on-post-submit-proposal.sh` | no | `hook-output` only — never calls `ensure_state` |
| `on-post-submit-for-verify.sh` | no | `hook-output` only |
| `on-pre-enter-plan.sh` / `on-pre-exit-plan.sh` | no | no state / no `ensure_state` |

**Every hook in the "yes" rows MUST export `CHORUS_SESSION_ID`** before calling `chorus-api.sh` or building a sub-path. The three bolded rows were the review BLOCKER/NOTE: `on-teammate-idle.sh` and `on-task-completed.sh` read `session_<key>` mappings that `on-subagent-start.sh` wrote — if they resolved to a different (`no-session`) partition than the writer, the lookup would miss and heartbeats / auto-checkout would silently stop. They resolve consistently only because all three now export the same top-level `session_id`.

### The universal-`session_id` assumption is doc-confirmed

The design depends on Claude Code emitting the **same** top-level `session_id` on **every** hook event (SessionStart, UserPromptSubmit, Pre/PostToolUse, SubagentStart/Stop, TeammateIdle, TaskCompleted, SessionEnd). This is confirmed by the official Agent SDK hooks reference (`code.claude.com/docs/en/agent-sdk/hooks.md`, "Inputs" §, lines 255–256): *"All hook inputs share `session_id`, `cwd`, and `hook_event_name`."* Sub-agents/teammates do **not** get a different top-level `session_id` — they are distinguished by a separate `agent_id` / `teammate_name` field. Therefore extracting `.session_id` from stdin is reliable on all "yes" rows with zero exceptions, and no session-id discovery fallback is required (the `no-session` bucket exists only for the degenerate no-stdin case, e.g. a manual invocation).

## Goals / Non-Goals

**Goals**
- One global root `~/.chorus/plugin/`, physically disjoint from the daemon's top-level `~/.chorus/{daemon.json,daemon.pid,daemon.log,*-sessions.json}`.
- Human-readable per-project grouping (`<cwd-slug>`) so `ls ~/.chorus/plugin/` tells you which projects have state, without decoding a hash.
- Per-session isolation (`<sessionId>`) so concurrent CC sessions on the same project never share files — restoring a clean `rm -rf` on session end.
- **Fail-soft everywhere.** No new failure mode may abort a hook or block development. This is the owner's explicit constraint.

**Non-Goals**
- Migrating existing per-project `.chorus/` folders (left in place).
- Cross-session shared files or a global lock (each session owns its own `state.json`; existing per-file `flock` is unchanged).
- Touching non-Claude-Code plugins (they write nothing to disk).
- A mtime-based GC of crash-leftover session dirs (noted as optional; not built here).

## Layout

```
~/.chorus/                         # daemon's root (unchanged)
├── daemon.json                    # daemon — untouched
├── daemon.pid / daemon.log        # daemon — untouched
├── codex-sessions.json …          # daemon — untouched
└── plugin/                        # NEW — Claude Code plugin namespace
    └── <cwd-slug>/                # e.g. -home-ubuntu-dev-ai-pm
        └── <sessionId>/           # CC session id (one dir per CC session)
            ├── state.json         # + state.json.lock
            ├── sessions/          # <agentName>.json
            ├── pending/           # PreToolUse:Task → SubagentStart handoff
            ├── claimed/           # claimed pending files, keyed by agent_id
            └── .mcp_headers.* / .mcp_response.*   # MCP handshake temp files
```

## `bin/chorus-paths.sh` — the single source of truth

A tiny sourced library (not an executable subcommand). Sourcing it defines the resolved paths as variables in the caller's shell, given `CHORUS_SESSION_ID` and a project dir in the environment. Pseudocode:

```bash
# chorus-paths.sh — resolve the plugin's global state directory.
# Sourced by chorus-api.sh and every state-touching hook.
# Inputs (env):  CHORUS_SESSION_ID (optional), CLAUDE_PROJECT_DIR (optional)
# Outputs (vars): CHORUS_PLUGIN_ROOT, CHORUS_CWD_SLUG, CHORUS_STATE_DIR

# 1. Global root. Honor an override for tests / unusual homes.
CHORUS_PLUGIN_ROOT="${CHORUS_PLUGIN_STATE_ROOT:-${HOME:-/tmp}/.chorus/plugin}"

# 2. cwd -> readable slug, mirroring ~/.claude/projects encoding.
#    Absolute path, strip trailing slash, replace every non-alnum
#    ([^A-Za-z0-9]) with '-'. "/home/ubuntu/dev/ai-pm" -> "-home-ubuntu-dev-ai-pm".
chorus_slug_for_dir() {
  local d="${1:-$PWD}"
  case "$d" in /*) ;; *) d="$PWD/$d" ;; esac      # make absolute (no realpath dep)
  printf '%s' "$d" | sed -e 's#/*$##' -e 's#[^A-Za-z0-9]#-#g'
}
CHORUS_CWD_SLUG="$(chorus_slug_for_dir "${CLAUDE_PROJECT_DIR:-$PWD}")"

# 3. Session partition. Fall back through a chain that NEVER yields empty.
_sid="${CHORUS_SESSION_ID:-}"
[ -z "$_sid" ] && _sid="no-session"              # last-resort shared bucket
CHORUS_STATE_DIR="${CHORUS_PLUGIN_ROOT}/${CHORUS_CWD_SLUG}/${_sid}"
```

Key robustness properties:

- **Never empty.** If `HOME` is unset it falls to `/tmp`; if `CHORUS_SESSION_ID` is unset it falls to a literal `no-session` bucket. The resolved dir is always a valid, writable-intent path — sourcing cannot fail the caller.
- **`CHORUS_PLUGIN_STATE_ROOT` override** lets `test-syntax.sh` (and any future test) point the root at a throwaway `/tmp` dir instead of the real `~/.chorus`.
- **Bash 3.2 safe:** uses `sed` for slug (no `${var//}` global-replace surprises across shells), no associative arrays, no `realpath`.

## Session-id acquisition in hooks

Each hook that already does `EVENT=$(cat)` gains one line before it calls `chorus-api.sh` or touches sub-paths:

```bash
CHORUS_SESSION_ID=$(printf '%s' "$EVENT" | jq -r '.session_id // .sessionId // empty' 2>/dev/null) || true
export CHORUS_SESSION_ID
```

This line goes into **every** hook in the "touches STATE_DIR" table above — including `on-teammate-idle.sh`, `on-task-completed.sh`, and `on-post-verify-task.sh`. All Claude Code hook events for one session carry the **same** top-level `session_id` (sub-agents are distinguished by `agent_id`, a separate field — see doc citation above). Therefore `pending/` (written by PreToolUse:Task) and `claimed/`/`sessions/` (written by SubagentStart) resolve to the same `<sessionId>` dir, and — critically — the `session_<key>` mappings that `on-subagent-start.sh` writes are read back by `on-subagent-stop.sh`, `on-teammate-idle.sh`, and `on-task-completed.sh` from that same `<sessionId>/state.json`. The handoff and all cross-hook lookups keep working exactly as before.

`on-user-prompt.sh` must stay MCP-free and fast; it still extracts `session_id` (a cheap `jq` on already-read stdin) purely to locate `sessions/` for its count — no network.

### Fallback chain (why the handoff can't silently break)

| Situation | `CHORUS_SESSION_ID` | Result |
|---|---|---|
| Normal hook with stdin event | real CC session id | per-session dir, isolated |
| Hook with no stdin / missing field | `no-session` | shared per-cwd bucket; still works within one project, just not isolated across concurrent sessions |
| `chorus-api.sh` called by a hook that forgot to export | inherited env or `no-session` | resolves to a valid dir; worst case a pending file lands in the `no-session` bucket and SubagentStart looks there too (same resolution), so the FIFO claim still finds it |

The design deliberately keeps PreToolUse:Task and SubagentStart resolving through the **same** `chorus-paths.sh`, so whatever bucket one writes to, the other reads from — the handoff is resolution-consistent by construction.

## Cleanup (`on-session-end.sh`)

Rewritten to source `chorus-paths.sh` and operate on `CHORUS_STATE_DIR` (the current session's dir). Because the dir is now session-scoped, the previous "is it safe to delete?" guards (non-empty `sessions/`, non-empty `state.json`) are no longer needed to protect sibling sessions — a session may `rm -rf` its own dir unconditionally. We keep a light guard: only remove when `CHORUS_SESSION_ID` resolved to a real id (not the `no-session` shared bucket), so a degenerate session never wipes the shared fallback out from under a concurrent one. Best-effort `rmdir` the now-possibly-empty `<cwd-slug>/` parent (ignore failure if other sessions remain).

## Fail-soft contract

- Every hook already begins with `set -euo pipefail` **but** guards each external call with `|| true` / `2>/dev/null` and `exit 0` on the unhappy path. Sourcing `chorus-paths.sh` is pure variable assignment (no external command that can non-zero the script) — but we still `source … || true`-guard it and provide inline defaults so a missing/renamed file degrades to the old `${CLAUDE_PROJECT_DIR:-.}/.chorus` behavior rather than crashing.
- `mkdir -p "$CHORUS_STATE_DIR"` failures (e.g. read-only `$HOME`) are already tolerated by `ensure_state`'s callers via the existing `flock -w` timeout + `return 0` warning path; we extend the same "warn, don't die" stance to directory creation.
- Net: **no path in this change can turn a previously-succeeding development action into a failure.** The worst degradation is "session not tracked in the UI," which the code already treats as non-fatal (see `on-subagent-start.sh:150` warning branch).

## Testing

- `bin/test-syntax.sh` extended: set `CHORUS_PLUGIN_STATE_ROOT=/tmp/chorus-test-$$/global`, feed each hook a synthetic event with a known `session_id`, assert files land under `…/global/<slug>/<sessionId>/…` and NOT under `${CLAUDE_PROJECT_DIR}/.chorus`. Assert `chorus_slug_for_dir` output for a known path. Assert the `no-session` fallback when `session_id` is absent. Must pass under `/bin/bash` (3.2) on macOS.
- Manual smoke: run a real sub-agent spawn in a scratch repo, confirm `~/.chorus/plugin/<slug>/<sessionId>/sessions/` populates and SessionEnd removes it.

## Alternatives considered (from elaboration)

- **cwd-hash partition** (opaque `<hash(cwd)>`): rejected — the owner wants a directory name they can eyeball. Readable slug chosen.
- **cwd-only partition** (no session level): rejected — concurrent CC sessions on one project would share `state.json`/`sessions/` and could not `rm -rf` on end without racing siblings. Session level restores clean teardown.
- **Migrate old folders on startup**: rejected — extra code for a one-time cosmetic gain; old dirs are gitignored and harmless.
- **Separate `~/.chorus-plugin/` root**: rejected — two `chorus` dirs is worse than one namespaced subdir; `~/.chorus/plugin/` is disjoint enough.
