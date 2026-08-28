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

# Mirror a large markdown document without hand-encoding it (json_encode_file replacement).
# This is the preferred OpenSpec-mode document-mirror path (see docs/OPENSPEC_MODE.md and
# the openspec-aware skill §3.6). --arg-file reads the file's raw bytes as the JSON string —
# note there is NO leading '@' on --arg-file (the '@' shorthand is only for --arg key=@path).
chorus mcp call chorus_pm_add_document_draft \
  --arg proposalUuid=P1 --arg type=prd \
  --arg-file content=openspec/changes/my-change/proposal.md

# Whole arguments object from a file, or from stdin
chorus mcp call chorus_create_tasks --args-file ./tasks.json
cat args.json | chorus mcp call chorus_create_tasks --args-file -
```

## Credentials & agent identity

You can either pass an explicit `--url` + `--api-key`, **or** name WHICH agent to
act as (a "profile") and let `chorus mcp` resolve that agent's key from
`~/.chorus/daemon.json` — the secret never has to be threaded through the caller's
environment. A profile is named by `--agent <name|uuid>` or the
`CHORUS_AGENT_PROFILE` env var, matched against an `agents[]` entry's `agentUuid`
or `agentName` (an ambiguous match is a hard error — use the UUID).

Resolution precedence (profile is PREFERRED over url+key; a profile that resolves
no agent falls back to url-mode):

1. `--agent <name|uuid>` flag → select from `agents[]`, then
2. `--url` + `--api-key` flags, then
3. `CHORUS_AGENT_PROFILE` env → select from `agents[]`, then
4. `CHORUS_URL` + `CHORUS_API_KEY` environment variables (url-mode fallback), then
5. exactly one agent in `agents[]` → that agent; more than one and nothing named
   is a hard error listing the agents — `chorus mcp` never guesses an identity;
6. otherwise the flat `~/.chorus/daemon.json` / Claude Code plugin config.

```bash
chorus mcp whoami --agent "Admin Claude"          # by agentName
chorus mcp whoami --agent daee0667-8487-4810-…    # by agentUuid
CHORUS_AGENT_PROFILE="Admin Claude" chorus mcp call chorus_checkin '{}'  # via env
```

A daemon-woken session inherits `CHORUS_AGENT_PROFILE=<the agent's uuid>` from its
spawner, so its hooks/skills mirror documents as the right identity with no key in
their environment.

Run `chorus agents` to list every configured agent (name, UUID, backend — keys are
never printed) and see which valid values you can pass to `--agent` /
`CHORUS_AGENT_PROFILE`; the active profile is marked. `chorus mcp whoami` prints the
current agent's own UUID.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | The tool returned an error result (`isError`) |
| `2` | Bad flags / malformed JSON / ambiguous agent / transport or auth failure |
