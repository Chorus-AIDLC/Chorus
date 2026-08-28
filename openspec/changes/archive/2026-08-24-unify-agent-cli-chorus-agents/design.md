# Design — Unify agent management under `chorus agents`

## Command surface

`chorus agents` becomes a small CRUD group, peer of `daemon` / `login` / `mcp`:

| Command | Behavior |
|---------|----------|
| `chorus agents` (or `agents list`) | List `~/.chorus/daemon.json` agents[] (name, uuid, backend; key never printed; active `CHORUS_AGENT_PROFILE` marked). Unchanged. |
| `chorus agents add [flags]` | Exactly today's `chorus init`: detect → select → install plugin → seed creds (+ optional daemon-setup). Same flags. |
| `chorus agents remove <name\|uuid>` | Remove the matching agents[] entry; merge-safe write; error on ambiguity / no-match. |

`chorus init` is removed from the subcommand set entirely — no alias (unreleased).

## Dispatch (chorus.mjs)

`SUBCOMMANDS` drops `init`, keeps `agents`. `runAgents(argv)` parses argv[0] as a sub-verb:
- `add` → delegate to the existing `runInit(rest, …)` (import `cli/init.mjs`) — zero behavior change.
- `remove` → new `removeAgent(<name|uuid>)`.
- absent / `list` → the existing listing.
- `--help` at any level prints the relevant usage and never boots the server (dispatched before the server-launch path, like `mcp`).

Keeping `runInit` as the implementation means the entire tested `cli/init/` subsystem (detection, steps, credential-seed, daemon-setup) is reused verbatim; only its help/summary strings say `chorus agents add`.

## `chorus agents remove` mechanics

- Resolve the target against each agents[] entry's `agentUuid` / `agentName` (exact). >1 match → error (use the uuid). 0 match → non-zero exit, print the configured agents (reuse the listing).
- Rewrite `~/.chorus/daemon.json` preserving every other agent and all top-level fields (reuse the merge-safe `updateDaemonConfig` writer from `cli/login.mjs`; drop only the matched entry from `agents[]`).
- dsh note: `$DSH_HOME/.env` holds one shared `CHORUS_URL`/`CHORUS_API_KEY` (not per-agent) — leave it, print a one-line note that the operator may clear it manually.
- Pure/dependency-injected (readJson/writeJson/env/stdout/stderr) for unit tests; the key is never printed.

## `chorus-cli` skill

One concise skill per surface (CC/Codex/Kiro/Pi/dsh/OpenClaw), sections: Install / Configure agents (`chorus agents add|remove|list`) / Environment / MCP operations. Registered per surface (auto-discovery on CC + Codex; the npm-package surfaces enumerate skills — update Pi `package.json` + `extensions/chorus.ts`, OpenClaw `package.json`/`openclaw.plugin.json`/`src/commands.ts`(+test), dsh `package.json`, Kiro `.kiro` manifest). `openspec-aware` §2 gains a one-line pointer.

## Doc/spec sweep

Mechanical `chorus init` → `chorus agents add` across all product-facing surfaces (Install Guide + i18n, CONNECT_*, READMEs, MCP_TOOLS, stubs, kiro manifest, per-surface chorus/SKILL.md, on-session-start banners, CHANGELOG). OpenSpec: MODIFIED requirements on `chorus-init` + product-facing deltas; cumulative specs mirrored back to Chorus docs byte-exact on archive. `openspec/changes/archive/**` is immutable — never edited.
