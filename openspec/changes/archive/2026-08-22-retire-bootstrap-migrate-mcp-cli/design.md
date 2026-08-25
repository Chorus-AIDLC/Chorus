# Design: retire bootstrap scripts + migrate the bash MCP path to `chorus mcp`

## Context

Two legacy bootstrap paths reach parity with the `chorus` CLI and are retired here behind a
transition shim (`parallel_then_retire`):

- **Install/curl bootstrap** → replaced by `chorus init` (covers claude/codex/opencode/kiro/openclaw/dsh).
- **Bash MCP path** (`chorus-api.sh mcp-tool` / `chorus-mcp-call.sh` + the `json_encode_file` skill
  helper) → replaced by `chorus mcp call`, which is byte-exact with the wrapper (#505).

The owner's crux decision: **prefer the CLI, fall back to the bundled bash path when `chorus` is not
on `PATH` — for both skills and hooks.** So the bash MCP path is *demoted to a fallback*, not deleted.

## Decision 1 — Wrapper-internal prefer/fallback delegation (hooks)

The prefer/fallback branch lives in **one place per wrapper**, so the many hook call sites stay
unchanged (they keep calling `chorus-api.sh mcp-tool <tool> <json>` / `chorus-mcp-call.sh <tool> <json>`).

Contract for the MCP-call path inside each wrapper:

1. Resolve `CHORUS_URL` + `CHORUS_API_KEY` exactly as today (the wrapper remains the single credential
   resolver — this avoids the daemon.json-vs-plugin-env credential-source mismatch).
2. **Decide transport:**
   - If `CHORUS_MCP_NO_CLI` is set (escape hatch) → use the bash/curl path.
   - Else if `command -v chorus` resolves → delegate:
     `chorus mcp call "<tool>" "<json>" --url "$CHORUS_URL" --api-key "$CHORUS_API_KEY"`
     and propagate its **stdout verbatim and its exit code** (byte-exact drop-in per #505).
   - Else → run the existing `curl` logic unchanged.
3. **Fallback triggers on binary *absence* (or the escape hatch), never on call *failure*.** If
   `chorus` is present but the call errors (network/auth), the error is propagated — we do NOT
   re-attempt over curl, to avoid double requests and to keep one authoritative result.

Notes:
- `chorus mcp call` accepts a positional JSON string, matching `mcp-tool <tool> <json>`; credentials
  are forced explicit via `--url`/`--api-key` (both are declared value-flags in `cli/mcp-args.mjs`).
- Cold-start: delegating adds one Node startup (~hundreds of ms) per hook call when the CLI is present.
  Hooks are not latency-critical; accepted. CLI-absent hosts pay nothing (curl path).
- Scope: only the wrapper's **MCP-over-HTTP tool-call path** is delegated. The wrappers' local,
  non-MCP subcommands (`state-*`, `hook-output`, `session-read/list`, local `checkin` scaffolding)
  are untouched — `chorus-api.sh` is **not** deleted.

Surfaces (all six):
| Surface | Wrapper | File |
|---|---|---|
| Claude Code | `chorus-api.sh` `mcp-tool` | `public/chorus-plugin/bin/chorus-api.sh` |
| Kiro | `chorus-api.sh` `mcp-tool` | `public/kiro-plugin/bin/chorus-api.sh` |
| Codex | `chorus-mcp-call.sh` | `plugins/chorus/hooks/chorus-mcp-call.sh` |
| Pi | `chorus-mcp-call.sh` | `packages/chorus-pi/bin/chorus-mcp-call.sh` |
| dsh | `chorus-mcp-call.mjs` (Node, not bash) | `packages/chorus-dsh/bin/chorus-mcp-call.mjs` |
| OpenClaw | none of its own — skill references `chorus-api.sh` on `PATH` | skill-only (Decision 2) |

> **dsh nuance:** dsh's wrapper is already a Node script (`chorus-mcp-call.mjs`, post the dsh→npm
> migration #499), not a bash/curl script. The implementer SHALL read it and either delegate to
> `chorus mcp call` when `chorus` is on `PATH` (preferred, for consistency) or, if it is already a
> compliant native MCP client, leave its transport and confirm the skill/docs reference `chorus mcp`.
> Either way the dsh path MUST NOT regress. The `--url`/`--api-key`/`--arg-file key=<path>`/`--args-file`
> flags are verified present in `cli/mcp-args.mjs` (VALUE_FLAGS), so delegation with explicit creds is
> supported.

All wrapper scripts MUST stay **Bash 3.2 compatible** (CLAUDE.md pitfall #10); run
`test-syntax.sh` where present.

## Decision 2 — Skill document-mirror migration (skills)

The `openspec-aware` doc-mirror is the LLM-invoked path. Migrate its primary instruction to the CLI,
keep the bash path as a documented fallback:

- **Primary (CLI):** byte-exact content fill via `--arg-file`, which replaces `json_encode_file`:
  ```
  chorus mcp call chorus_pm_add_document_draft \
    '{"proposalUuid":"<uuid>","type":"prd","title":"…"}' \
    --arg-file content=openspec/changes/$SLUG/proposal.md
  ```
- **Fallback (no `chorus` on PATH):** the existing `chorus-api.sh mcp-tool` + `json_encode_file`
  block, retained verbatim under a clearly-marked "if the `chorus` CLI is unavailable" heading. The
  `chorus_check_response` halt-on-error helper applies to both paths.

Because the wrapper (Decision 1) itself delegates when the CLI is present, the fallback block is only
exercised on CLI-absent hosts. Keep `json_encode_file` defined **in the fallback section only**.

Edit the six `openspec-aware` copies + the referencing proposal/develop/yolo/chorus skills' one-line
pointers, plus the cross-surface docs `docs/OPENSPEC_MODE.md`, `docs/chorus-plugin.md`,
`docs/MCP_CLIENT.md`, and the SessionStart-injected "critical rule" strings in
`public/chorus-plugin/bin/on-session-start.sh` and `plugins/chorus/hooks/on-session-start.sh`.

> Bootstrap note: authoring **this** proposal still uses the current (bash) `openspec-aware` rule —
> the migration takes effect for future runs, so there is no bootstrap paradox.

## Decision 3 — Install scripts → deprecation stubs

Gut `install-codex.sh`, `install-opencode.sh`, `install-kiro.sh`, and `dsh-credentials.sh` to a
Bash-3.2 stub that:

1. Prints a deprecation notice naming the replacement: `npx @chorus-aidlc/chorus init`.
2. If a TTY is attached AND `chorus`/`npx` is available → `exec`s `npx -y @chorus-aidlc/chorus init`
   (or `chorus init` if already on `PATH`).
3. Otherwise (e.g. piped `curl | bash`, no TTY) → prints the exact command to run and exits **non-zero**
   (no silent success; automation that piped the old installer will notice the change).

No inline install logic remains. `install-kiro.sh` no longer reads a manifest, so the
`cli/init/file-template.mjs` ↔ `install-kiro.sh` **manifest-parity test**
(`cli/__tests__/init-file-template.test.mjs`) drops its bash-side assertion; the manifest becomes
solely `file-template.mjs`'s concern. Update `public/test-install-codex.sh` and
`public/test-dsh-credentials.sh` to assert the new stub shape (deprecation notice + non-zero exit
when non-interactive) instead of the old install behavior.

Root `install.sh` (CDK/AWS deployer) is **untouched**.

## Decision 4 — Product-facing redirect to `chorus init`

Replace `curl … | bash` with `chorus init` (or `npx @chorus-aidlc/chorus init`) across:

- **In-app Install Guide** `src/components/install-guide/AgentInstallGuide.tsx` — per-agent command
  strings now show `chorus init`; keep the seven-tab structure, the `apiKey` embed/placeholder, and
  both light/dark theme correctness. Update the `onboarding.install.*` keys in **all four** locales
  (`messages/en.json`, `zh.json`, `ja.json`, `ko.json`) and the component test.
- **Landing** `packages/landing/src/components/Integration.astro`.
- **Connect docs** `docs/CONNECT_CODEX.md`(.zh), `docs/CONNECT_KIRO.md`, `docs/CONNECT_OPENCODE.md`(.zh),
  `docs/CONNECT_DSH.md`(.zh).
- **READMEs** `README.md`, `README.zh.md`, `README.ja.md`, `README.ko.md` (install-kiro reference).
- **design.pen** — update the opencode `curl … | bash` mockup text to `chorus init` via the **Pencil
  MCP** tools only (never Read/Grep the encrypted file).

Historical release blog posts under `packages/landing/.../blog/` are left as archive.

## Risks & mitigations

- **Credential-source mismatch** (CLI reads `~/.chorus`; wrapper has plugin env) → mitigated by the
  wrapper passing explicit `--url`/`--api-key` to `chorus mcp call`.
- **Double-request / masked failure** → fallback only on binary absence, never on call error.
- **Bash 4 features creep into stubs/wrappers** → keep 3.2-compatible; run `test-syntax.sh`.
- **i18n drift** → run `locale-key-parity` coverage; every changed key present in all four locales.
- **Headless verification gaps** → live in-app-guide e2e and non-Claude harness live runs are
  follow-ups; unit tests + Pencil `design.pen` update + static/shape checks are the shippable bar.

## Out of scope / follow-up

- `dsh-skill-bundle` (`install-dsh.sh` internal skill install) and `docs-site-skill`
  (`install-kiro.sh SKILLS=` list) carry pre-existing `install-dsh.sh` staleness (dsh→npm, #499) —
  flagged for a fast-follow, not expanded here.
- Hard removal of the bash MCP fallback (a future version once CLI adoption is universal).
