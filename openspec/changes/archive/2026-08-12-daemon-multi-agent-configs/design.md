# Technical Design: Daemon multi-agent configs

## Overview

Generalize the daemon from **one credential × N cwds** to **N independent agents, each with its own credential × its own cwds**. The seam is `buildDaemon` in `cli/daemon.mjs`: today it constructs a single `creds`, a single `ChorusClient`, a single spawner, and one `WakeQueue`, then fans out `cwdSet.map(buildConnection)`. We change the fan-out to iterate over a **list of resolved agent configs**, building each agent's runtime independently and then mapping that agent's own cwds to connections.

No server-side change: `DaemonConnection` and `AgentInstance` are already unique on `(agentUuid, host, cwd)`, and each agent authenticates with its own `apiKey` (→ its own `agentUuid` via `chorus_checkin`), so N agents register as N distinct connection/instance rows automatically.

## Config model

### `daemon.json` shape (additive)

```jsonc
{
  // Top-level fields remain valid and act as DEFAULTS for every agent.
  "url": "https://chorus.example.com",
  "sigintTimeoutMs": 8000,

  "agents": [
    {
      "apiKey": "cho_aaa...",          // required (per agent)
      "url": "https://chorus.example.com", // optional; defaults to top-level url
      "agentType": "claude-code",       // optional; defaults to top-level agent / claude-code
      "cwds": ["/home/u/projA", "/home/u/projB"],
      "permissionMode": "yolo",         // optional; defaults to global posture
      "maxConcurrency": 4,              // optional; defaults to global / 4
      "sigintTimeoutMs": 8000,          // optional; defaults to top-level
      "browseRoots": ["/home/u"]        // optional; defaults to top-level
    },
    { "apiKey": "cho_bbb...", "agentType": "kiro", "cwds": ["/home/u/projC"] }
  ]
}
```

### Resolution contract (`cli/daemon-config.mjs` + `cli/credentials.mjs`)

- New resolver `resolveAgentConfigs(flags, deps)` returns `AgentConfig[]` where
  `AgentConfig = { url, apiKey, agentType, cwds: (string|undefined)[], permissionMode, maxConcurrency, sigintTimeoutMs, browseRoots }` — every field already merged with its default.
- **Precedence for the agent list**: (1) if `daemon.json.agents[]` is a non-empty array → use it, each entry merged over top-level defaults; (2) else → **one** agent synthesized from the existing flat resolution (`resolveCredentials` + `resolveDaemonCwds` + `resolveAgentType` + …). This is the back-compat path and MUST be byte-for-byte behavior-equivalent to today for a flat file.
- CLI flags / env (`--url`, `--api-key`, `--agent`, `--cwd`, `CHORUS_*`) continue to resolve the **flat/default** layer only. When `agents[]` is present, flags fill defaults that per-agent fields may override. (Flags targeting a *specific* agent are out of scope; manage per-agent via the file or `login --add`.)
- Per-agent `maxConcurrency` default is `4` (the current hardcoded `WakeQueue` default in `daemon.mjs`), now surfaced as config.
- Validation: each agent MUST have a non-empty `apiKey` and a resolvable `url`; `agentType` MUST be a known type (reuse `daemon-agent.mjs` validation) or the daemon exits non-zero naming the offending agent (no silent fallback).

## Runtime architecture (`buildDaemon` fan-out)

For each `AgentConfig` the daemon builds an independent **agent runtime**:

- `checkin` with that agent's `apiKey` → its `{ agentUuid, agentName }` (per-agent identity; shown in the banner as one line per agent).
- `new ChorusClient({ url, apiKey })` and `new LineageResolver({ url, apiKey })` bound to that agent.
- `selectSpawner(agentType, { logger, permissionMode, creds })` per agent — so Claude / Codex / Kiro spawners can coexist in one process, one per agent as needed.
- `new WakeQueue({ maxConcurrency })` **per agent** (was one process-wide queue). Serialization-per-direct-idea still holds within an agent; the cap now bounds each agent independently.
- Connections: `agent.cwds.map(cwd => buildConnection(agent, cwd, i))` — each connection carries this agent's creds, its own `SseListener` (self-reporting `(clientType, host, cwd)`; `agentUuid` is derived server-side from the Bearer key), REST client, reporters, hooks, `EventRouter`, and `Waker`.

Total connections = Σ over agents of that agent's cwd count. Each agent's SSE stream, wake queue, and spawner are isolated; a crash or auth failure in one agent's runtime is logged and does not tear down the others (existing "one failed wake does not kill the daemon" guarantee extended to per-agent isolation).

