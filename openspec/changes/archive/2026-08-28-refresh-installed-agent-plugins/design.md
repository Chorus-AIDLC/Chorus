## Context

The plugin-install step receives one shared `flags` and `io` context and delegates per harness to functions in `cli/init/install-methods.mjs`. Each installer currently short-circuits when `readInstallState()` reports an installed plugin. That presence-based behavior is correct for ordinary repair, but it prevents a Chorus CLI upgrade from refreshing the independently cached plugin surface.

The six automated harnesses expose different refresh mechanisms:

- Claude Code: `claude plugin update chorus@chorus-plugins -y`.
- Codex: refresh the configured `chorus-plugins` marketplace snapshot, then rerun `codex plugin add chorus@chorus-plugins --json`.
- opencode: rerun the global plugin command with `--force`.
- dsh: rerun its profile-scoped package add, which resolves the latest matching package.
- OpenClaw: rerun the npm plugin install after the existing host-version guard, then ensure the plugin is enabled.
- Kiro: rerun the existing file-template downloader, which backs up/merges protected configuration while replacing Chorus-owned assets.

## Goals / Non-Goals

**Goals:**

- Obtain one update decision per `agents add` invocation, after selection and before per-agent installation.
- Prompt only when at least one selected automated harness reports an installed plugin.
- Interpret `--yes` or non-TTY execution as acceptance, matching the existing “skip confirmations” contract.
- Carry a boolean `updateInstalled` intent through the existing step context.
- Refresh all six automated harnesses to their latest available plugin content.
- Preserve per-agent failure isolation, final non-zero status, backups, MCP repair, and credential secrecy.

**Non-Goals:**

- Pin plugins to the local Chorus CLI version.
- Add a standalone `chorus agents update` command or a new update flag.
- Compare semantic versions before invoking native refresh mechanisms.
- Change guided-only harness support or credential/daemon configuration semantics.

## Decisions

### Resolve update intent once in the orchestrator

`runInit` will inspect selected adapters' install state and resolve `flags.updateInstalled` once. An interactive run asks a single yes/no question, defaulting to no; `--yes` and non-TTY runs accept automatically. A single decision avoids six repetitive prompts and keeps installer functions deterministic.

Alternative considered: prompt inside each installer. Rejected because it fragments UX and makes mixed-harness automation harder to reason about.

### Reuse native “latest” behavior instead of version comparison

When `updateInstalled` is true, each installed harness invokes its verified native refresh/reinstall mechanism. The implementation does not compare installed and target versions. Native tools already own marketplace/package resolution, and Kiro's server template endpoint represents the connected instance's current bundle.

Alternative considered: align every plugin to `package.json`'s CLI version. Rejected because the elaborated requirement explicitly chooses latest and several harnesses do not expose a uniform version pinning surface.

### Preserve repair work after refresh

Codex continues normalizing its keyless MCP block after plugin refresh; OpenClaw still enables a disabled plugin; Kiro still merge-preserves `settings/mcp.json`; the rest of the credential and daemon steps run unchanged. Update intent affects only the plugin payload path.

### Treat successful refreshes as repaired outcomes

The existing outcome vocabulary has no `updated` action. A successful installed-plugin refresh returns `repaired` with detail that identifies the refresh command/path. This keeps summary and failure logic compatible while making the action visible.

## Risks / Trade-offs

- [Native reinstall behavior changes across harness releases] → Keep command-shape tests and VERIFIED comments beside every installer; fail visibly when a command exits non-zero.
- [Latest plugin can lead the installed CLI] → This is an explicit product decision; retain MCP/config compatibility repair and make the resolved latest semantics clear in help text.
- [A refresh overwrites user-owned files] → Continue calling existing backup helpers before mutable config operations; Kiro replaces only Chorus-owned template assets and merge-preserves MCP settings.
- [Non-TTY users previously expected a no-op rerun] → Document that `--yes`/non-TTY accepts the update confirmation, and require explicit agent selection as before.
- [One harness update fails] → Preserve per-agent isolation, continue remaining harnesses, summarize failures, and return exit code 1.

## Migration Plan

No persisted-data migration is required. Ship the CLI behavior and tests together. Rollback restores presence-based skips; existing plugin and credential configurations remain valid.

## Open Questions

None.
