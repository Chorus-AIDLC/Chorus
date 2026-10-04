## Context and scope

The installer runs credential-seed (10), plugin-install (20), then Chorus daemon setup (30). This feature manages the separate Codex local App Server, not Chorus daemon workers. Human answers require confirm-then-restart, defer in unattended installs, and no new verification features.

## Decisions

Add a per-agent step between plugin-install and daemon-setup. Pass completed outcomes through the orchestrator so this step can gate on the Codex credential outcome reporting codexEnvWritten and explicit successful MCP configuration persistence from a nonfailed plugin outcome. A warning-only configuration write failure is not success. No restart after declined repoint, failed persistence/install, or plugin-only mode. Other agents return no additional outcome.

Reuse CODEX_HOME/HOME resolution and parse the persisted dotenv file without shell evaluation. Load only the managed CHORUS_URL, CHORUS_API_KEY, CHORUS_AGENT_PROFILE into a copied child environment; persisted values override stale inherited ones. Require nonempty fields locally; this is not credential validity verification. Preserve unrelated environment settings. Do not mutate process.env, source arbitrary shell code, echo values, or pass tokens on the command line.

Probe `codex app-server daemon restart --help` and `codex app-server daemon version` with timeouts and bounded output. The installed 0.160.0 CLI was inspected read-only: there is no daemon status subcommand; version emits JSON with status=running plus version/backend fields. Recognize only explicit supported running/stopped status shapes. Unknown JSON, unsuccessful probes, unsupported commands, or unrecognized status must not cause restart. Never print raw child output/errors which could contain credentials. No status query may start a service.

For a supported running daemon in a real interactive terminal, prompt once with the interruption warning and [y/N]; only y/yes permits restart. `--yes`, non-TTY, CHORUS_DAEMON_HEADLESS=1, missing ask callback, negative/empty answer defer without prompting. Run the fixed restart command with the managed child environment and bounded timeout. Report only its command result; no follow-up MCP/status/model probe is added. Restart errors become visible failure outcomes without rolling back written config or aborting other agents' steps.

Manual guidance names the actual resolved config directory, warns about interruption, and explains loading the persisted environment before restarting; avoid printing credentials. Users of unknown/older versions are directed to inspect support, not execute a speculative upgrade/restart. An absent daemon remains absent. Keep existing credential validation unchanged and revise optimistic credential-write messaging to distinguish future process startup from currently running sessions.

## Risks and verification of implementation

Runtime changes between status detection and consent cannot be locked by this installer; the operator controls restart and receives the interruption warning. Fail closed on unsupported output instead of using broad process killing. No live restart is used during development or tests. Injectable command/file/prompt seams and temp directories cover fresh credentials vs stale env, paths containing spaces, failure/skip scenarios, isolation of other agents, and no secret leakage from hostile subprocess output. Mock commands prove the command ordering and absence of extra verification calls. No real model calls, provider traffic, or service restart is needed to validate this change.
