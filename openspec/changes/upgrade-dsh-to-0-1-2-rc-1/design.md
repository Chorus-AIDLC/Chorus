# Technical Design: Upgrade dsh to 0.1.2-rc.1

## Overview

The load-bearing upstream change between `dsh-v0.1.0-rc.7` and `dsh-v0.1.2-rc.1` is the **"single dsh application launcher"** consolidation. The standalone SDK-runtime binary `dsh-jsonrpc-agent` and its `DSH_CORDIS_CONFIG` env contract were removed; the SDK runtime is now the `dsh` CLI's `sdk` profile, launched as `dsh --profile sdk [--patch <file>]` with `DSH_HOME` set. Everything else our integration touches — the JSON-RPC wire, the usage shape, the four peer plugins' public config, and the seven Cordis lifecycle events our plugin hooks — is unchanged. This design is grounded in a version-diff audit of the two tags in the local upstream mirror.

## Audit findings (rc.7 → 0.1.2-rc.1)

**Verdict: GO-WITH-CHANGES** — one launch-model rewrite (blocker-class), low protocol risk.

| Surface | Changed? | Impact | Adaptation |
|---|---|---|---|
| JSON-RPC wire (`initialize`→`serverInfo.name:"deepseek-harness-sdk-runtime"`, `session/prompt`→`messageId`, `session.event`/`session.status`, `status:"idle"`, `assistant/message` `data.usage`) | No | Compatible | None |
| Usage fields (`inputTokens`/`outputTokens`/`cacheReadTokens`/`cacheWriteTokens`, camelCase) | No | Compatible | None |
| `dsh-jsonrpc-agent` binary | **Removed** | Launch can never resolve the runtime | Resolve `dsh` CLI / prebuilt `deepseek-harness-sdk-runtime-*` exe |
| `DSH_CORDIS_CONFIG` env + full `cordis.yml` launch | **Removed** | Config channel gone | `--profile sdk` + `DSH_HOME` + `--patch` overlay |
| Demo runtime packages `dsh-agent-spine-demo`, `dsh-sdk-jsonrpc-demo` | **Removed** | Managed install references dead packages | Install `@deepseek-ai/dsh` (carries base + sdk-app + peers) |
| 4 peer plugins (`dsh-mcp-client`, `dsh-persona` inline `text`, `dsh-skill-filesystem` `customSkillDirs`, `dsh-tool-skill`) | No | Compatible | Version-pin bump only |
| 7 Cordis lifecycle events + `agent.steer` (`packages/chorus-dsh/src/index.ts`) | No | Compatible | Build/typecheck verify only |
| Native deps (`koffi`, `node-pty`, `@vscode/ripgrep`) | Persist | `external_runtime` still required | No bundling |
| Resume wire | Absent (as rc.7) | Per-wake fresh session still correct | None |

Key citations — dsh repo (`/home/ubuntu/dev/deepseek-harness` @ `dsh-v0.1.2-rc.1`): `packages/sdk/server/src/server.ts` (methods + `serverInfo.name`), `packages/sdk/protocol/src/types.ts` (notification map), `packages/llm/llm/src/types.ts` (`TokenUsage` camelCase), `packages/boot/app-boot/src/profile.ts` (`PROFILE_TEMPLATES.sdk`), `packages/bundle/sdk-app/{package.json,cordis.patch.yml}`, `apps/cli/src/{args.ts,profile-boot.ts,bin.ts}`, `.agents/notes/.../2026-08-11-rename-ledger.md` (removed packages). Chorus repo: `cli/dsh-spawner.mjs`, `cli/dsh-managed-config.mjs`, `packages/chorus-dsh/{package.json,cordis.patch.yml,src/index.ts}`, `cli/upload-hooks.mjs`.

### Tag-anchored verification (dsh-v0.1.2-rc.1)

