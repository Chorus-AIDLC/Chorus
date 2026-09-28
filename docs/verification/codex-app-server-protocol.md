# Codex App Server protocol contract

T1 for approved proposal `ea5285b9-d3a1-4653-8443-ee0a5831c20d`.
Tested on Linux with **codex-cli 0.157.1**, 2026-09-28. This is the minimum
verified baseline; compatibility with earlier versions has not been established.

Evidence comes from the [official OpenAI App Server documentation](https://developers.openai.com/codex/app-server/),
the installed CLI's `codex app-server generate-json-schema` output at
`/tmp/chorus-codex-schema-01571`, and an isolated real stdio handshake/error probe.
The official page describes a moving protocol; the generated 0.157.1 schemas
determine the fields below. No experimental API capability is needed.

## Client API for T2/T3

Named exports from `cli/codex-app-server-client.mjs`:

```js
const client = new CodexAppServerClient(child, { limits, onDiagnostic });
const unsubscribe = client.subscribe(message => adapter.accept(message));
const result = await client.request(method, params, { timeoutMs, signal });
await client.notify(method, params); // params may be omitted
await client.respond(serverRequestId, { result }); // or { error: { code, message } }
const error = await client.failure; // resolves on failure OR explicit close; never rejects
client.close(); // synchronous, idempotent; ends stdin
```

The caller provides an actual ChildProcess with piped stdin/stdout/stderr.
Writes obey the Node Writable callback and `drain` contract; test doubles must
implement both. The client does not spawn, kill, wait for exit, persist sessions,
call Chorus, or decide whether a turn succeeded.

`subscribe(fn)` synchronously delivers complete decoded raw messages, including
responses, notifications, and reverse requests. Subscribe before setup/turn
submission to catch notifications arriving before their RPC responses. The
returned unsubscribe function is idempotent. Unknown notifications are tolerated;
T3 filters relevant thread/turn IDs and ignores events it does not consume.
Listener exceptions/rejections fail the transport with a fixed diagnostic.
Subscriptions are cleared at settlement.

**Reverse requests are automatically handled by the client.** Subscribers observe
them but must not respond a second time. `respond` is the low-level wire primitive,
not a callback that transfers headless policy ownership to T2/T3.

`client.closed`, `client.error`, `client.pendingCount`, and `client.stderrBytes`
are read-only inspection getters. `failure` yields a `CodexAppServerError`, also
used by rejected operations. `code` is a stable internal classification.
RPC rejection additionally carries `method` and `rpcCode`; `rpcMessage` is
non-enumerable and exists only for the narrow history classifier. Never log it.
Provider `error.data`, stderr, prompts, and inbound payloads are not included in
diagnostics or error messages. The bounded private stderr tail is discarded on
close and is not exposed as diagnostic text. `onDiagnostic` receives fixed text
such as `Codex App Server: RESPONSE_TIMEOUT`; it must be routed to daemon logs
by T2. Callback failures cannot strand cleanup.

| Injectable `limits` key | Default |
| --- | ---: |
| `initializeTimeoutMs` | 30,000 ms |
| `threadSetupTimeoutMs` | 60,000 ms |
| `turnStartTimeoutMs` | 60,000 ms |
| `requestTimeoutMs` | 60,000 ms |
| `writeTimeoutMs` | 60,000 ms |
| `maxFrameBytes` | 32 MiB |
| `maxQueuedBytes` | 32 MiB including newline delimiters |
| `maxPendingRequests` | 1,024 |
| `stderrTailBytes` | 8 KiB |

All limits and request overrides must be positive safe integers.
`APP_SERVER_DEFAULTS` exports these defaults. Request deadlines include queue
time; write deadlines include both queue time and time waiting for callback/drain.
The frame bound counts bytes before LF, including an optional CR. Partial frames
use bounded geometric storage, decoded as fatal UTF-8 only once LF arrives.
Invalid UTF-8, invalid JSON/envelopes, empty lines, truncated EOF and overflow
fail the transport without echoing frame content.

Timeout, cancellation, EOF, stream/process error, or explicit close rejects all
pending operations, discards queued frames, clears timers and subscriptions, and
ends stdin. A late `drain` cannot send a timed-out/cancelled queued `turn/start`.
No request is retried. An already-written request may have executed: T2 must not
resend `turn/start` to recover an uncertain response. Promise-returning operations
must be awaited/caught; the client's own background handlers consume their errors.

After settlement only payload-blind late-error guards remain on still-open
streams/processes; each removes itself on that emitter's `close`. They protect
against write callbacks scheduling a later `EPIPE` error event and retain no
client state. The process `exit` event alone does **not** close the client:
T2/shared settlement drains trailing stdout for its bounded grace period, then
closes the transport and performs process-tree cleanup. T2 owns the 10-minute
semantic inactivity deadline, bounded early-turn event buffering, and the shared
10-second cleanup/interrupt deadline. There is no total turn-duration cap.

For active cancellation, T2 sends `turn/interrupt` and waits for the matching
terminal event within its shared stop deadline before calling `close`.
Aborting a request's `signal` closes the whole transport immediately; it is
appropriate for aborting setup, not for performing graceful active-turn interrupt.

## Verified wire shapes

Stdio transport is `codex app-server --listen stdio://`, one JSON object per line.
Omit the `jsonrpc` header. Responses echo IDs exactly (string and integer IDs are
distinct). The client generates monotonically increasing `chorus-<integer>` IDs.

| Method | Parameters / result |
| --- | --- |
| `initialize` | `{clientInfo:{name,version,title?},capabilities:{experimentalApi:false}}`; result includes `userAgent`, `codexHome`, `platformFamily`, `platformOs` |
| `initialized` | Notification after successful initialize; no ID, params optional |
| `thread/start` | `{cwd,approvalPolicy:"never",sandbox,model?,config?}`; result includes `thread.id`, effective `model`, `reasoningEffort`, `sandbox`, `approvalPolicy`, `cwd` |
| `thread/resume` | Same overrides plus required `threadId`; optional `excludeTurns:true` avoids returning old turn contents |
| `turn/start` | `{threadId,input:[{type:"text",text,text_elements:[]}],cwd,approvalPolicy:"never",sandboxPolicy,model?,effort?}`; result is `{turn:{id,items,status,...}}` |
| `turn/interrupt` | `{threadId,turnId}`; result `{}` acknowledges the request, not terminal completion |

`thread/start`/`resume` sandbox values are `"read-only"` and
`"danger-full-access"` for the existing Chorus restricted/yolo modes.
`turn/start` uses **different field/value shapes**:
`sandboxPolicy:{type:"readOnly",networkAccess:false}` or
`sandboxPolicy:{type:"dangerFullAccess"}`. Apply current daemon policy to both
start and resume; do not inherit an old thread's permission posture.

| Notification | Shape used by T3 |
| --- | --- |
| `thread/started` | `params.thread.id` |
| `turn/started` | `params:{threadId,turn:{id,items,status,...}}` |
| `item/agentMessage/delta` | `params:{threadId,turnId,itemId,delta}` |
| `item/completed` | `params:{threadId,turnId,completedAtMs,item:{id,type:"agentMessage",text,phase?}}` |
| `thread/tokenUsage/updated` | `params:{threadId,turnId,tokenUsage:{total,last,modelContextWindow?}}` |
| `turn/completed` | `params:{threadId,turn:{id,items,status,error?,...}}` |

Assistant phases are `"commentary"` and `"final_answer"` or null/absent.
Completed snapshots are authoritative; deltas and duplicate snapshots must not
duplicate transcript items. Turn statuses are `"inProgress"`, `"completed"`,
`"failed"`, `"interrupted"`. Terminal errors may include `message`,
`codexErrorInfo` and `additionalDetails`; raw error text is not safe to log.

Usage `total` and `last` breakdowns contain `inputTokens`, `cachedInputTokens`,
`outputTokens`, `reasoningOutputTokens`, `totalTokens`; `cacheWriteInputTokens`
is optional with a schema default of zero. Chorus should still preserve a
missing counter as unknown/null rather than inserting that default.
`total` is the cumulative thread snapshot; `last` is the last model-request
snapshot, not a whole tool-using turn. No trusted pre-turn token total field
exists in the inspected thread setup result. T3 should use a trusted same-thread
persisted baseline, or seed/omit usage on a resumed thread without one.

## Headless server requests

`headlessResponseFor(method)` exports the schema-checked policy below as
`{result}` or `{error,fatal:true}`. Every response echoes the original request ID.
Every automatic denial/unsupported request produces a fixed diagnostic.

| Server method | Response |
| --- | --- |
| `item/commandExecution/requestApproval` | `{decision:"cancel"}` |
| `item/fileChange/requestApproval` | `{decision:"cancel"}` |
| `item/permissions/requestApproval` | `{permissions:{},scope:"turn"}` (grant nothing) |
| `mcpServer/elicitation/request` | `{action:"cancel",content:null}` |
| `execCommandApproval`, `applyPatchApproval` | `{decision:"abort"}` (legacy schema) |
| `item/tool/call` | `{contentItems:[],success:false}` |
| `item/tool/requestUserInput` | RPC error `-32603`, then fail/close |
| `account/chatgptAuthTokens/refresh`, `attestation/generate` | RPC error `-32603`, then fail/close |
| Unknown method | RPC error `-32601`, then fail/close |

The user-input response schema only defines `answers`; there is no cancellation
field. An empty answer map would fabricate a response without proving cancellation,
so the client fails the wake. Auth/attestation have no safe negative result in
the inspected schemas either. Unsupported requests first get a bounded error
write; no turn may be submitted while that write is pending. T2 observes
`failure` and performs bounded tree cleanup. There are no terminal prompts.

## History fallback and config compatibility

The real missing-thread probe returned:

```json
{"id":2,"error":{"code":-32600,"message":"no rollout found for thread id 00000000-0000-4000-8000-000000000000"}}
```

`isHistoryUnavailableError(error, requestedThreadId)` returns true only for a
typed `RPC_ERROR` from **`thread/resume`**, code `-32600`, with that exact message
and matching requested ID. No broader missing/deleted/incompatible-history error
has been verified. Generic `-32600`, authentication/configuration/provider errors,
timeouts, EOF and IO errors must retain the old mapping and fail normally.
The live `turn/interrupt` error `thread not found: <id>` and repeated-initialize
error `Already initialized` also use `-32600` and are deliberately excluded.

Thread setup accepts top-level `model` and `modelProvider`; `config` is an object
of arbitrary JSON config overrides. Existing `-m/--model` selection must map to
app-server config (`-c model=...`) and/or thread/turn `model`, not be passed as
an exec-only flag after the app-server subcommand. Apply it on resume too.
`model_reasoning_effort` remains a config key; turn-specific override is `effort`.
The inspected `ReasoningEffort` schema is a nonempty string, not a fixed enum;
actual supported effort depends on the selected model.

Preserve permitted literal `-c/--config key=value` arguments without reparsing or
logging values. App Server transport selection (`--listen`) and alternate
code-mode host selection remain daemon-owned. Exec-only `--json`,
`--skip-git-repo-check`, exec/resume positional commands, output flags, prompt
positionals, and unsupported exec subcommand switches must be consumed by an
explicit verified translation or rejected with a value-free diagnostic, not
silently forwarded/dropped. CLI argument filtering/translation is T2 scope;
this client has no argv parser and grants no extra configuration authority.
Config loading, hooks/MCP behavior and model execution need T4 live integration.

## Verification artifacts

- `cli/__tests__/codex-app-server-client.test.mjs`: deterministic Vitest transport
  and failure-path tests; run
  `pnpm exec vitest run cli/__tests__/codex-app-server-client.test.mjs`.
- `cli/__tests__/fixtures/codex-app-server/handshake-0.157.1.json`: real Linux
  initialize/initialized, missing resume, missing interrupt, repeated initialize.
  Empty temporary `CODEX_HOME`, scratch cwd, no credentials, no model turn.
  Paths, host, installation ID and user-agent platform text are sanitized;
  notification wall-clock timestamps are removed.
- `cli/__tests__/fixtures/codex-app-server/schema-examples-0.157.1.json`:
  **synthetic** setup/turn/event/negative-response examples, each validated against
  its named generated 0.157.1 schema with Python `jsonschema`. They do not claim
  live model, usage, approval, old-exec continuity, or hook execution.

All 11 captured live frames additionally validate against the generated generic
RPC envelopes. A second isolated live probe used the implemented client itself:
initialize succeeded, initialized notification flushed, missing-history
classification passed, pending count returned to zero, stdin closed and child
exited. No model/provider request was made. T4 owns real turn/usage/old-exec
continuity, hook behavior and platform integration checks.
