# Tasks

## 1. Foundation: MCP credential selection + client extensions
- [ ] 1.1 Add `resolveMcpCredentials(flags, deps)` to `cli/credentials.mjs`: env/flags direct; else `--agent`-select over `resolveAgentConfigs` `agents[]`; hard error on ambiguous multi-agent with no `--agent`.
- [ ] 1.2 Extend `cli/chorus-client.mjs` with `callToolRaw(name, args) → { isError, text }` (verbatim joined text blocks, no JSON parse) and `listTools() → [{ name, description }]`.
- [ ] 1.3 Unit tests: credential precedence (env wins, `--agent` picks, ambiguity throws, single-agent ok); `callToolRaw` verbatim + isError flag; `listTools` names.

## 2. Argument assembly engine (pure)
- [ ] 2.1 Add `cli/mcp-args.mjs`: parse `call`/`whoami`/`list` + flags; help text.
- [ ] 2.2 `assembleArgs(parsed, { readFile, readStdin })`: base (positional JSON XOR `--args-file`) → `--arg` literal → `--arg-file`/`@file`/stdin string overrides in order; `@@` escape; mutual-exclusion + malformed-JSON + double-stdin errors.
- [ ] 2.3 Unit tests covering every source, override order, escapes, and each error path.

## 3. Command wiring + I/O semantics
- [ ] 3.1 Add `cli/mcp.mjs` `runMcp(argv, { version })`: resolve creds (T1), assemble args (T2), drive `ChorusClient`; implement `call` / `whoami` / `list`.
- [ ] 3.2 Output/exit table: `call` success → verbatim text to stdout / exit 0; `isError` → stderr / exit 1; transport/usage → stderr / exit 2; `whoami` → bare UUID; `list` → name+description lines.
- [ ] 3.3 Add `"mcp"` to `SUBCOMMANDS` in `chorus.mjs` + lazy dispatch + `--help`.
- [ ] 3.4 Tests with a fake client: stdout parity, exit codes, whoami bare UUID, list output, dispatch routing.

## 4. Parity verification + CLI help/docs (integration checkpoint)
- [ ] 4.1 End-to-end parity: run `chorus mcp call` (incl. `--arg-file content=@file`) vs `chorus-api.sh mcp-tool` on a document-mirror payload; assert byte-identical stdout.
- [ ] 4.2 Update `chorus --help` and the CLI reference docs to document `chorus mcp call|whoami|list`.
- [ ] 4.3 `npx tsc --noEmit`, `pnpm lint`, and the `cli/` test suite pass (modulo known env-dependent headless failures).
