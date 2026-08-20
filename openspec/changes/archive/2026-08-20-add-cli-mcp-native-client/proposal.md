# Proposal: `chorus mcp` — native MCP client in the CLI (call + whoami + list)

## Why

Today every plugin hook and skill that needs to talk to Chorus over MCP shells
out to `public/chorus-plugin/bin/chorus-api.sh mcp-tool <tool> <json>` — a
curl-based JSON-RPC wrapper that hand-rolls the `initialize` →
`notifications/initialized` → `tools/call` handshake over the Streamable HTTP
transport, then greps `.result.content[].text` out of the (possibly SSE-framed)
response. It works, but it is a bash/curl/jq contraption bolted onto the side of
the CLI: large payloads (document mirrors) must be pre-encoded with a separate
`json_encode_file` helper, there is no first-class way to fill a parameter from a
file, and the wrapper lives in the plugin bundle rather than in the `chorus`
binary that the rest of the control plane already ships.

The 0.17.0 direction (container `edc097bb`) is to make the `chorus` CLI the single
control plane. The CLI *already* contains a real MCP client — `cli/chorus-client.mjs`
wraps `@modelcontextprotocol/sdk`'s `StreamableHTTPClientTransport` with
`callTool` + session-expiry reconnect, and `cli/credentials.mjs` already resolves
credentials from flags > env > `~/.chorus/daemon.json` > plugin fallback
(including the multi-agent `agents[]` model). This change surfaces that client as
a user-facing `chorus mcp` command group so the CLI can *be* the MCP client,
reaching parity with `chorus-api.sh mcp-tool` and adding file-content parameter
filling.

This is the enabling half of the "CLI takes over MCP operations" pillar. It
deliberately stops at **parity + ergonomics**: the actual migration of plugin
hooks and skills off `chorus-api.sh` / `json_encode_file` is a separate downstream
change (idea `ad24116e`), which depends on this one landing first.

## What Changes

- **New `chorus mcp` subcommand group** dispatched from `chorus.mjs` (added to
  `SUBCOMMANDS`, lazy-imported like `daemon` / `login` / `init`), with three
  actions:
  - **`chorus mcp call <tool> [json] [flags]`** — perform the full MCP handshake
    as the resolved agent and invoke any tool. Standard output is a **strict
    drop-in** for `chorus-api.sh mcp-tool`: the verbatim concatenation of the
    result's `content[].text` text blocks, byte-for-byte, so existing
    grep/sed parsing keeps working unchanged when the downstream migration
    rewires hooks.
  - **`chorus mcp whoami [flags]`** — resolve the agent's own identity via
    `chorus_checkin` and print the bare agent UUID on stdout (for
    `AGENT_UUID=$(chorus mcp whoami)` reuse). Stateless — fetched fresh each
    invocation, **no on-disk cache** (per elaboration decision `whoami_cache`).
  - **`chorus mcp list [flags]`** — call MCP `tools/list` and print the tools the
    resolved agent's permissions expose (name + short description, one per line)
    for human discovery.
- **File-content / structured argument filling** for `chorus mcp call`, replacing
  the `json_encode_file` bash helper:
  - a positional JSON string as the base `arguments` object (drop-in with the old
    `mcp-tool <name> <json>` shape), **or** `--args-file <path>` to read the whole
    `arguments` object from a JSON file (`-` = stdin);
  - `--arg key=value` literal string overrides;
  - `--arg-file key=<path>` (and the `@file` shorthand `--arg key=@<path>`, with
    `@-` = stdin) to fill a single parameter from a file's raw bytes as a JSON
    **string** — the byte-faithful replacement for `json_encode_file` /
    `jq -Rs '.'` on document-mirror payloads.
- **Multi-agent identity selection**: `chorus mcp` reuses the daemon credential
  model. When credentials are explicit (flags or `CHORUS_URL`/`CHORUS_API_KEY`
  env — the plugin-hook path), they are used directly. When falling back to
  `~/.chorus/daemon.json` and it declares multiple `agents[]`, a `--agent <label>`
  flag selects which agent identity to act as; an ambiguous multi-agent config
  with no `--agent` is a hard error that lists the available labels (per
  elaboration decision `multi_agent_select`) — never a silent wrong-identity call.
- **Error visibility**: `chorus mcp call` writes the tool's text to stdout only on
  a successful result; a tool-level `isError` result prints its text to **stderr**
  and exits non-zero, and transport/auth/usage errors print to stderr and exit
  non-zero. (This is the one intentional refinement over the wrapper, which
  conflated error text into stdout and exited 0 — see design.md.)
- **CLI help + docs**: `chorus --help` and the CLI reference document the new
  `chorus mcp call|whoami|list` surface.

## Capabilities

- `cli-mcp-client` (new): the `chorus mcp` command group — native MCP call,
  self-identity, tool discovery, argument assembly (positional JSON / `--args-file`
  / `--arg` / `--arg-file` / `@file` / stdin), credential + multi-agent selection,
  and output/error semantics.

## Impact

- **Code**: new `cli/mcp.mjs` (command + I/O semantics) and `cli/mcp-args.mjs`
  (pure arg parser + argument assembly); extensions to `cli/chorus-client.mjs`
  (a verbatim-text `callToolRaw` + `listTools`) and `cli/credentials.mjs` (a
  `--agent`-aware MCP credential resolver over `resolveAgentConfigs`); one line
  in `chorus.mjs` `SUBCOMMANDS` + dispatch; help text.
- **No new dependencies** — `@modelcontextprotocol/sdk` is already a top-level
  dep (CLAUDE.md pitfall #9). Pure-JS, cross-platform.
- **No breaking changes** — `chorus-api.sh mcp-tool` and `json_encode_file` are
  left in place and keep working; nothing is migrated in this change. Hooks/skills
  migration and script retirement are the separate downstream idea `ad24116e`,
  which is unblocked once `chorus mcp` reaches parity here.
- **Out of scope**: migrating any hook or skill; retiring `chorus-api.sh` /
  `json_encode_file`; a `--json` structured-envelope output mode (rejected in
  favor of strict drop-in); persisting a whoami identity cache.
