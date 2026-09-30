## Context

The repository already separates client commands from server boot in `chorus.mjs`. `cli/init.mjs` handles per-agent updates and summaries [1](ref:1f297cca-b904-4bbb-afc6-6e6b27be2d33); `cli/init/install-methods.mjs` contains host-specific installers [2](ref:73981e87-071d-4d91-bd92-9d9479f36a6d). Existing selection mappings collapse opencode/openclaw/dsh into offline [3](ref:9ecec3ea-e6f4-4b02-8193-698ae9e2f931). These references belong to the originating Idea.

The new command must not invoke the whole agents-add orchestrator, which seeds credentials and configures the daemon.

## Decisions

### CLI entry and installation identity

Add both verbs to the client router before server boot. A pure, dependency-injected `runUpgrade(argv, deps)` returns an exit code. Parse only `--plugins`, `--help`/`-h`; reject unknown flags/positional arguments before any mutation. Help does not probe npm, credentials or agent state.

Support npm global installations only. Obtain the active npm global root/prefix with bounded read-only npm commands; compare the current module package root with the canonical package location for `@chorus-aidlc/chorus`. Reject source/link/npx/other-package-manager locations and ambiguous provenance. Realpath equality alone must not mistake an npm-linked source tree for a registry installation: reject a symlinked package directory. Inability to establish ownership produces guidance and a nonzero status without installation.

Read `@chorus-aidlc/chorus` latest metadata using npm's existing registry configuration. Require a valid stable version; do not downgrade if the local stable version is newer. Use argument arrays without a shell, a fixed package name, bounded query execution and the same npm prefix used for identity checks. Install the resolved latest version, then read the installed package metadata to verify the expected version. Clearly distinguish check/install/verification failures. Never claim success from a subprocess exit code alone.

Capture/import plugin collaborators before npm replaces the running package, avoiding lazy imports from a half-replaced installation. Default mode must not read daemon configuration or invoke plugins. Already-current CLI remains a successful prerequisite for requested plugin updates.

### Config and target selection

Read the existing `~/.chorus/daemon.json` location using repository conventions and injectable filesystem IO. Missing configuration means no configured plugins and an explicit successful no-op; malformed/unreadable configuration is a failure, never silently treated as empty. A valid empty `agents` list is a no-op. Support the legacy single-agent shape and explicit top-level agent defaults consistent with daemon semantics, without inventing a host for absent type information.

Consider every configured row regardless of `daemonWake`; explicitly typed claude-code/claude, codex, kiro, pi are targets. Offline/unknown/missing type rows are skipped with a reason. Reject or report malformed rows individually. Use only necessary public fields (type/name/id/source URL), never log API keys or whole config/child environments.

Resolve each record’s effective environment using the same validated per-agent overlay as daemon spawning (including legacy flat env), before binary detection, state reads, target selection and execution. Respect HOME/USERPROFILE, CLAUDE_CONFIG_DIR, CODEX_HOME, KIRO_DIR, PI_CODING_AGENT_DIR and configured PATH; do not forward session args to package-management commands. Deduplicate per actual host installation destination under that effective environment, never merely by agent type. Two same-type records with distinct homes must both be refreshed; shared destinations are refreshed once. Multiple rows sharing a host home execute once and their association remains visible in the summary. No cwd-scanning or project plugin discovery. For Kiro, use the configured Chorus instance as the template source; conflicting URLs for a shared Kiro destination must be reported as incomplete, rather than arbitrarily selecting one.

### Plugin execution

Use adapter state/detection and narrowly scoped installation helpers. Require the actual host binary (including `kiro-cli`) before invoking installation; config-directory presence alone is insufficient. Pass noninteractive options already supported by the host; never initiate login, prompts, credential seeding or daemon setup.

Claude and Codex use their existing Chorus-specific update/install paths. Ensure fresh install and update contexts include the correct install state and per-record effective home/config/PATH overrides. Do not change other MCP credentials or unrelated host settings. Preserve unrelated settings when a necessary Chorus-specific config/template update is performed.

Kiro refreshes Chorus template assets from its configured instance, with existing merge/backup semantics; this is the latest served by that instance, not a promise of npm/server version parity.

