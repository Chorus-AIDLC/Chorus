# Chorus MCP client (`chorus mcp`)

`chorus mcp` is a native MCP client built into the `chorus` CLI. It performs the
full MCP handshake over the Streamable HTTP transport as your agent and lets you
call any Chorus MCP tool, print your own agent identity, or list the tools your
API key may call — no `curl` / `jq` wrapper required.

It reaches parity with the plugin's `chorus-api.sh mcp-tool` and adds first-class
file-content parameter filling (a byte-faithful replacement for the old
`json_encode_file` helper).

## Actions

```bash
chorus mcp call <tool> ['<json>'] [arg flags]   # Call an MCP tool
chorus mcp whoami                               # Print this agent's own UUID
chorus mcp list                                 # List the tools this agent may call
```

- **`call`** prints the tool result's text **verbatim** on stdout on success
  (a drop-in for `chorus-api.sh mcp-tool`, byte-for-byte). A tool-level error
  prints to stderr and exits `1`; a transport / auth / usage error prints to
  stderr and exits `2`.
- **`whoami`** prints the bare agent UUID (handy for `AGENT_UUID=$(chorus mcp whoami)`).
  It is fetched fresh each call — there is no on-disk identity cache.
- **`list`** prints one `name — description` line per permitted tool.

## Passing tool arguments (`call`)

The `arguments` object is built by layering sources; later sources override
earlier keys, applied in command-line order:

| Form | Meaning |
|------|---------|
| `'<json>'` (positional) | Base arguments object, as a JSON string |
| `--args-file <path>` | Base arguments object, read from a JSON file (`-` = stdin) |
| `--arg key=value` | Set `key` to the literal string `value` |
| `--arg-file key=<path>` | Set `key` to a file's raw bytes as a JSON string (`-` = stdin) |
| `--arg key=@<path>` | Shorthand for `--arg-file` (`@-` = stdin; `@@x` = literal `@x`) |

The positional JSON and `--args-file` are mutually exclusive (they both provide
the base object). File-filled values are injected as JSON **strings**, exactly
as `jq -Rs '.'` would encode them — ideal for large document/markdown payloads.

### Examples

```bash
# Read a task (positional JSON args)
chorus mcp call chorus_get_task '{"taskUuid":"…"}'

# Mirror a large markdown document without hand-encoding it (json_encode_file replacement)
chorus mcp call chorus_pm_add_document_draft \
  --arg proposalUuid=P1 --arg type=prd \
  --arg-file content=@openspec/changes/my-change/proposal.md

# Whole arguments object from a file, or from stdin
chorus mcp call chorus_create_tasks --args-file ./tasks.json
cat args.json | chorus mcp call chorus_create_tasks --args-file -
```

## Credentials & agent identity

`chorus mcp` resolves the server URL + `cho_` API key using the same layered
model as the daemon (see [DAEMON.md](./DAEMON.md#credentials)):

1. `--url` + `--api-key` flags, then
2. `CHORUS_URL` + `CHORUS_API_KEY` environment variables (the plugin-hook path), then
3. `~/.chorus/daemon.json`, then the Claude Code plugin config.

When `~/.chorus/daemon.json` declares several agents in its `agents[]` list and no
credentials come from flags/env, select which agent to act as with
`--agent <label>`. Running with more than one configured agent and no `--agent`
is a hard error listing the available labels — `chorus mcp` never guesses an
identity.

```bash
chorus mcp whoami --agent worker-b          # act as the "worker-b" agent
```

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | The tool returned an error result (`isError`) |
| `2` | Bad flags / malformed JSON / ambiguous agent / transport or auth failure |
