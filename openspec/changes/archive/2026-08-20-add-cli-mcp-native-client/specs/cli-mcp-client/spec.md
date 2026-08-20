# cli-mcp-client Specification (delta)

## ADDED Requirements

### Requirement: `chorus mcp` command group

The CLI SHALL provide a `chorus mcp` subcommand group, dispatched from the same
entry router as `daemon` / `login` / `init` (lazy-imported so the server-launch
path pays no cost). It SHALL expose exactly three actions — `call`, `whoami`, and
`list` — and SHALL support `chorus mcp --help` / `chorus mcp <action> --help`
describing the actions and their flags. An unknown action SHALL print usage to
stderr and exit non-zero.

#### Scenario: dispatching the mcp subcommand

- **WHEN** a user runs `chorus mcp call <tool> …`
- **THEN** the CLI routes to the `chorus mcp` handler (not the server-launch path)
  and executes the `call` action

#### Scenario: help for the group

- **WHEN** a user runs `chorus mcp --help`
- **THEN** the CLI prints help listing the `call`, `whoami`, and `list` actions
  and exits 0 without contacting any server

#### Scenario: unknown action

- **WHEN** a user runs `chorus mcp frobnicate`
- **THEN** the CLI prints a usage diagnostic to stderr and exits with a non-zero
  code

### Requirement: `chorus mcp call` invokes any MCP tool as the resolved agent

The CLI SHALL implement `chorus mcp call <tool> [json] [flags]` by performing the
full MCP handshake (`initialize` → `notifications/initialized` → `tools/call`)
over the Streamable HTTP transport as the resolved agent, reusing the CLI's
existing MCP client, and invoking `<tool>` with the assembled arguments object. It
SHALL reach functional parity with `chorus-api.sh mcp-tool <tool> <json>`.

#### Scenario: calling a tool with a positional JSON argument

- **WHEN** a user runs `chorus mcp call chorus_get_task '{"taskUuid":"abc"}'`
- **THEN** the CLI completes the MCP handshake as the resolved agent, calls
  `chorus_get_task` with `{ "taskUuid": "abc" }`, and prints the tool result

#### Scenario: session expiry during a call

- **WHEN** the transport reports a stateless-404 / session-expired condition mid-call
- **THEN** the CLI transparently reconnects once and retries the tool call before
  surfacing any error

### Requirement: Strict drop-in standard output for `chorus mcp call`

On a successful tool result, `chorus mcp call` SHALL write to stdout the verbatim
concatenation of the result's `content[]` blocks whose `type` is `text` (joined by
a newline when there is more than one), byte-for-byte, with no JSON re-encoding
and no wrapping envelope. This output SHALL match what `chorus-api.sh mcp-tool`
produced for the same call so existing grep/sed parsing keeps working unchanged.
The CLI SHALL NOT provide a `--json` structured-envelope mode for `call`.

#### Scenario: byte-for-byte parity on a document-mirror payload

- **WHEN** the same tool call returns a large markdown text payload via both
  `chorus-api.sh mcp-tool` and `chorus mcp call`
- **THEN** the two stdout outputs are byte-identical (including embedded newlines,
  quotes, and backslashes)

#### Scenario: no envelope on stdout

- **WHEN** a `chorus mcp call` succeeds
- **THEN** stdout contains only the tool's text content, not a JSON object with
  `isError` / `content` fields

### Requirement: Argument assembly with file-content and structured filling

`chorus mcp call` SHALL build the tool `arguments` object by layering sources,
with later sources overriding earlier keys, applied in command-line order:

1. A base object from **exactly one** of: a positional JSON string, OR
   `--args-file <path>` (a file parsed as a JSON object; `-` means stdin).
   Supplying both SHALL be an error. Supplying neither SHALL yield an empty base.
2. `--arg key=value` — sets `key` to the literal string `value`.
3. `--arg-file key=<path>` — sets `key` to the file's raw bytes decoded as UTF-8
   as a JSON **string** value; `<path>` of `-` reads stdin.
4. `--arg key=@<path>` — shorthand equivalent to `--arg-file key=<path>`
   (`@-` reads stdin). A literal `--arg` value beginning with `@` SHALL be written
   `@@…`, where a leading `@@` escapes to a single literal `@`.

File-fill sources (2b/3/4) SHALL inject file bytes as a JSON string — the
byte-faithful replacement for `json_encode_file` / `jq -Rs '.'` — and SHALL NOT
JSON-parse the file content. At most one source may consume stdin (`-`); a second
stdin consumer SHALL be an error. A malformed JSON base, or a `--arg` / `--arg-file`
token missing `=`, SHALL be a usage error (exit non-zero) reported to stderr.

#### Scenario: filling a large parameter from a file

