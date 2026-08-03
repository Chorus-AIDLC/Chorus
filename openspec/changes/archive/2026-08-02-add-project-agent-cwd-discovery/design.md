## Context

Today each daemon startup cwd owns an SSE connection, `AgentInstance`, `Waker`, transcript namespace, and session origin. Wake preview and assignment persist an `agent_instance` only after choosing an already-online `(host, cwd)`. Project settings have no Agent cwd configuration, and the reverse control channel is server-to-daemon fire-and-forward with no correlated response.

The requested flow must discover directories that are not startup connections, pin a project default for several Agents independently, and run in the selected cwd. A path is host-local: storing only a string is ambiguous across hosts, while storing only `AgentInstance.uuid` cannot represent an unregistered path.

## Goals / Non-Goals

**Goals:**

- Let a host operator bound discovery independently from startup `cwds`.
- Browse one directory level at a time without leaking hidden, inaccessible, symlinked, or out-of-root paths.
- Persist a fixed cwd per user, project, and Agent, including its host identity.
- Make a fixed cwd authoritative until explicitly cleared.
- Preserve transcript/session cwd consistency when running in a discovered path.
- Expose deterministic pending/success/error states to project settings.

**Non-Goals:**

- A general remote filesystem browser or file API.
- Server-side expansion of a daemon's browse allowlist.
- Symlink traversal, hidden-directory browsing, stale-result caching, or cross-host path inference.
- Persisting project-to-cwd bindings in `daemon.json`.

## Decisions

### Separate served cwds, browse roots, and project pins

`cwds` remains the daemon's startup connection set. `browseRoots` is a host-local maximum disclosure boundary. Project pins are server-side user preferences keyed by `(userUuid, projectUuid, agentUuid)` and store `host`, normalized `cwd`, and the validating Agent instance used as the host anchor.

This preserves ownership: the host controls exposure, while each user controls project defaults. One project can have independent pins for multiple Agents.

### Resolve browse roots once at daemon startup

Resolution is `--browse-root` > `CHORUS_DAEMON_BROWSE_ROOTS` > `daemon.json.browseRoots` > OS user home. `chorus daemon install --browse-root` persists the normalized list using the existing field-merge writer. Direct file edits require restart. Service units do not embed roots.

### Use a correlated persisted control request

The server creates a short-lived `DaemonDirectoryRequest` row with a request UUID, target connection, prefix, limit, and deadline, then dispatches `browse_directory` over the existing per-connection control channel. The daemon validates and scans locally, then reports success or a typed error through the authenticated daemon REST client. The UI polls the request endpoint until terminal state.

A persisted row works across multiple web processes, survives an SSE reconnect long enough to report a clear timeout, and avoids holding HTTP requests open across the event bus.

### Normalize and authorize before and after filesystem access

The daemon expands `~`, requires an absolute normalized prefix, derives parent and basename, and uses `lstat`/directory access checks. It rejects symlinks and verifies the parent and every returned candidate remain under a configured root using path-component-aware containment. Hidden entries and inaccessible entries are omitted. Results contain direct child directories only, sorted by normalized name, with an opaque cursor and hard result/time limits.

The server authorizes the caller against the target Agent owner/company before dispatch and never accepts a client-selected connection outside that Agent.

### Represent a project pin as host plus cwd, not a startup instance

`ProjectAgentCwdPreference` stores the owning user, project, Agent, host, normalized cwd, and the anchor instance UUID used to verify that host. The durable semantic identity is `(agentUuid, host, cwd)`; the anchor instance is transport metadata and may change.

Saving performs a fresh daemon validation request. Clearing deletes the preference. Invalid/offline pins remain visible with a typed status rather than silently falling back.

### Add directed runtime cwd to the daemon execution contract

When a fixed or temporary discovered path is selected, the server targets any online connection for the same Agent and host and includes `runtimeCwd` in a directed wake/control payload. The daemon owns a per-runtime-cwd Waker/session context cache and passes that exact cwd to transcript probing and spawn. `DaemonSession` records `runtimeCwd`; later turns and resume use the same value and origin connection.

The daemon validates `runtimeCwd` against current browse roots again immediately before execution. It does not add the path to startup `cwds` or mutate `daemon.json`.

Alternative considered: dynamically register every selected path as a normal SSE connection. Rejected because a project preference would mutate daemon process topology, create unbounded connections, and still need restart recovery.

### Fixed pins are sticky

Resolution order is:

1. A valid project-Agent fixed preference.
2. A temporary cwd explicitly selected for the current operation when no fixed preference exists.
3. Existing instance selection/auto-pin behavior.

Once fixed, workflows do not prompt and cannot override it inline. The user must clear or replace the pin in project settings. This supersedes the earlier single-operation override answer.

When no fixed preference exists, the existing instance picker retains its registered-cwd choices and adds a "Browse another directory" action. That action selects an online Agent host, invokes the same prefix-discovery flow, validates the final path, and passes `runtimeCwd` only to the current operation. It does not create a preference or mutate the Idea/Task assignee into a fabricated `AgentInstance`.

## Data Model

- `ProjectAgentCwdPreference`: unique `(userUuid, projectUuid, agentUuid)`; `host`, `cwd`, optional `anchorAgentInstanceUuid`, timestamps.
- `DaemonDirectoryRequest`: request UUID, company/caller/agent/connection identifiers, operation (`list` or `validate`), prefix/cwd, cursor/limit, status, result JSON, error code, deadline, timestamps.
- `DaemonSession.runtimeCwd`: nullable for backward compatibility; set for directed runtime-cwd sessions.

Project deletion cascades preferences. Agent/user deletion removes preferences. Request rows are short-lived and periodically pruned.

## API and Module Contracts

- Project cwd preference API: list Agents and preference states; upsert after daemon validation; clear.
- Directory request API: create authorized list/validate request and read its terminal state.
- Daemon report API: authenticated completion by request UUID, accepted only from the targeted connection/Agent.
- Typed errors: `HOST_OFFLINE`, `TIMEOUT`, `INVALID_PATH`, `OUTSIDE_ROOT`, `NOT_DIRECTORY`, `ACCESS_DENIED`, `STALE_TARGET`, `LIMIT_EXCEEDED`, `INTERNAL_ERROR`.
- Result entries: `{ name, path }`; no filesystem metadata beyond what the picker needs.
- Every runtime wake resolves one effective cwd and records it before dispatch; probe, spawn, resume, and subsequent turns use that same value.

## Risks / Trade-offs

- [Anchor connection disconnects mid-request] -> deadline plus `HOST_OFFLINE`/`TIMEOUT`; no stale cache.
- [TOCTOU path changes] -> validate at browse time, save time, and immediately before spawn.
- [Large directories consume resources] -> hard scan/time/result limits, stable cursor, one-level scans only.
- [Runtime cwd diverges from session origin] -> persist `DaemonSession.runtimeCwd` and make it the sole cwd source for directed sessions.
- [Sticky pin points to an offline host] -> surface the pin as offline and block the wake; never reroute to another host or cwd.
- [Cross-platform paths] -> daemon performs platform-native normalization; server treats normalized paths as opaque host-local strings.

## Migration Plan

1. Add nullable schema and request/preference tables.
2. Ship daemon config and discovery handlers with backward-compatible control enums.
3. Ship server APIs and runtime-cwd routing.
4. Add project settings and workflow consumption.
5. Existing users have no preferences, so existing wake behavior remains unchanged.

Rollback disables the new UI and directed runtime-cwd dispatch; nullable session data and preference rows may remain without affecting legacy routing.