The local working tree is still checked out at rc.7, so a reader without git access sees `PROFILE_TEMPLATES={web,headless}` and no `sdk-app` — that is the **rc.7** state, not the target. The launch-model claims below were verified directly against the `dsh-v0.1.2-rc.1` tag (`git show dsh-v0.1.2-rc.1:<path>`):

- **`sdk` profile template exists** — `packages/boot/app-boot/src/profile.ts:150-153`:
  `sdk: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'], patchReload: 'startup' }` (alongside `acp`/`web`/`headless`/`sdk-minimal`).
- **`@deepseek-ai/dsh-sdk-app` bundle exists** — `packages/bundle/sdk-app/{package.json,cordis.patch.yml,src/index.ts,...}`; package name `@deepseek-ai/dsh-sdk-app`.
- **The wire is mounted by the sdk-app patch** — `packages/bundle/sdk-app/cordis.patch.yml` inserts `id: sdk-app-startup` **and** `id: sdk-jsonrpc-server` (`name: '@deepseek-ai/dsh-sdk-jsonrpc-server'`, "Stdout belongs exclusively to JSON-RPC"). So `dsh --profile sdk` → `dsh-base` + `dsh-sdk-app` → sdk-app's patch mounts `dsh-sdk-jsonrpc-server`, which is the JSON-RPC runtime Chorus consumes.
- **`dsh-jsonrpc-agent` is removed** — absent from `git ls-tree -r dsh-v0.1.2-rc.1`.
- **`dsh plugin --profile <name> add <package>`** is the real add mechanism — `profile.ts:814` error string.

> **Hallucination guard:** the exact `--profile` / `--patch` flags, the precise install list that makes the `sdk` profile resolve `dsh-base` + `dsh-sdk-app` + `dsh-sdk-jsonrpc-server`, and `dsh plugin add` semantics MUST still be re-confirmed against the pinned `dsh-v0.1.2-rc.1` source while coding — the tag evidence above establishes the model exists, but the implementer owns the exact CLI surface. Do not rely on LLM memory.

## Architecture

### Launch (cli/dsh-spawner.mjs)

- **Bin resolution**: replace the `dsh-jsonrpc-agent` name list with `dsh` (`dsh` / `dsh.cmd` / `dsh.exe`) resolved from `CHORUS_DSH_PATH` or `PATH`; optionally fall back to a prebuilt `deepseek-harness-sdk-runtime-<platform>-<arch>` exe if present.
- **Spawn argv**: `dsh --profile sdk [--patch <chorus-patch>]` with `DSH_HOME` and existing DeepSeek/Chorus creds in the child env. The Cordis patch path is now legitimate argv (was previously forbidden as "config path in argv" under the removed env-config model).
- **Unchanged**: NDJSON JSON-RPC framing, the `deepseek-harness-sdk-runtime` `serverInfo.name` identity check, `initialize`/`session/prompt`/`shutdown` sequence, `session.status:"idle"` terminal wait, `dsh.turn.completed` emit + camelCase usage aggregation, detached spawn + process-group SIGTERM/SIGINT interrupt.

### Managed composition (cli/dsh-managed-config.mjs)

