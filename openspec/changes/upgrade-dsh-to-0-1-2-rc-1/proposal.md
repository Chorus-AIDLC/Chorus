# Upgrade dsh to 0.1.2-rc.1 and adapt the daemon launch model

## Why

Chorus's DeepSeek Harness (`dsh`) integration is pinned to `dsh-v0.1.0-rc.7` (local checkout `/home/ubuntu/dev/deepseek-harness` @ `99f6f02f`; `packages/chorus-dsh` peerDeps `^0.1.0-rc.7`). Upstream has since shipped `rc.8 → 0.1.1-rc.1/rc.2 → 0.1.2-alpha.1–5 → 0.1.2-rc.1` (npm `latest`), with `master` at `0.1.3-alpha.1`. Our integration is several releases behind, and dsh daemon wake was previously parked at live E2E.

A grounded audit of `dsh-v0.1.0-rc.7 → dsh-v0.1.2-rc.1` (see design.md) found the JSON-RPC wire protocol, usage shape, peer-plugin config, and Cordis lifecycle events are **all unchanged and compatible** — but upstream **removed the standalone `dsh-jsonrpc-agent` binary and the `DSH_CORDIS_CONFIG` env contract**, consolidating the SDK runtime into the `dsh` CLI's new `sdk` profile (`dsh --profile sdk [--patch <file>]`). Chorus's daemon launch (`cli/dsh-spawner.mjs`) and managed composition (`cli/dsh-managed-config.mjs`) are built entirely around the removed model, so a dsh wake on 0.1.2-rc.1 can never locate a runtime today.

## What Changes

- **Update the dsh baseline to 0.1.2-rc.1**: upgrade the installed runtime, pin the local `deepseek-harness` checkout to tag `dsh-v0.1.2-rc.1`, bump `DSH_RC_VERSION` and `packages/chorus-dsh` peer/dev version pins from `^0.1.0-rc.7` to `^0.1.2-rc.1`.
- **Rewrite the daemon launch to the `dsh --profile sdk` model**: resolve the `dsh` CLI (or an equivalent prebuilt SDK-runtime executable) instead of the removed `dsh-jsonrpc-agent`; launch via the `sdk` profile with a Chorus-supplied Cordis `--patch` overlay and a managed `DSH_HOME`; drop the removed `DSH_CORDIS_CONFIG`/`CHORUS_DSH_CONFIG` env channel. Keep every JSON-RPC handling path, the `deepseek-harness-sdk-runtime` identity check, the `session.status:"idle"` completion wait, the `dsh.turn.completed` emit, the camelCase usage map, and the process-group interrupt exactly as-is (the wire is identical).
- **Rewrite the managed composition** (`cli/dsh-managed-config.mjs`) to build the `sdk` profile — install `@deepseek-ai/dsh` + `@chorus-aidlc/chorus-dsh`, apply Chorus rows via the bundle patch — and remove the dead demo runtime packages (`@deepseek-ai/dsh-agent-spine-demo`, `@deepseek-ai/dsh-sdk-jsonrpc-demo`) that upstream deleted.
- **Prove daemon wake via local E2E** on `pnpm dev:local`: registration, one full turn (transcript + one `source=dsh` usage), interrupt, and restart continuity (fresh backend id settles terminal, no 409 — the per-turn backend-id fix already landed).

### Capabilities

- **daemon-dsh-backend** (MODIFIED + ADDED): the external runtime discovery requirement is rewritten to the `dsh --profile sdk` launch model; a new requirement pins the managed `sdk`-profile composition and the removal of the dead demo packages. All wire-protocol, event-boundary, and usage requirements are unchanged.

## Impact

- **Code**: `cli/dsh-spawner.mjs` (launch/bin resolution — blocker), `cli/dsh-managed-config.mjs` (composition + version pin — blocker), `packages/chorus-dsh/package.json` (peer/dev pins). No change to `cli/upload-hooks.mjs` (usage frame contract is Chorus-internal and unchanged) or `packages/chorus-dsh/src/index.ts` (lifecycle events unchanged — verify build only).
- **Runtime posture**: unchanged — `external_runtime` confirmed. dsh 0.1.2-rc.1 still pulls native deps (`koffi`, `node-pty`, `@vscode/ripgrep`), so Chorus continues to rely on a user-/host-installed dsh rather than bundling the runtime.
- **Session resume**: unchanged — the audit confirmed the SDK still exposes **no** resume/continue wire (`initialize` / `session/prompt` / `shutdown` only), so the per-wake fresh-session model remains correct.
- **Delivery**: rides the existing shared dsh working tree; no merge/push/publish without explicit human approval. Local E2E requires the owner to start `chorus daemon --agent dsh` with a real DeepSeek key.

## Out of Scope

- Bundling / managing the dsh runtime ourselves (owner chose `keep_external`).
- Native dsh session resume (no wire exists; per-wake retained).
- Deploying dsh registration to the live instance (owner chose local E2E; live deploy remains a separate integration/deploy step).
- Advancing past `0.1.2-rc.1` to `0.1.3-alpha.x` (baseline fixed at the npm `latest` rc).
