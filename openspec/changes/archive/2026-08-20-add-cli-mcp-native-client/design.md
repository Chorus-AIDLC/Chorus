# Technical Design: `chorus mcp` native MCP client

## Overview

Surface the CLI's existing MCP client as a user-facing `chorus mcp` command group
with three actions (`call`, `whoami`, `list`), plus a file-content argument-filling
layer that replaces the plugin's `json_encode_file` bash helper. Reuse the already
shipped `cli/chorus-client.mjs` (SDK `StreamableHTTPClientTransport` + reconnect)
and `cli/credentials.mjs` (layered resolution + multi-agent `agents[]`) so this
change adds surface, not new transport or new dependencies.

## Architecture

### Dispatch

`chorus.mjs` gains `"mcp"` in `SUBCOMMANDS` and a lazy dispatch branch mirroring
`init` (which owns its own arg parser + `--help`):

```js
if (name === "mcp") {
  const { runMcp } = await import("./cli/mcp.mjs");
  return runMcp(rest, { version: pkgVersion() });
}
```

`runMcp(argv, { version })` returns a numeric exit code (never calls
`process.exit` itself — the entry module owns process lifetime), and writes tool
output to `process.stdout` / diagnostics to `process.stderr`.

### Module layout

| Module | Responsibility | Purity / test posture |
|---|---|---|
| `cli/mcp-args.mjs` (new) | Parse `call`/`whoami`/`list` + flags; **assemble the `arguments` object**; help text. No IO except reading files/stdin, which is injected. | Pure + injected reader → fully unit-testable. |
| `cli/mcp.mjs` (new) | Orchestrate: resolve creds, build client, run the action, apply output/exit semantics. | Thin; tested with a fake client + fake creds resolver. |
| `cli/chorus-client.mjs` (extend) | Add `callToolRaw(name, args)` → `{ isError, text }` (verbatim joined text blocks) and `listTools()` → `[{ name, description }]`. | Existing reconnect logic reused. |
| `cli/credentials.mjs` (extend) | Add `resolveMcpCredentials(flags, deps)` → `{ url, apiKey, label }` with `--agent` selection + ambiguity error. | Pure + injected IO. |

### Argument assembly (`chorus mcp call`)

The final `arguments` object is built by layering; **later sources override
earlier ones**, applied left-to-right in command-line order for the override
group:

1. **Base object** — exactly one of:
   - positional JSON string (`chorus mcp call <tool> '<json>'`), parsed as a JSON
     object; **or**
   - `--args-file <path>` (`-` ⇒ stdin), file parsed as a JSON object.
   - Supplying **both** is an error (ambiguous base). Neither ⇒ base is `{}`.
2. **`--arg key=value`** — sets `key` to the literal string `value`.
3. **`--arg-file key=<path>`** — sets `key` to the file's raw bytes decoded as
   UTF-8, as a JSON **string** value. `<path>` of `-` reads stdin.
4. **`@file` shorthand** — `--arg key=@<path>` is sugar for `--arg-file key=<path>`
   (leading `@` in a `--arg` value triggers a file read; `@-` ⇒ stdin). A literal
   value beginning with `@` is written `@@…` (the `@@` prefix escapes to a single
   leading `@`).

Rationale: (1) preserves the drop-in `mcp-tool <name> <json>` shape; (3)/(4) are
the byte-faithful `json_encode_file` replacement for large single-field payloads
(the document-mirror case, `--arg content=@openspec/changes/<slug>/proposal.md`);
(2) covers small scalar params without quoting JSON. stdin (`-`) may be consumed
by at most one source (base `--args-file -`, or one file-arg `@-` / `-`); a second
stdin consumer is an error.

> **File reads are byte-faithful strings, not parsed JSON.** `--arg-file` / `@file`
> inject the file's exact bytes as a JSON string (equivalent to `jq -Rs '.'`),
> preserving backslashes, quotes, newlines, code fences. Per elaboration decision
> `file_param_semantics=b`, a per-key **JSON-parsed** file injection
> (`--arg-json key=@f.json`) is explicitly **out of scope**; whole-object JSON
> comes only via `--args-file`.

### Credential + identity resolution (`resolveMcpCredentials`)

Reuses the existing layered model. Precedence:

1. If `--url` + `--api-key` flags resolve a complete pair, or
   `CHORUS_URL` + `CHORUS_API_KEY` env resolve one → use it directly. This is the
   **plugin-hook path** (hooks already export both env vars), so `--agent` is not
   consulted and no ambiguity can arise.