- Pick a managed `DSH_HOME`; let `dsh --profile sdk` initialize the shipped `sdk` template (`@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-sdk-app`, `patchReload: startup`). `dsh-sdk-app`'s own `cordis.patch.yml` mounts `@deepseek-ai/dsh-sdk-jsonrpc-server` — the JSON-RPC runtime that owns stdout and is the wire Chorus consumes.
- Add the Chorus bundle: `dsh plugin --profile sdk add @chorus-aidlc/chorus-dsh` (or list it in the profile's `dsh.profile.bundles`); supply the Chorus rows via the bundle's shipped `cordis.patch.yml` overlay.
- The managed install must make the `sdk`-profile packages (`dsh-base`, `dsh-sdk-app`, `dsh-sdk-jsonrpc-server`) and the four Chorus-used peers resolvable from the managed `DSH_HOME`; only `@chorus-aidlc/chorus-dsh` is Chorus-owned. T2 verifies the exact install set against the pinned tag (do not assume `@deepseek-ai/dsh` alone transitively pulls every one).
- **Remove**: `CONFIG_HEAD` cordis.yml, `DSH_CORDIS_CONFIG`, the `dsh-jsonrpc-agent` runtimePath, and the dead demo packages from `RUNTIME_PACKAGES`.
- `validateManagedDshComposition`: drive `dsh --profile sdk` over stdin (`initialize`) instead of the removed bin, and assert the composed profile boots before atomically activating.

### Version pins

- `DSH_RC_VERSION` → `0.1.2-rc.1` (managed-config cache-key/default, not a runtime lock — external_runtime).
- **`packages/chorus-dsh/package.json` — split "supported" vs "developed-against" (deliberately lenient about dsh versions):**
  - **peerDependencies = lenient range `>=0.1.2-rc.1`** (was `^0.1.2-rc.1`). The plugin depends only on stable dsh APIs (lifecycle events / MCP client / persona / skills) unchanged across the 0.1.x line, so it should NOT pin a tight upper bound — dropping the caret's implicit `<0.2.0` lets it accept current + all future stable dsh without a re-pin. (Semver prerelease matching still can't express "any future prerelease at a new tuple" in a range string; making peers optional was rejected because `dsh plugin add` must auto-install `dsh-mcp-client` for the composition. If broader prerelease tolerance is needed, revisit optional peers + a base-provided fallback.)
  - **devDependencies stay EXACT `0.1.2-rc.1`** (+ `@deepseek-ai/cordis` `4.0.2`) — what we build/test against, pinned for reproducibility. Separate from the supported range.
- **`check-dsh-contract.sh` no longer pins an exact dsh commit.** It verifies the *contract* (the lifecycle events chorus-dsh observes still exist) against a configurable `DSH_CONTRACT_REF` (default `dsh-v0.1.2-rc.1`, overridable) rather than asserting `HEAD == <exact sha>` — version-tolerant, and no re-pin needed each dsh release.

## Module Contracts

- **Spawner → daemon**: unchanged. `DshSpawner` still emits `dsh.turn.completed` frames with the shared normalized camelCase usage fields and `source:"dsh"`; `onChild` still exposes the runtime process group for interrupt. `cli/upload-hooks.mjs` `extractDshTurnUsage` consumes that internal frame and needs no change.
- **Managed config → spawner**: the composed `DSH_HOME` + `sdk` profile is the new contract replacing the generated `cordis.yml` + `DSH_CORDIS_CONFIG` path.

## Implementation Plan

1. Update the dsh baseline (install 0.1.2-rc.1, pin checkout, bump version pins, verify `chorus-dsh` builds against new peers).
2. Rewrite the launch + managed composition to the `--profile sdk` model, keeping all wire handling; update unit suites.
3. Local E2E on `pnpm dev:local`: registration, one turn, interrupt, restart continuity; redacted acceptance report.

## Risks & Mitigations

- **Precise CLI surface drift** — the `--profile`/`--patch`/`dsh plugin add` semantics must match rc.7→0.1.2 exactly. *Mitigation:* re-verify against pinned source; local E2E is the real proof gate.
- **Provider adapter** — new `initialize` auto-mounts the DeepSeek adapter only for `provider === "deepseek-official"`. *Mitigation:* default works unchanged; if `CHORUS_DSH_PROVIDER` is non-default, include a matching `llm-*` row in the patch.
- **native-dep availability on the daemon host** — the runtime still needs `node-pty`/ripgrep sidecars. *Mitigation:* `external_runtime` posture — dsh is installed by the operator; the spawner fails visibly with an actionable diagnostic if the bin is absent.
- **No merge/publish gate** — changes ride the shared dsh working tree; human-gated at integration.
