## Why

The current dsh integration distributes Chorus-owned runtime, skills, instructions, and configuration by downloading server artifacts and copying them into `$DSH_HOME`. DeepSeek Harness already supports npm bundle packages, so Chorus should use that native distribution path and eliminate the duplicated installer, server artifact, named preset, and user-home mutation model before the integration is released.

## What Changes

- Publish `@chorus-aidlc/chorus-dsh` as a public, self-contained dsh bundle package with `dsh.bundle.patch`, bundled runtime code, packaged Chorus skills, inline persona/instructions, no native dependencies, and explicit peer dependencies on the four dsh plugins mounted by name.
- Make `dsh plugin --profile <name> add @chorus-aidlc/chorus-dsh` the interactive installation path; dsh and pnpm are prerequisites, credentials default to `CHORUS_URL` and `CHORUS_API_KEY`, and values may be overridden through plugin configuration.
- Replace the copied named Chorus preset with bundle-level composition that mounts the MCP client, lifecycle plugin, filesystem skill provider, tool, and inline prompt behavior.
- Add daemon-managed npm package/config preparation for `dsh-jsonrpc-agent`: install the bundle and its four declared dsh peer plugins into the config directory's managed project, resolve the bundle by package name, and fall back to its resolved absolute entry path.
- **BREAKING** Remove `public/install-dsh.sh`, `public/chorus-dsh.mjs`, copied `public/dsh-plugin` delivery, installer tests, and all `$DSH_HOME` write contracts. npm becomes the only supported Chorus plugin distribution path.
- Update onboarding and connection documentation to show environment configuration plus `dsh plugin add`, without a Chorus-hosted download step.
- Verify packed-package contents and both real dsh surfaces against `dsh-v0.1.0-rc.7` / `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`, including check-in, skills/persona, daemon transcript and usage, interruption, zero `$DSH_HOME` writes, and environment-only secret injection.

## Capabilities

### New Capabilities

- `dsh-npm-distribution`: Public npm bundle metadata, package contents, credential configuration, daemon package resolution, and removal of server/home-copy distribution.

### Modified Capabilities

- `dsh-skill-bundle`: Ship and load Chorus skills and prompt behavior from the npm package instead of copied `$DSH_HOME` files and a named preset.
- `dsh-chorus-lifecycle`: Deliver the existing lifecycle runtime through the npm bundle instead of an installer-managed artifact.
- `daemon-dsh-backend`: Prepare and resolve a daemon-owned npm bundle composition while preserving explicit config overrides and the existing JSON-RPC turn boundary.
- `dsh-connection-guide`: Replace installer and managed-home documentation with npm bundle installation and environment credential guidance.
- `agent-install-guide`: Replace the hosted `install-dsh.sh` command with `dsh plugin --profile <name> add @chorus-aidlc/chorus-dsh`.

## Impact

- Package and release: `packages/chorus-dsh`, workspace inclusion, lockfile, build/package checks, npm publication metadata, four dsh peer declarations, and release version synchronization.
- Removed public artifacts: `public/install-dsh.sh`, `public/chorus-dsh.mjs`, `public/dsh-plugin`, and their installer/smoke harnesses.
- Daemon: `cli/dsh-spawner.mjs`, daemon install/config preparation, focused tests, and managed local package/config state under Chorus ownership rather than `$DSH_HOME`.
- UI and docs: `AgentInstallGuide`, locale copy, `CONNECT_DSH` guides, supported-harness references, and related tests.
- External compatibility remains pinned to DeepSeek Harness `dsh-v0.1.0-rc.7` at commit `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`.
