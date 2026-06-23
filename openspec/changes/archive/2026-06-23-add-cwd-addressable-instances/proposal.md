## Why

The daemon multi-path engine (PR #353) made `cwd` a first-class dimension of connection identity — the unique key is now `(agentUuid, clientType, host, cwd)`, so one daemon can serve several working directories and each `(agent, host, cwd)` is a distinct, independently-online instance. But the frontend never caught up: `ConnectionView.cwd` is fetched and rendered **nowhere**, while `host` is shown everywhere — exactly inverted from the model. Users can see that "an agent" is online but cannot see, choose, or address *which working directory* a turn will run in. This change closes that gap: it makes each `(agent, host, cwd)` instance visible and individually addressable across presence, @-mention, task assignment, and ad-hoc send.

## What Changes

- **Presence drill-down**: the agent-presence popover / connections list keeps one row per agent but expands to one sub-row per live instance, each showing its own `cwd` (primary, path-first) and online state. Legacy connections that report no cwd render as an explicit "unknown path" instance.
- **Path-first, host-conditional display**: `cwd` becomes the primary per-instance label on every surface (a monospace path chip). `host` is **not** removed (it is part of the unique identity — the same path on two machines is two real instances) but is de-emphasized: shown once at the agent header for single-host agents, and promoted to a per-row suffix only when the agent spans 2+ hosts.
- **Path/host truncation rule**: paths truncate from the **left** (keep the final repo/working-dir segment, leading ellipsis); hosts truncate from the **right** (capped width, trailing ellipsis); status/tag/action controls never shrink. Full value on hover.
- **@-mention instance targeting**: a mention stays `@agent`; when that agent has 2+ live instances a secondary picker lets the owner choose which `(host, cwd)`; a single live instance auto-selects with no extra click. The chosen instance is pinned to the mention.
- **Task-assignment cwd pin**: assigning a task to an agent can pin which instance runs it. An **offline** instance is selectable here (durable intent) — the turn queues and backfills on reconnect.
- **Ad-hoc send instance pick**: the immediate "send now" flow lets the owner pick an instance, but an **offline** instance is **disabled** — live sends require the instance online, matching today's 409-if-offline gate. (The deliberate contrast with task assignment.)
- **Autonomous wake honors a pinned cwd**: when a `task_assigned` / `mentioned` notification wakes an agent, the wake routes to the pinned `(host, cwd)` instance if one was chosen; otherwise it falls back to today's online-first selection. No `project → cwd` inference (parent idea DEC-5).
- **Chat header surfaces cwd**: the transcript header shows the session's `cwd` inline as its instance identity; `host` stays in the existing "Connection details" disclosure, surfaced inline only when cross-host.

## Capabilities

### New Capabilities

- `daemon-cwd-instance-addressing`: a daemon instance is identified by `(agent, clientType, host, cwd)`; this capability defines how every owner-facing surface (presence, @-mention, task assignment, ad-hoc send, chat header) displays the instance path-first / host-conditional, how paths and hosts are truncated, how an owner pins a target instance, the durable-intent-queues vs live-requires-online split for offline targets, and how the autonomous wake honors a pinned cwd without inferring it from the project.

### Modified Capabilities

- None. This change is additive: it layers instance-addressing behavior on top of the existing `agent-connection-observability`, `mention-agent-liveness`, and `daemon-instruction-injection` capabilities without changing their established requirements. The connection registry, read API, liveness rule, and live-delivery contract are reused as-is.

## Impact

- **Frontend (primary)**: `agent-presence-pill.tsx`, `agent-presence/connections-view.tsx`, `agent-presence/identity-block.tsx`, `agent-presence/chat/transcript-view.tsx`, `mention-editor.tsx`, `send-instruction-box.tsx`, plus a new shared cwd/host formatting helper and a small instance-picker component. New i18n keys in `en.json` + `zh.json`.
- **Backend**: a persisted "pinned target instance" on the dispatch path so the autonomous wake (`notification-turn.ts`) can honor it (data-model choice detailed in design.md); the ad-hoc/instruction send paths thread a chosen `connectionUuid`/cwd; mention resolution exposes per-instance candidates. No new permission bit. Any schema change goes through a Prisma-CLI migration (no hand-written SQL, DDL-only).
- **Reused unchanged**: `DaemonConnection` identity key, `effectiveStatus` / `STALE_THRESHOLD_MS`, the persisted-turn backfill net, the `claude --resume` cwd/host binding constraint.
- **Design**: `docs/design.pen` already updated with the four path-aware screens + truncation spec (Path Chip component, presence drill-down, @mention picker, assign-task pin, ad-hoc send, chat header).