Pi's existing `pi update --extensions` affects unrelated extensions and is forbidden here. Current official source and locally installed help document `pi update --extension <source> --no-approve` for one package while ignoring project-local settings [4](ref:745bfec8-0cda-42ba-ae15-36536df4d973). Probe the installed command help noninteractively for support before using this path; preserve the explicit unsupported fallback for older versions. A verified targeted update is acceptable; absent that evidence, report existing Pi plugins as unsupported for targeted update (incomplete). Missing Chorus/required adapter packages can be installed individually using the existing named-package install path, preserving unrelated packages and without first invoking all-extension update. Partial Pi installs must not be misreported as fully refreshed if an existing required component was not updated. Pi preserves pinned versions, ranges and non-latest tags; detect these configured constraints in both string and object package entries, report incomplete and continue other eligible components. Unconstrained sources and explicit @latest tags remain eligible. This avoids the native successful-no-op behavior confirmed during task review.

### Results and control flow

1. Parse/help.
2. Establish npm installation identity and discover latest stable version.
3. Upgrade CLI if older and verify; failure stops further work.
4. If `--plugins`, read configuration, build unique targets and execute sequentially. Catch each target failure and continue.
5. Print concise CLI version/result and per-target success/failure/skip summary; print daemon restart/new-session guidance if files changed.

Use a consistent structured result such as `{target, action, detail, complete}` internally. Exit 0 only when all requested eligible operations completed. Missing/empty config and duplicate rows are successful no-ops; offline/unknown records, missing hosts, conflicting destinations, unsupported targeted updates and failures are visible incomplete outcomes and cause exit 1. This concretizes the human's “未全部完成时返回非零” choice. There is no rollback; completed updates remain.

Do not restart the daemon, kill processes, change stored credentials or reveal secrets. Query and plugin subprocess timeouts prevent hanging probes. Per the user-authorized post-delivery review, npm self-install uses an asynchronous runner without an automatic timeout or kill, streaming sanitized complete lines until npm exits. Child diagnostics retain sanitized stderr tails and exit codes/signals; installer details remain visible and npm permission failures explain user-owned Node/admin options. Streaming holds partial lines for redaction and discards overlong lines. Backups overwrite one .chorus-upgrade.bak per config file.

## Module Boundaries

- `chorus.mjs`: route verbs and root help.
- `cli/upgrade.mjs` (optionally smaller sibling modules): pure parsing, npm provenance/version operation, orchestration, summary.
- `cli/upgrade-plugins.mjs`: optional read-only daemon config resolution, deduplication, scoped plugin execution. Existing adapters may gain an explicit scoped-update option only if necessary; agents-add behavior must remain compatible.
- `cli/__tests__/upgrade*.test.mjs`: injected subprocess/filesystem tests and entry subprocess checks.
- `README.md`, `README.zh.md`: command examples, npm restriction, result semantics, scope limitations and restart guidance.

One cohesive implementation task owns this feature including tests and documentation; no artificial dependency chain.

## Validation

Use temporary filesystem fixtures and fake command runners for upgrades; never upgrade this development machine or touch its real daemon config. Include npm provenance/link/prefix mismatch, stable/latest validation, current/newer version, failure/timeout/post-install mismatch, alias/help/no-server-start, opt-in isolation, invalid config/empty config, offline/missing host, duplicate targets, same-type distinct homes, shared homes, per-record PATH-only binaries, legacy flat env, Windows npm shim/layout/path handling, Kiro URL collision, absent plugin install, Pi isolation and credential redaction. Run related CLI regression tests and packaging inclusion checks. Independent task review and aggregate code review precede completion.

## Risks and Limits

Different package managers may share layouts; unsupported or ambiguous installations must fail with guidance. npm replacement can leave a failed installation partially changed, and rollback is not promised. Native host CLIs may evolve; verify changed command signatures against installed help/source or official documentation, attach newly used evidence, and use explicit unsupported outcomes if narrowly scoped updating cannot be verified. The npm-global path must support Linux x64/arm64, macOS x64/arm64 and Windows. Implement and test Windows npm executable/shim resolution, prefix layout, spaces in paths and shell-safe argument passing; do not reject Windows globally. Prefer resolving npm-cli.js and invoking it with Node where direct npm.cmd launch is unsuitable. Host command launching must also handle supported platform executable forms safely.
