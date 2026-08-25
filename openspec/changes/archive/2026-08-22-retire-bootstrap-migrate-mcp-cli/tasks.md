# Tasks

> Chorus task drafts are the source of truth; this list mirrors them for OpenSpec completeness.

## 1. Wrapper prefer-CLI/fallback delegation (all six surfaces)
- [ ] `chorus-api.sh` (CC + Kiro) `mcp-tool`: detect `chorus`, delegate `chorus mcp call … --url --api-key`, else curl; escape hatch `CHORUS_MCP_NO_CLI`
- [ ] `chorus-mcp-call.sh` (Codex + Pi) + dsh MCP-call wrapper: same delegation
- [ ] Keep local non-MCP subcommands untouched; Bash 3.2; update `test-syntax.sh` + delegation unit tests

## 2. Skill document-mirror migration (six openspec-aware copies + docs)
- [ ] Primary `chorus mcp call --arg-file content=<file>`; bash `json_encode_file` fallback block
- [ ] Update referencing proposal/develop/yolo/chorus skills + `on-session-start.sh` critical-rule strings
- [ ] Update `docs/OPENSPEC_MODE.md`, `docs/chorus-plugin.md`, `docs/MCP_CLIENT.md`

## 3. Install-script deprecation stubs + tests
- [ ] Gut `install-{codex,opencode,kiro}.sh` + `dsh-credentials.sh` to stub → `chorus init`
- [ ] Update `cli/__tests__/init-file-template.test.mjs` manifest-parity; `test-install-codex.sh`, `test-dsh-credentials.sh`

## 4. Product-facing redirect to `chorus init`
- [ ] `AgentInstallGuide.tsx` + `onboarding.install.*` in en/zh/ja/ko + component test
- [ ] `Integration.astro`, `docs/CONNECT_*.md`(+localized), READMEs
- [ ] `docs/design.pen` opencode mockup via Pencil MCP

## 5. Integration checkpoint
- [ ] `CHANGELOG.md`, `docs/MCP_TOOLS.md` surface/command references
- [ ] Full `pnpm test` + `pnpm lint` + `npx tsc --noEmit`; cross-surface consistency check
