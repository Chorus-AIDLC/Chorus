# Tasks — add-cli-agent-launch

## 1. Implement `chorus agents run`

- [ ] 1.1 Add `resolveLaunchAgent(flags, deps)` to `cli/credentials.mjs` returning the selected agent's `{ url, apiKey, agentUuid, agentName, agentType, label }` (reuse `resolveMcpCredentials` selection precedence).
- [ ] 1.2 New `cli/agent-launcher.mjs`: argv split at `--`, chorus flag parse (`--name`/`--type`/`--help`), type→binary map, PATH-walk binary resolution (Windows `.cmd` aware), childEnv build (3 `CHORUS_*`, no headless), foreground spawn (`stdio: "inherit"`), exit-code forwarding, `offline`/missing-binary/ambiguous errors.
- [ ] 1.3 Wire the `run` branch into `runAgents` (`cli/agents.mjs`) + `chorus agents run --help` + group help update.
- [ ] 1.4 Unit tests (Vitest) covering selection, `--type` override, `offline` error, type→binary map, missing binary, childEnv contents, passthrough after `--`, exit-code forwarding, no-secret-in-output.
- [ ] 1.5 `pnpm test` (new tests) + `npx tsc --noEmit` + `pnpm lint` clean.

## 2. Document `chorus agents run`

- [ ] 2.1 Add the `run` command contract to the `chorus-cli` skill across all plugin surfaces.
- [ ] 2.2 Add a short "launch an agent" section to the user docs.
