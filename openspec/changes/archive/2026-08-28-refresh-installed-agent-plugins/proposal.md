## Why

`chorus agents add` currently treats an installed plugin as complete, so rerunning it repairs missing configuration but never refreshes skills, hooks, or reviewer agents. Existing users therefore remain on stale plugin bundles unless they learn and invoke each harness's native upgrade mechanism themselves.

## What Changes

- Detect installed Chorus plugins during `chorus agents add` and ask interactive users whether to update them to the latest available release.
- Treat `--yes` as acceptance of the update prompt so explicit non-interactive runs refresh installed plugins without blocking.
- Refresh Claude Code, Codex, opencode, dsh, OpenClaw, and Kiro through their verified native update/reinstall or template-refresh mechanisms.
- Preserve existing idempotent configuration repair, backup, and no-plaintext-key guarantees.
- Continue processing other selected harnesses after an update failure, report each result, and return non-zero when any required refresh fails.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent-plugin-install`: Installed plugins gain a safe latest-version refresh path across all automated harness installers.
- `chorus-init`: Interactive and `--yes` execution semantics now resolve whether installed plugins are refreshed.

## Impact

The change affects `cli/init-args.mjs`, `cli/init.mjs`, `cli/init/install-methods.mjs`, the plugin-install context, and their unit/integration tests. It invokes existing harness package/plugin managers and the existing Kiro template downloader; it adds no runtime dependency and changes no credential storage format.
