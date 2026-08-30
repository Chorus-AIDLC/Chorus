## 1. Update intent

- [x] 1.1 Add installed-plugin update decision resolution to `runInit`, including one interactive prompt and automatic acceptance for `--yes` / non-TTY runs.
- [x] 1.2 Document the update behavior in `chorus agents add --help` and cover parsing/orchestration behavior with unit tests.

## 2. Harness refresh paths

- [x] 2.1 Implement and test installed-plugin refresh for Claude Code, Codex, and opencode using their verified native CLI command shapes.
- [x] 2.2 Implement and test installed-plugin refresh for dsh and OpenClaw while preserving profile/prerequisite and host-version/enable guards.
- [x] 2.3 Implement and test Kiro full template refresh while retaining backups, Chorus-owned asset replacement, and merge-preserving MCP configuration.

## 3. Verification

- [x] 3.1 Add integration coverage proving accepted refreshes continue across harness failures and produce a non-zero final exit when any refresh fails.
- [x] 3.2 Run focused init tests, the full CLI test suite, and `openspec validate refresh-installed-agent-plugins`.
