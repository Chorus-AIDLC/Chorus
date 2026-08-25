# Retire install scripts / curl bootstrap and migrate plugin hooks + skills to `chorus mcp`

## Why

Chorus 0.17.0 introduced the `chorus` CLI as a unified control plane: `chorus init`
(one-command per-agent plugin configuration, shipped in #503/#504/#506) and
`chorus mcp` (a native MCP client that is byte-for-byte compatible with the legacy
`chorus-api.sh mcp-tool` + `json_encode_file` bash path, shipped in #505). With all
four prerequisites merged to `develop`, the CLI now reaches functional parity with the
two legacy bootstrap paths it was built to replace:

1. **Per-agent shell installers** — `public/install-codex.sh`, `public/install-opencode.sh`,
   `public/install-kiro.sh`, and the `public/dsh-credentials.sh` helper, all delivered via
   `curl … | bash`. `chorus init` now covers claude/codex/opencode/kiro/openclaw/dsh.
2. **The bash MCP path** — plugin runtime hooks (`on-*.sh`) and the OpenSpec document-mirror
   flow in the skills both talk to the Chorus MCP endpoint through `chorus-api.sh mcp-tool`
   (Claude Code + Kiro) or `chorus-mcp-call.sh` (Codex + Pi + dsh). `chorus mcp call` is a
   proven drop-in.

The container elaboration chose **`parallel_then_retire`**: now that parity holds, this
finalization idea switches the call sites over and retires the legacy entry points behind a
thin transition shim, so old bookmarks and plugin-only users do not break.

## What Changes

Per the owner's elaboration decisions on idea `ad24116e`:

- **MCP path (both skills and hooks): prefer `chorus mcp`, fall back to the bundled bash path
  when the `chorus` CLI is not on `PATH`.** The prefer/fallback decision lives in one place per
  wrapper (`chorus-api.sh` `mcp-tool`, `chorus-mcp-call.sh`): detect `chorus`, delegate the
  tool call to `chorus mcp call` **passing the wrapper's already-resolved `--url`/`--api-key`**;
  otherwise run the existing `curl` logic. Hook call sites are unchanged (minimal blast radius);
  the skill document-mirror instructions surface `chorus mcp call --arg-file content=<file>` as
  the primary path with the bash path documented as the fallback. The bash MCP path is
  **demoted to a fallback, not deleted** this version (true removal is a future version once CLI
  adoption is universal). `chorus-api.sh`'s local, non-MCP subcommands (`state-*`,
  `hook-output`, `session-read/list`) are untouched.
- **Per-agent install scripts → deprecation stubs.** `install-codex.sh`, `install-opencode.sh`,
  `install-kiro.sh`, and `dsh-credentials.sh` are gutted to a short stub that prints
  "this installer is deprecated — run `npx @chorus-aidlc/chorus init`" and `exec`s it when `node`
  is available. No inline install logic remains. The `install-kiro.sh` ↔ `cli/init/file-template.mjs`
  manifest-parity test is updated (the manifest now lives solely on the JS side).
- **Root `install.sh` is out of scope and unchanged** — it is the CDK/AWS server deployer, not a
  per-agent plugin installer; `chorus init` does not replace it. (The idea body listed it in error.)
- **All product-facing surfaces redirect to `chorus init`.** The in-app Install Guide
  (`AgentInstallGuide.tsx` + `onboarding.install.*` i18n in all four locales + tests), the landing
  page (`Integration.astro`), the connect docs (`docs/CONNECT_*.md` and localized variants),
  the READMEs, and the `docs/design.pen` mockups show `chorus init` (or
  `npx @chorus-aidlc/chorus init`) instead of the `curl … | bash` command. Historical release
  blog posts are left untouched as archive.
- **Coverage: all six plugin surfaces** — Claude Code, Kiro, Codex, OpenClaw, Pi, dsh — migrated
  together so the near-identical skill copies do not drift.

## Capabilities

- **`chorus-cli-bootstrap-migration`** (new) — the end-state contract: wrapper prefer/fallback
  delegation, skill doc-mirror migration, install-script deprecation stubs, the root-`install.sh`
  boundary, and the product-facing redirect.
- **`kiro-plugin-installer`** (modified) — `install-kiro.sh` becomes a deprecation stub; its
  merge/settings/hook-install behavior moves to `chorus init`'s file-template installer (already
  specified under `agent-plugin-install`), and its connect-guide requirement points at `chorus init`.
- **`agent-plugin-install`** (modified) — the "kiro plugin installed via a native cross-platform
  file-template" requirement no longer mandates a manifest shared with `install-kiro.sh`; the
  JavaScript installer (`cli/init/file-template.mjs`) is the sole manifest owner now that the shell
  installer is a stub.
- **`agent-install-guide`** (modified) — the dsh onboarding flow presents `chorus init` instead of a
  `curl | bash` installer command.
- **`dsh-connection-guide`** (modified) — the dsh connect guides document `chorus init` and the
  retirement of the `dsh-credentials.sh` bootstrap.

## Impact

- **Affected code:** `public/chorus-plugin/bin/chorus-api.sh`, `public/kiro-plugin/bin/chorus-api.sh`,
  `plugins/chorus/hooks/chorus-mcp-call.sh`, `packages/chorus-pi/bin/chorus-mcp-call.sh`, the dsh
  MCP-call wrapper, the six `openspec-aware` SKILL.md copies (+ referencing proposal/develop/yolo/chorus
  skills), `public/install-{codex,opencode,kiro}.sh`, `public/dsh-credentials.sh`,
  `src/components/install-guide/AgentInstallGuide.tsx`, `messages/{en,zh}.json` (+ ja/ko), the
  install-guide test, `packages/landing/src/components/Integration.astro`, `docs/CONNECT_*.md`,
  the READMEs, `docs/design.pen`, `cli/__tests__/init-file-template.test.mjs`, the bash regression
  tests, `docs/MCP_TOOLS.md`, `docs/OPENSPEC_MODE.md`, `docs/chorus-plugin.md`, `CHANGELOG.md`.
- **No runtime hard-dependency added:** because the fallback preserves the curl path, a plugin-only
  user without the `chorus` CLI keeps working; a user who ran `chorus init` gets the CLI transport.
- **Behavioral parity:** `chorus mcp call` is byte-exact with `chorus-api.sh mcp-tool` (proven in #505),
  so hook and doc-mirror outputs are unchanged on the CLI path; the fallback path is the pre-existing
  behavior verbatim.
- **Known adjacent spec drift (follow-up, not addressed here):** `dsh-skill-bundle` and
  `docs-site-skill` still reference an `install-dsh.sh` / `install-kiro.sh SKILLS=` list; the
  `install-dsh.sh` reference is pre-existing staleness from the dsh→npm migration (#499). These are
  flagged for a fast-follow cleanup rather than expanded into this change.
- **Verification limits (headless):** live in-app Install Guide e2e and non-Claude harness live runs
  cannot be fully exercised in the headless build host; those acceptance criteria rely on unit tests,
  the `design.pen` update via Pencil MCP, and static/shape verification, with live smoke-tests noted
  as a follow-up.
