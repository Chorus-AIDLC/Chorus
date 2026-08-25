# Unify agent management under `chorus agents` (retire `chorus init`)

## Why

The `chorus` CLI grew a `chorus agents` command (list the agents configured in `~/.chorus/daemon.json`). Agent *configuration* still lives under a separate top-level verb, `chorus init`. Two entry points for one concept (managing which agents this machine serves) is confusing and undiscoverable. Since `0.17.0` is **unreleased**, `chorus init` has zero released users — we can consolidate now with no back-compat cost.

## What Changes

- **Retire `chorus init`; rename the entry to `chorus agents add`.** Same detect/install/seed(+daemon-setup) flow and the same flags (`--agents`/`--all`/`--url`/`--api-key`/`--yes`/`--dsh-profile`/`--daemon-wake[-all]`). Internal `cli/init/` modules and `runInit` are unchanged — only the subcommand route and user-facing strings move.
- **Add `chorus agents remove <name|uuid>`.** Removes the matching `agents[]` entry from `~/.chorus/daemon.json` (merge-safe write preserving every other agent + field). Ambiguous name → error; no match → non-zero exit listing the configured agents. `$DSH_HOME/.env` (a single shared url+key, not per-agent) is left untouched with a printed note.
- **`chorus agents` (no sub-verb)** keeps listing configured agents (unchanged).
- **New standalone `chorus-cli` skill** across all six plugin surfaces: concise teaching of install (`npm install -g @chorus-aidlc/chorus@0.17.0`), configure (`chorus agents add` / `remove` / list + `daemon.json`), env vars (`CHORUS_URL` / `CHORUS_API_KEY` / `CHORUS_AGENT_PROFILE`), and MCP operations (`chorus mcp call/whoami/list`, `--arg-file`, `--agent`). `openspec-aware` §2 references it.
- **Sweep every user-facing `chorus init` → `chorus agents add`**: in-app Install Guide + i18n (en/zh/ja/ko), `CONNECT_*.md(.zh)`, READMEs, `MCP_TOOLS.md`, the deprecation stubs (`install-*.sh`, `dsh-credentials.sh`), the kiro `.kiro` manifest, per-surface `chorus/SKILL.md`, the on-session-start banners, and `CHANGELOG`.

## Impact

- Affected specs: `chorus-init` (command rename; new remove/list requirements), `chorus-cli-bootstrap-migration` + `agent-install-guide` (product-facing command sweep + `chorus-cli` skill).
- Affected code: `chorus.mjs` (dispatch), `cli/agents.mjs` (add/remove/list routing), `cli/init*` (help strings only), UI/i18n/docs/skills/stubs as above. `cli/init/` internals + `runInit` behavior unchanged.
- Unreleased (0.17.0) → hard rename, no alias. OpenSpec `archive/` is immutable and untouched.
