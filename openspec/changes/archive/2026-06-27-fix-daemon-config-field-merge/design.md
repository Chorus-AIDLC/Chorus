# Design: daemon.json field-level merge

## Context

`~/.chorus/daemon.json` is the single persisted config file the chorus CLI daemon
owns. It is a flat JSON object that accretes fields from several independent code
paths over time:

| Field | Written by | Read by |
|---|---|---|
| `url`, `apiKey`, `agentUuid`, `agentName` | `chorus login` / daemon TTY completion | `resolveCredentials` (`credentials.mjs`) |
| `yoloAckAt` | daemon yolo TTY confirmation (`recordYoloAck`) | `readYoloAck` (`credentials.mjs`) |
| `cwds` | hand-edited / future tooling | `resolveDaemonCwds` (`daemon-config.mjs`) |
| `sigintTimeoutMs` | hand-edited / future tooling | `resolveSigintTimeoutMs` (`daemon-config.mjs`) |

The readers are already layered and tolerant. The **writers** are the problem:
`writeLoginFile()` serializes only the object it is handed and overwrites the whole
file, so any field written by a *different* path (`cwds`, `yoloAckAt`, …) is lost.

## Goals / Non-Goals

**Goals**
- A single, tested read→merge→write helper that every config writer uses.
- `chorus login` and the daemon TTY credential-completion path preserve all
  non-credential fields (`cwds`, `yoloAckAt`, `sigintTimeoutMs`, …).
- `yoloAckAt` is preserved across credential writes (the q1 product decision).
- A missing `claude` binary is loudly visible at startup, not only when a wake fails.
- Operators learn that boot auto-start requires `chorus login` (persisted creds).

**Non-Goals**
- No cross-process locking of `daemon.json`. `chorus login` and a yolo confirmation
  do not run concurrently in practice (login is an interactive one-shot; the yolo
  ack happens once at daemon start). The audit flagged a theoretical race in
  `recordYoloAck`; we keep the write atomic via temp-file + rename (below) but do
  NOT add `flock`, to avoid a cross-platform dependency (Windows is a target).
- No change to the layered credential *resolution* (readers are fine).
- No plugin-side change (state.json already flock+jq-merge-safe — see Audit below).

## Decisions

### DEC-1 — One shared merge helper, all writers route through it (q3)

Add `updateDaemonConfig(partial, deps?)`:

```
updateDaemonConfig(partial):
  1. read existing daemon.json → current (empty object on missing/unreadable/malformed,
     mirroring readYoloAck's defensive parse — a corrupt file must not block a re-login)
  2. merged = { ...current, ...partial }            # shallow merge; partial wins per key
  3. write merged as pretty JSON + trailing "\n" with mode 0600, via temp-file + atomic rename
  4. return the path written
```

- **Shallow merge is correct here.** Every field is a scalar or a flat array
  (`cwds`); there are no nested objects to deep-merge. `partial` keys overwrite,
  absent keys are preserved.
- **Atomic write:** write to `daemon.json.tmp` (same dir, mode 0600) then
  `rename()` over the target, so a crash mid-write never truncates the live file.
- **`writeLoginFile(data)`** becomes a thin wrapper: `updateDaemonConfig(data)`.
  Its signature and the `deps` injection seams (`path`, `write`, `mkdir`) are kept
  so existing callers and tests need no churn.
- **`recordYoloAck(ts)`** drops its own hand-rolled read-merge and calls
  `updateDaemonConfig({ yoloAckAt: ts })`.
- **`preflight()`** keeps calling `writeCreds(...)`; since `writeCreds` defaults to
  `writeLoginFile`, it now merges automatically. No call-site change beyond the
  helper swap.

### DEC-2 — `yoloAckAt` is always preserved across credential writes (q1)

This is the crux. The current spec requirement **"Credential change clears the YOLO
acknowledgement"** (`daemon-permission-mode`) is satisfied *because* `writeLoginFile`
omits `yoloAckAt`. Once login merges over the existing file, `yoloAckAt` naturally
survives — so the merge change and the "clear on re-login" requirement are in direct
conflict.

Per the elaboration the owner chose **preserve always**: a config write must never
silently discard the recorded acknowledgement. Therefore:

- `login.mjs` no longer special-cases `yoloAckAt`. It merges `{url, apiKey,
  agentUuid, agentName}` and leaves every other field — including `yoloAckAt` — intact.
- The `daemon-permission-mode` spec requirement "Credential change clears the YOLO
  acknowledgement" is **REMOVED** (this change's spec delta).
