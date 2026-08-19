## Context

The daemon owns a backend-neutral `Spawner.wake(...)` lifecycle and already has Claude Code, Codex, and Kiro implementations. A dsh backend needs committed conversation events, a reliable idle boundary, token usage, environment-only credentials, and a live child handle that the existing execution registry can interrupt.

The installed `dsh` profile CLI is insufficient because its headless mode prints plain text. The dsh SDK JSON-RPC server exposes `initialize`, `session/prompt`, `session.event`, `session.status`, and `shutdown`, but it does not expose session resume or cancellation. Its server creates a new agent rather than loading persisted state. The packaged runtime also contains native dependencies and lacks Chorus's full release platform matrix.

## Goals / Non-Goals

**Goals:**

- Implement the existing Spawner contract for `agentType === "dsh"`.
- Preserve stdout as a protocol-only boundary and keep credentials out of argv.
- Forward root committed conversation messages and one per-wake normalized usage total.
- Reuse existing process-group interruption and daemon turn lifecycle machinery.
- Keep the Chorus npm package portable by treating the dsh runtime as an external executable.

**Non-Goals:**

- Resume dsh context between wakes or after daemon restart.
- Persist an anchor-to-dsh session map.
- Bundle, install, or update the native dsh runtime.
- Forward reasoning, tool activity, raw deltas, or descendant-session events.
- Add SDK/ACP protocol features upstream.

## Decisions

### Use the SDK JSON-RPC wire directly

`DshSpawner` launches `dsh-jsonrpc-agent` with piped stdio and speaks newline-delimited JSON-RPC. It sends `initialize`, then `session/prompt`, collects notifications through the root session's next `idle`, sends `shutdown`, closes stdin, and awaits process exit.

The implementation remains local JavaScript instead of adding the published dsh SDK client to Chorus. This avoids importing a peer-dependency graph into the portable Chorus package while keeping the wire small enough to implement and test with an injected child process.

ACP was rejected because it only supports fresh sessions and omits full events and usage. The normal headless CLI was rejected because it emits plain text.

### Require an external runtime and environment configuration

Executable resolution walks `PATH` for `dsh-jsonrpc-agent` and supports `CHORUS_DSH_PATH` as an explicit override. The runtime Cordis composition is selected through `CHORUS_DSH_CONFIG` or `DSH_CORDIS_CONFIG`; the spawner passes the selected value as `DSH_CORDIS_CONFIG` in the child environment.

`CHORUS_URL`, `CHORUS_API_KEY`, provider credentials, `DSH_CWD`, provider/model overrides, and runtime config remain in the environment. No prompt, credential, or config path is placed in argv. The prompt is sent only inside `session/prompt`.

Chorus-managed runtime dependencies were rejected because `node-pty` and `koffi` are native dependencies and the official runtime artifacts do not cover Chorus's complete platform matrix.

### Use one fresh process and random session per wake

Each `wake()` creates a random dsh session ID and reports `isNew: true`. `sessionDecision.probeIsAuthoritative` is false because Claude transcript probing cannot determine dsh state. There is no session map.

This preserves the current child lifecycle: `onChild` receives the exact runtime process, normal completion closes it, and the existing daemon interrupt path can kill its process group. A long-lived per-daemon runtime was rejected because it would require new routing, concurrency, ownership, eviction, and interrupt semantics. SDK resume was rejected for v1 because the upstream wire does not support it.

### Define a narrow dsh event dialect

For the root session only, the bridge emits committed `user/message` and non-empty `assistant/message` events to `onMessage`, preserving their dsh `data` and adding `session_id`.

Usage from every root `assistant/message.data.usage` in the activity interval is summed by disjoint category. At the idle boundary the bridge emits exactly one terminal frame:

```json
{
  "type": "dsh.turn.completed",
  "session_id": "<dsh-session-id>",
  "usage": {
    "inputTokens": 0,
    "outputTokens": 0,
    "cacheCreationTokens": null,
    "cacheReadTokens": null,
    "model": "<configured-model-or-null>",
    "source": "dsh"
  }
}
```

`cacheWriteTokens` maps to `cacheCreationTokens`; `cacheReadTokens` maps directly. Missing categories remain `null`, invalid values are ignored, and reasoning tokens are not added to output tokens. Internal events still contribute usage when they are committed assistant messages, including usage-only messages, even when no conversation frame is forwarded.

### Fail closed at the protocol boundary

The spawner tolerates split/multiple lines but treats malformed JSON, JSON-RPC errors, premature process exit, and missing idle/shutdown completion as a failed wake. Stderr is logged through the daemon logger and never parsed as protocol output. Unknown notifications are ignored unless required to complete the current request.

Missing executable or runtime config produces a visible diagnostic and a non-success result without crashing the daemon. Callback exceptions from `onChild` or `onMessage` are logged and contained, matching existing spawner behavior.

## Risks / Trade-offs

- **Fresh sessions reduce model continuity** -> Wake prompts and Chorus MCP resources remain the durable source of work context; true resume is deferred to a dedicated upstream/runtime change.
- **The external runtime may drift from the expected wire** -> Validate the initialize server identity, isolate JSON-RPC parsing, and cover malformed/error frames in tests.
- **User-managed Cordis config may omit required plugins** -> Fail visibly on initialization/prompt errors and document the required external runtime/config contract.
- **Usage can span multiple model steps** -> Aggregate only root committed assistant-message usage for the exact prompt-to-idle interval and emit one terminal total.
- **Platform support depends on the external installation** -> Probe rather than bundle; unsupported hosts receive deterministic install/config diagnostics while other daemon backends remain unaffected.

## Migration Plan

1. Land the sibling server/client-type registration first.
2. Add the spawner and bridge tests without changing the default backend.
3. Add `dsh` selection/probing and retain `claude-code` as the default/fallback.
4. Verify against a separately installed runtime and explicit Cordis config on a supported host.
5. Roll back by removing `dsh` from selection and leaving other spawners untouched.

## Open Questions

None for v1. Session resume and managed runtime distribution are explicit follow-up changes.
