# Proposal: daemon.json field-level merge (stop clobbering cwds / yoloAckAt)

## Why

Setting up `chorus daemon` as a boot-time service (systemd user unit + linger) on EC2 surfaced a data-loss root cause: **every write to `~/.chorus/daemon.json` is a whole-file overwrite, not a field-level merge.**

Reproduction:

1. `~/.chorus/daemon.json` originally held only `{ cwds: [...], yoloAckAt: "..." }` (credentials lived in shell env / `~/.zshrc`).
2. The systemd unit does not source `.zshrc`, so the daemon could not resolve credentials and crash-looped.
3. To persist credentials to disk, the operator ran `chorus login --url ... --api-key ...`.
4. **`chorus login` overwrote the entire file with `{ url, apiKey, agentUuid, agentName }`, destroying the pre-existing `cwds` and `yoloAckAt`.**
   - Losing `yoloAckAt` → the next foreground run re-prompts the one-time YOLO confirmation.
   - Losing `cwds` → unless the unit's `--cwd` flag backstops it, the daemon falls back to serving only its process cwd.

The operator had to hand-merge `cwds`/`yoloAckAt` back with a Node script. A normal user would not.

The code audit found **two** whole-file overwrite sites, not one:

- `cli/login.mjs` `writeLoginFile()` — the `chorus login` write (and it currently, by design, drops `yoloAckAt`).
- `cli/daemon.mjs` `preflight()` — the daemon's TTY interactive credential-completion path calls the same `writeLoginFile()`, so it clobbers `cwds`/`yoloAckAt` identically.

A correct read→merge→write template already exists in `recordYoloAck()` (`cli/login.mjs`) — but it is not atomic and is not reused by the other writers.

The audit also confirmed (elaboration q4) that on the **plugin** side `~/.chorus/state.json` is already safe: the Claude Code plugin's `chorus-api.sh` serializes every write with `flock` + `jq` merge, and the Codex plugin is stateless. No plugin change is required — only that the audit be recorded.

## What Changes

- **New shared merge helper `updateDaemonConfig(partial)`** (elaboration q3) — a single read→merge→write(0600) function that reads the existing `~/.chorus/daemon.json`, shallow-merges the caller's partial over it, and writes back with owner-only permissions. It is the one place that knows how to persist the config. `writeLoginFile`, the daemon `preflight` completion path, and the existing `recordYoloAck` are all routed through it.

- **Both whole-file overwrite sites become merges** (elaboration q2 = both):
  - `chorus login` (`writeLoginFile`) merges `{ url, apiKey, agentUuid, agentName }` over the existing file, preserving `cwds`, `sigintTimeoutMs`, and any other future field.
  - The daemon `preflight` TTY credential-completion path merges the just-entered credentials the same way.

- **`yoloAckAt` is always preserved across a `chorus login` / credential write** (elaboration q1 = preserve always). This **intentionally retires** the existing normative behavior "a credential change clears the YOLO acknowledgement" (`daemon-permission-mode` spec). The product decision: a config write must never silently discard the user's recorded YOLO acknowledgement. The `login.mjs` JSDoc and the `daemon-permission-mode` spec are updated to match, so code and spec do not drift.

- **`claude` CLI "NOT FOUND" gets a loud startup warning** (elaboration q5 fold-in + q6 = loud stderr). Today a missing `claude` is shown only as one banner row; the daemon still subscribes and the failure surfaces only when a wake arrives. We add one prominent `⚠` stderr line at startup (parallel to the existing YOLO warning line) so a missing binary is visible in a `systemd journal` immediately. The daemon still starts and subscribes — non-fatal behavior is preserved.

- **Onboarding documentation** (elaboration q5 fold-in): `docs/DAEMON.md` gains an explicit "auto-start on boot requires `chorus login`" note — credentials must be persisted to `daemon.json`, not left only in shell env, because a systemd unit does not source `.zshrc`. It also documents the field-merge guarantee and the `claude` PATH requirement (e.g. `~/.local/bin`).

- **Plugin `state.json` audit recorded** (elaboration q4): the finding that plugin state writes are already flock+jq-merge-safe (no clobber) is captured in the design doc; no code change.

## Capabilities

### Modified Capabilities

- `cli-auth`: the `chorus login` persist requirement and the daemon TTY credential-completion requirement change from "persist `{url, apiKey, agentUuid, agentName}`" (whole-file) to "field-level merge that preserves all other existing fields."
- `daemon-permission-mode`: the "Credential change clears the YOLO acknowledgement" requirement is **removed** — `yoloAckAt` is now always preserved across credential writes.
- `daemon-startup-output`: the `claude` installation detection requirement is extended to also emit one prominent `⚠` stderr warning line at startup when `claude` is not found (banner row alone was insufficient for unattended/systemd visibility).

## Impact

- **Affected code:** `cli/login.mjs`, `cli/daemon.mjs`, `cli/credentials.mjs` (or a new small `cli/daemon-config-write.mjs`) for the merge helper; `cli/daemon-banner.mjs` / `cli/daemon.mjs` startup path for the warning line.
- **Affected tests:** `cli/__tests__/login.test.mjs`, `daemon-credential-completion.test.mjs`, `daemon-banner.test.mjs`, plus new merge-helper tests.
- **Affected docs:** `docs/DAEMON.md`.
- **Behavior change (intentional):** re-login no longer re-prompts the YOLO confirmation, because `yoloAckAt` is preserved.
- **No schema / DB / API changes.** This is entirely CLI-local file I/O.
- **Out of scope:** plugin-side `state.json` (audited, already safe); `state.json`/`sessions.json` clobber concerns on the CLI side (the CLI writes neither — `sessions.json` was already removed per the lineage-anchored session change).
