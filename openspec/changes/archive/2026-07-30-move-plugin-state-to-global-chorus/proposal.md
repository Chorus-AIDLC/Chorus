# Move Claude Code plugin local state to global `~/.chorus/plugin/`

## Why

The Claude Code plugin writes its hook coordination state into a `.chorus/` folder **inside every project working directory** (`bin/chorus-api.sh:17` — `STATE_DIR="${CLAUDE_PROJECT_DIR:-.}/.chorus"`). Consequences:

- Every new project that an agent touches grows its own `.chorus/` directory that must be `.gitignore`d and cleaned up separately — friction the owner explicitly wants gone.
- It diverges from the **daemon**, which already keeps all of its state under a single user-global `~/.chorus/` (`daemon.json`, `daemon.pid`, `codex-sessions.json`, …). Two different conventions for "where Chorus keeps local state" is confusing.

Crucially, this folder holds **only hook-to-hook scratchpad state** — session UUID mappings, a cached owner/permissions blob, an opportunistically-cached `project_uuid`, the `pending/`→`claimed/`→`sessions/` sub-agent handoff files, and MCP-handshake temp files. It is **not** credentials, and it is **not** a project↔directory binding. Project scoping is entirely server-side (the `X-Chorus-Project` header in `.mcp.json` / explicit `projectUuid` tool arguments). So relocating the folder loses no association logic — it is a pure move.

## What Changes

- **New shared path module** `bin/chorus-paths.sh`, sourced by `chorus-api.sh` and every state-touching hook. It is the single source of truth for:
  - the global root `~/.chorus/plugin/`,
  - the human-readable `<cwd-slug>` derived from the project directory (mirrors Claude Code's own `~/.claude/projects/-home-ubuntu-dev-ai-pm` encoding — `/` → `-`, **not** a hash),
  - the per-session partition `<cwd-slug>/<sessionId>/`.
- **`chorus-api.sh`** resolves `STATE_DIR` / `STATE_FILE` / `SESSIONS_DIR` from `chorus-paths.sh` using a `CHORUS_SESSION_ID` exported by the calling hook, instead of the hardcoded `${CLAUDE_PROJECT_DIR}/.chorus`.
- **Every hook that touches STATE_DIR** extracts the Claude Code `session_id` from its stdin payload and exports `CHORUS_SESSION_ID` before invoking `chorus-api.sh` or building `pending/`/`claimed/`/`sessions/` paths, so all hooks in one CC session resolve to the same session directory. This set is broader than the sub-agent-lifecycle hooks: it also includes `on-teammate-idle.sh` and `on-task-completed.sh` (which read the `session_<key>` mappings written by `on-subagent-start.sh` — a miss here would silently break teammate heartbeats and auto-checkout) and `on-post-verify-task.sh` (whose `mcp-tool` calls write handshake temp files under STATE_DIR). Hooks that only emit `hook-output` (`on-post-submit-proposal.sh`, `on-post-submit-for-verify.sh`, `on-pre-enter-plan.sh`, `on-pre-exit-plan.sh`) never reach `ensure_state`, so they are correctly untouched.
- **`on-session-end.sh`** `rm -rf`s only the current session's directory (`~/.chorus/plugin/<cwd-slug>/<sessionId>/`), preserving the existing "clean up on end" semantics without touching sibling concurrent sessions on the same project.
- **Docs** (`docs/chorus-plugin.md` and the two plugin blog posts) updated to describe the global layout.

Explicitly **out of scope** (per elaboration): no migration of pre-existing per-project `.chorus/` folders (they are left in place, already gitignored); no cross-session shared files or global locks; no changes to Codex/OpenClaw/Kiro plugins (they write nothing to disk). A crash-leftover mtime sweep is noted as a nice-to-have, not built.

## Capabilities

- **plugin-local-state** — where and how the Claude Code plugin stores its hook coordination state, its partitioning scheme, cleanup, and fail-soft guarantees.

## Impact

- **Affected code:** `public/chorus-plugin/bin/chorus-api.sh`, `bin/chorus-paths.sh` (new), `bin/on-session-start.sh`, `bin/on-session-end.sh`, `bin/on-subagent-start.sh`, `bin/on-subagent-stop.sh`, `bin/on-pre-spawn-agent.sh`, `bin/on-user-prompt.sh`, `bin/on-teammate-idle.sh`, `bin/on-task-completed.sh`, `bin/on-post-verify-task.sh`, `bin/test-syntax.sh`.
- **Affected docs:** `docs/chorus-plugin.md`, `docs/blogs/building-claude-code-plugin-for-agent-teams.md`, `packages/landing/src/content/blog/claude-code-vs-codex-plugin-systems.md`.
- **Behavioral risk:** the plugin's own session lifecycle. Fully mitigated by fail-soft design — any path-resolution or session-id failure falls back to a safe default and NEVER aborts a hook (hooks already `exit 0` on error; this change keeps that contract). This is the owner's hard constraint: script/session-file failures must not block the development flow.
- **No user-data migration, no DB, no API surface change.** `.gitignore`'s `.chorus/` entry stays (still valid for any residual per-project folders).
- **Cross-platform:** Bash 3.2 compatible (macOS), pure shell + `jq`/`sed` fallbacks — no new dependencies.