- The misleading JSDoc block in `login.mjs` (lines describing the intentional
  `yoloAckAt` omission) is rewritten to state the new merge-preserve contract.

Trade-off accepted: swapping the API key / agent on the same machine no longer forces
a one-time YOLO re-confirmation. The owner judged the data-loss footgun worse than the
re-confirm. `--chorus-only` and the per-start non-TTY warning still bound YOLO risk.

### DEC-3 — Loud `claude` NOT FOUND warning, still non-fatal (q5 + q6)

Keep the existing non-fatal contract (the daemon subscribes even without `claude`),
but add visibility: when `resolveClaudePath()` returns null, the startup path emits
**one** prominent `⚠` line to **stderr** (the same channel and style as the existing
YOLO warning at `daemon.mjs`), e.g.:

```
[Chorus] ⚠ claude CLI NOT FOUND on PATH — wakes will fail until you install `claude` or set CHORUS_CLAUDE_PATH (PATH must include e.g. ~/.local/bin).
```

- Emitted once at startup, after the banner, gated on `claudePath === null`.
- stderr so it lands in `journalctl` for the unit even when stdout is captured.
- The banner row ("claude CLI: NOT FOUND …") is retained; the warning line is
  additive. We do NOT take the more aggressive "non-zero exit on non-TTV" option —
  the owner chose loud-stderr to preserve the daemon-still-subscribes guarantee.

### DEC-4 — Onboarding doc: boot auto-start requires `chorus login` (q5)

`docs/DAEMON.md` gets a short "Running on boot (systemd)" subsection covering:
- credentials must be persisted via `chorus login` (a unit does not source `.zshrc`,
  so shell-env-only credentials make the daemon crash-loop);
- the field-merge guarantee (re-running `chorus login` preserves `cwds`/`yoloAckAt`);
- the unit's PATH must include the dir holding `claude` (e.g. `~/.local/bin`), else
  the new NOT-FOUND warning fires and wakes fail.

## Audit: plugin-side state.json (q4) — no change needed

The elaboration expanded scope to verify the plugin's `~/.chorus/state.json`. Audit result:

- Claude Code plugin (`public/chorus-plugin/bin/chorus-api.sh`): `state_set` and
  `state_delete` both run under `flock -w 5` and use a `jq` read-merge-write to a
  temp file followed by `mv` (atomic). Per-key merge means independent hooks
  (`on-session-start`, `on-subagent-start`, `on-subagent-stop`) cannot clobber each
  other's keys. Session metadata files under `~/.chorus/sessions/<name>.json` are
  whole-file `cat >` writes but are single-writer per session name (no concurrent
  clobber). `ensure_state` only writes `{}` on first init.
- Codex plugin (`plugins/chorus/`): stateless — writes no `~/.chorus/` files.

Conclusion: the clobber bug is **CLI-only**. Plugin state is already concurrency-safe.
Recorded here so the q4 scope expansion is closed with evidence, not silence.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Merge helper reads a corrupt `daemon.json` and aborts the write, blocking re-login | Defensive parse: malformed/missing file → treat as `{}` (mirrors `recordYoloAck`); a re-login then rewrites a clean file |
| Atomic rename leaves a stray `.tmp` on crash | `.tmp` is same-dir, 0600, overwritten next write; harmless |
| Preserving `yoloAckAt` weakens the "re-confirm on credential change" guard | Explicit owner decision (DEC-2); `--chorus-only` + per-start non-TTY warning still bound YOLO exposure |
| Loud warning line becomes noise on hosts that intentionally lack `claude` | One line only, stderr, gated on actual absence; matches the existing single-line YOLO warning pattern |

## Test Plan

- **Merge helper unit tests** (new): writing a partial preserves pre-existing unrelated
  keys; partial keys overwrite; missing file → file created with just the partial;
  malformed file → treated as empty, no throw; mode is 0600; atomic temp+rename path.
- **login**: after `runLogin`, a pre-existing `{cwds, yoloAckAt}` file retains both
  `cwds` AND `yoloAckAt`, and gains the four credential fields (this is the regression
  the idea reported — and asserts the q1 preserve-always behavior).
- **daemon credential completion** (`preflight`): the TTY-completion write preserves
  pre-existing `cwds`/`yoloAckAt`.
- **banner/startup**: when `claudePath` is null, exactly one `⚠` stderr warning line is
  emitted and the daemon still proceeds to subscribe; when found, no warning line.
- All existing daemon/login/banner tests continue to pass (no resolver changes).
