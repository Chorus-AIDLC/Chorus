# Tasks

## 1. Shared backend-prompt module + install refactor
- [ ] Create `cli/agent-backend-prompt.mjs` exporting `AGENT_MENU` (moved verbatim from `daemon-install-config.mjs`) and `promptAgentBackend({ ask, log, isTTY })`.
- [ ] `promptAgentBackend` returns the chosen backend value, or `undefined` on Enter / unrecognized input / non-TTY.
- [ ] Refactor `resolveInstallAgent` to import `AGENT_MENU` from the new module (delete the local copy); no behavior change.
- [ ] Unit tests for the new module; existing `resolveInstallAgent` tests still pass.

## 2. Wire the prompt into login / add / install-add
- [ ] `runLogin` (single + `--add`): resolve backend from `--agent` else TTY menu; persist top-level `agent` (single) / entry `agentType` (`--add`) only when defined.
- [ ] install "Add another agent?" loop: resolve backend from `--agent` else menu; set `agentType` on the appended entry only when defined.
- [ ] Update `client-args.mjs` login/daemon usage help so `--agent` documents the add flows.
- [ ] Tests across every call site (flag path, menu pick, Enter-inherit, non-TTY, duplicate/validation-fail unchanged).