2. Otherwise fall back to `~/.chorus/daemon.json`:
   - If it declares multiple `agents[]` (via `resolveAgentConfigs`): a
     `--agent <label>` flag selects the entry whose `label`/`name` matches
     (case-sensitive exact match). No `--agent` with >1 agent ⇒ **hard error**
     listing the available labels. `--agent` naming a missing label ⇒ error.
   - Single agent (or flat top-level creds) ⇒ use it; `--agent` naming it is
     accepted.
3. Nothing resolves ⇒ the existing `resolveCredentials` "could not resolve"
   error (lists every source tried).

`resolveMcpCredentials` returns `{ url, apiKey, label }`; `label` is surfaced in
diagnostics ("acting as agent <label>") on stderr for `whoami`/`list` only, never
polluting `call` stdout.

### Client extensions

`ChorusClient` already owns connect / reconnect-on-session-expiry / disconnect.
Add two methods so the CLI can get verbatim bytes (the existing `callTool`
JSON-parses the text, which would re-serialize and break byte-equality):

- `callToolRaw(name, args)` → `{ isError: boolean, text: string }` where `text`
  is the newline-join of every `content[]` block with `type === "text"`, verbatim
  (no `JSON.parse` / re-`stringify`). Mirrors `chorus-api.sh`'s
  `jq -r '.result.content[]? | select(.type=="text") | .text'`.
- `listTools()` → `Array<{ name, description }>` from `client.listTools()`.

### Output & exit-code semantics

| Action | stdout (on success) | stderr | exit code |
|---|---|---|---|
| `call` | verbatim joined `content[].text` (strict drop-in) | — | 0 |
| `call` (tool `isError`) | — | tool error text | 1 |
| `call` (transport/auth) | — | diagnostic | 2 |
| `call` (bad flags / JSON parse / ambiguity) | — | usage diagnostic | 2 |
| `whoami` | bare agent UUID + `\n` | — | 0 |
| `list` | `name — description` lines | — | 0 |

**Intentional refinement over the wrapper (documented decision):** `chorus-api.sh
mcp-tool` printed tool-level `isError` text to *stdout* and exited 0. `chorus mcp
call` instead routes error text to *stderr* and exits non-zero — this is the
project "no silent errors" policy and does not break the existing hooks, which
tolerate failures (`|| true`) and parse *stdout* for success payloads only. The
migration change (`ad24116e`) inherits this stricter contract. Strict stdout
parity (the byte-for-byte success payload) — the property the elaboration
`output_parity=a` decision is about — is fully preserved.

## Module Contracts

- **`resolveMcpCredentials(flags, deps) → { url, apiKey, label }`** — throws on
  unresolved / ambiguous. `deps` injects `env` / `readJson` / `loginPath` /
  `settingsPath` exactly like `resolveCredentials` for testability.
- **`assembleArgs(parsed, { readFile, readStdin }) → object`** — pure given
  injected readers; throws `UsageError` on: both base sources, double stdin
  consumer, malformed JSON base, or a `--arg`/`--arg-file` missing `=`.
- **`ChorusClient.callToolRaw(name, args) → { isError, text }`** — text is
  verbatim; never JSON-parsed.
- `runMcp` catches `UsageError` (exit 2) vs tool `isError` (exit 1) vs transport
  error (exit 2), keeping the exit-code table above.

## Implementation Plan

1. Foundation (parallel): `resolveMcpCredentials` + `ChorusClient.callToolRaw` /
   `listTools` (T1); pure `mcp-args.mjs` parser + `assembleArgs` (T2).
2. Wire `cli/mcp.mjs` + `chorus.mjs` dispatch + output/exit semantics (T3).
3. Parity verification (byte-equality vs `chorus-api.sh mcp-tool` on a
   document-mirror payload) + CLI help/docs (T4, integration checkpoint).

## Risks & Mitigations

- **Byte-equality drift vs the wrapper.** Mitigate: `callToolRaw` never parses;
  T4 diffs `chorus mcp call … --arg content=@file` output against
  `chorus-api.sh mcp-tool` for a real markdown mirror payload and asserts
  byte-identical stdout (the `json_encode_file` case).
- **`@` ambiguity** (a literal arg value starting with `@`). Mitigate: documented
  `@@` escape; `--arg-file` / `--args-file` are the explicit, unambiguous forms.
- **Wrong-identity call under multi-agent.** Mitigate: hard error on ambiguous
  `agents[]` with no `--agent` (never pick silently); env/flags still win for the
  hook path so the common case needs no `--agent`.
- **SSE framing / session-expiry.** Already handled by the reused
  `StreamableHTTPClientTransport` + `ChorusClient` reconnect path; no new code.
- **Scope creep into migration.** Mitigate: this change touches no hook/skill and
  leaves `chorus-api.sh` / `json_encode_file` intact; migration is `ad24116e`.