- **WHEN** a user runs `chorus mcp call chorus_pm_add_document_draft --arg-file content=./design.md --arg type=tech_design --arg proposalUuid=P1`
- **THEN** the `content` argument is the exact UTF-8 bytes of `design.md` as a JSON
  string, and `type` / `proposalUuid` are the literal strings provided

#### Scenario: @file shorthand

- **WHEN** a user runs `chorus mcp call <tool> --arg content=@./proposal.md`
- **THEN** it behaves identically to `--arg-file content=./proposal.md`

#### Scenario: whole arguments object from a file

- **WHEN** a user runs `chorus mcp call <tool> --args-file ./args.json`
- **THEN** the parsed JSON object in `args.json` is used as the base arguments

#### Scenario: reading an argument from stdin

- **WHEN** a user pipes content and runs `… | chorus mcp call <tool> --arg-file content=-`
- **THEN** the `content` argument is the stdin bytes as a JSON string

#### Scenario: conflicting base sources

- **WHEN** a user supplies both a positional JSON string and `--args-file`
- **THEN** the CLI reports a usage error and exits non-zero without calling any tool

### Requirement: `chorus mcp whoami` prints the agent's own UUID

The CLI SHALL implement `chorus mcp whoami` by resolving the agent's identity via
`chorus_checkin` and printing the bare agent UUID (followed by a newline) to
stdout. It SHALL fetch the identity fresh on every invocation and SHALL NOT
persist any identity cache to disk.

#### Scenario: printing the bare UUID

- **WHEN** a user runs `AGENT_UUID=$(chorus mcp whoami)`
- **THEN** `AGENT_UUID` holds the resolved agent's UUID string with no surrounding
  decoration

#### Scenario: no persisted cache

- **WHEN** `chorus mcp whoami` is run twice
- **THEN** each invocation resolves identity via a fresh `chorus_checkin` and no
  identity cache file is written under `~/.chorus/`

### Requirement: `chorus mcp list` enumerates the agent's available tools

The CLI SHALL implement `chorus mcp list` by calling the MCP `tools/list` method
as the resolved agent and printing the tools that the agent's permissions expose,
one per line as the tool name plus a short description, for human discovery.

#### Scenario: listing permission-gated tools

- **WHEN** a user runs `chorus mcp list` as an agent with a limited permission set
- **THEN** stdout lists only the tool names that agent is permitted to see, each
  with a short description

### Requirement: Credential resolution and multi-agent selection

`chorus mcp` SHALL resolve the server URL + `cho_` API key using the CLI's layered
model (explicit `--url` / `--api-key` flags, then `CHORUS_URL` / `CHORUS_API_KEY`
env, then `~/.chorus/daemon.json`, then the Claude Code plugin config). When a
complete pair resolves from flags or env, it SHALL be used directly. When falling
back to `~/.chorus/daemon.json` that declares multiple `agents[]`, the CLI SHALL
require a `--agent <label>` flag to select the acting agent by its `label`/`name`;
a multi-agent config with no `--agent` SHALL be a hard error that lists the
available labels, and `--agent` naming a nonexistent label SHALL be an error. A
single-agent or flat-credential config SHALL be usable with no `--agent`.

#### Scenario: hook path with env credentials

- **WHEN** `CHORUS_URL` and `CHORUS_API_KEY` are set in the environment
- **THEN** `chorus mcp call …` acts as that key's agent directly, without
  consulting `agents[]` or requiring `--agent`

#### Scenario: ambiguous multi-agent config

- **WHEN** `~/.chorus/daemon.json` declares two or more `agents[]`, no credential
  env/flags are present, and no `--agent` is given
- **THEN** the CLI exits non-zero with an error listing the available agent labels
  and does not call any tool

#### Scenario: selecting an agent by label

- **WHEN** a user runs `chorus mcp whoami --agent worker-b` against a multi-agent
  `daemon.json`
- **THEN** the CLI acts as the `worker-b` entry's credentials and prints that
  agent's UUID

### Requirement: Error visibility for `chorus mcp call`

`chorus mcp call` SHALL surface failures on stderr and via a non-zero exit code
rather than silently. A tool-level `isError` result SHALL print its error text to
stderr and exit non-zero; a transport / authentication / usage failure SHALL print
a diagnostic to stderr and exit non-zero. Error text SHALL NOT be written to
stdout (stdout is reserved for the successful text payload).

#### Scenario: tool-level error

- **WHEN** a called tool returns an `isError` result (e.g. "Task not found")
- **THEN** the CLI writes the error text to stderr and exits with a non-zero code,
  and stdout is empty

#### Scenario: unreachable server

- **WHEN** the Chorus server is unreachable or the API key is rejected
- **THEN** the CLI writes a diagnostic to stderr and exits with a non-zero code