## Per-backend credential delivery (the crux)

The whole feature hinges on delivering a **different key per agent** to the spawned subprocess. Mechanisms differ by backend (verified against the code + installed CLIs):

| Backend | Delivery | Per-agent key |
|---|---|---|
| **claude-code** | Per-wake temp `--mcp-config <file>` with `url` + `Bearer <key>` inline (`mcp-config.mjs`, `waker.mjs`) | ✅ Free — the file is written from that agent's creds each wake; nothing shared |
| **kiro** | Static `mcp.json` with `Authorization: Bearer ${env:CHORUS_API_KEY}` (+ optionally `${CHORUS_URL}`), interpolated by Kiro at runtime from the per-spawn env | ✅ Works — daemon exports that agent's key/url into the child env per spawn (`kiro-spawner.mjs`). Keep the installer's `mcp.json` in `${CHORUS_URL}` template form so URL is per-agent, not a baked literal |
| **codex** | Static install-time `~/.codex/config.toml` with a **literal** Bearer key; Codex does **not** expand `${VAR}` in headers | ⚠️ Not automated in v1 — key is **user-managed** in the operator's Codex config; the daemon still exports `CHORUS_*` env (for the plugin's `chorus-api.sh`, not Codex MCP). Two Codex agents with *different* keys need operator-provided separate `CODEX_HOME` dirs |

**Module contract — env export.** Every spawner (`claude`/`codex`/`kiro`) MUST derive `CHORUS_URL` / `CHORUS_API_KEY` (and `CHORUS_SESSION_ID`) for the child env from **the spawning agent's creds**, not a process-global. This is already per-connection today; it must follow the per-agent creds after the fan-out.

**Codex comment fix.** `codex-spawner.mjs:18` claims the daemon feeds the configured `bearer_token_env_var` — but the installer writes a literal header and Codex ignores env in headers. Update the comment to state the real behavior (env is for plugin shell scripts; MCP key is user-managed in config.toml).

## cwd overlap policy

Different agents MAY declare the same or overlapping cwd. The daemon does not detect or serialize this. Because each agent has a distinct `agentUuid`, the server-side `(agentUuid, host, cwd)` uniqueness does not collide, and the existing per-agent registration-conflict guard (same `agentUuid`, different clientType) is unaffected. Concurrent work in a shared git tree by two agents is the operator's responsibility to avoid (separate branches / worktrees). This is documented, not enforced.

## Registration UX (`cli/login.mjs`)

- `chorus login --add`: validate the new key against the server (fetch identity, masked entry), then **append** an agent object to `daemon.json.agents[]` via the existing field-merge writer (`updateDaemonConfig`). If the file is still flat single-agent, first migrate the flat fields into `agents[0]` (so the added key becomes `agents[1]`), or leave flat + add `agents[]` — chosen so the resulting file is unambiguous. Never overwrite an existing agent's key.
- Install wizard: allow adding multiple agents in one run.
- Manual editing of `daemon.json` remains fully supported.

## Risks & Mitigations

- **Back-compat regressions** — the single-agent path must stay identical. Mitigation: the flat→one-agent synthesis reuses the existing resolvers verbatim; a regression test asserts a flat file yields exactly one agent runtime with today's behavior.
- **Resource blow-up** — N agents × their cwds × per-agent concurrency can spawn many subprocesses. Mitigation: per-agent `maxConcurrency` (default 4) bounds each agent; operators size it. Documented.
- **Codex key confusion** — operators may expect the daemon to inject Codex keys per-agent. Mitigation: explicit docs + the honest limitation stated in the spec; single-Codex or shared-key Codex works, different-key multi-Codex needs `CODEX_HOME`.
- **Secret handling** — never write raw keys to argv (visible in `ps`) or to world-readable files; `daemon.json` stays `0600`; Claude's temp mcp.json stays `0600` and per-wake-cleaned.

## Implementation Plan

1. Config model + resolver + flat back-compat (foundation).
2. `buildDaemon` fan-out: per-agent identity, client, spawner, wake queue, connections.
3. Per-backend per-agent credential delivery (Claude file / Kiro env / Codex documented) + env export from per-agent creds + Codex comment fix + Kiro URL template.
4. Registration UX (`login --add` + wizard).
5. Integration checkpoint: two independent agents online, end-to-end + back-compat.
6. Docs.
