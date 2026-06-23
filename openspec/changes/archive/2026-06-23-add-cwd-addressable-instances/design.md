# Design — cwd-addressable daemon instances

## Context

PR #353 made `cwd` part of `DaemonConnection`'s unique identity: `@@unique([agentUuid, clientType, host, cwd])`. `listConnectionsForAgent` already returns multiple cwd connections per agent, each with `cwd` (nullable) + `effectiveStatus`. What's missing is entirely above the registry: the UI never renders `cwd`, and the dispatch path never lets an owner choose which instance.

Two hard constraints inherited from the parent idea, unchanged here:
- **DEC-5**: no `project → cwd` inference. The owner explicitly picks the instance; the server never derives it from the project.
- **`claude --resume` is cwd/host-bound**: a session's `originConnectionUuid` is fixed at creation and never re-routed. Continuation always goes back to the connection that owns the on-disk transcript.

## Goals / Non-goals

**Goals**: render every `(agent, host, cwd)` instance path-first; let owners pin a target instance for @-mention, task assignment, and ad-hoc send; make the autonomous wake honor a pinned cwd; consistent path/host truncation.

**Non-goals**: multi-daemon coordination, dynamic path add/remove, per-task sandboxes (these are derived idea B). No change to the resume routing constraint. No new permission bit.

## Key decision 1 — where the "pinned target instance" lives

Q2=c + Q3=b + Q7=c together require that the instance an owner picks at **mention / assignment** time is read by the **autonomous wake** later (`notification-turn.ts`, which today picks the first online connection). The pin must therefore be persisted on the dispatch trigger, not only on the live send.

**Decision**: persist the pinned target as a **nullable `targetCwd` (string) + `targetHost` (string)** pair on the wake trigger, resolved to a concrete `connectionUuid` at wake time (not a stored `connectionUuid`, because connections churn — a daemon restart yields a new connection row for the same `(host, cwd)`, and we want the pin to survive that). Specifically:

- **Task assignment**: a nullable `assignedCwd` / `assignedHost` on the assignment (the existing assignee fields gain two optional siblings). When a `task_assigned` notification wakes the agent, `notification-turn.ts` resolves the live connection matching `(agentUuid, host, cwd)` and pins the session origin there; if none matches (or none pinned) it falls back to online-first.
- **@-mention**: the pinned `(host, cwd)` travels with the mention so the `mentioned` wake resolves the same way. Mentions are stored in the comment body as `@[name](type:uuid)`; the instance pin is carried as an additional, optional structured field on the mention record / wake notification metadata (additive — a mention with no pin behaves exactly as today).

Rationale for `(host, cwd)` over a stored `connectionUuid`: the pin is a *durable intent to run in a place*, and "a place" is `(host, cwd)`, which is stable across daemon restarts; a `connectionUuid` is ephemeral. Resolution to a live connection happens at wake time against the current registry.

## Key decision 2 — offline target: durable-intent-queues vs live-requires-online

- **Durable intent** (mention-pinned, assignment-pinned): allow selecting an offline instance. The wake creates the pending turn anyway; the existing persisted-turn backfill net delivers it when that `(host, cwd)` daemon reconnects. This is just the existing reconnect-backfill behavior, now keyed to a specific instance.
- **Live ad-hoc send** ("send now"): keep today's gate — the chosen instance must be online or the call is rejected (409), because it is an interactive immediate action. The ad-hoc path already takes an explicit `connectionUuid` and already 409s on offline; this change only surfaces the cwd in its picker and disables offline rows in the UI.

This split is the single most load-bearing UX contract of the feature and is mirrored visually in design.pen (assign-task screen allows offline + "will queue"; ad-hoc send disables offline).

## Key decision 3 — path-first, host-conditional display + truncation

- `cwd` is the primary per-instance label everywhere, rendered as a monospace path chip showing the **abbreviated tail (last 2 segments)**; full absolute path on hover/title.
- `host` is part of identity and is **not removed**. It is de-emphasized: shown once (dimmed) at the agent header for single-host agents; promoted to a per-row dimmed monospace suffix only when the agent has live instances on 2+ distinct hosts. Dispatch/mention/send target confirmations include host only when it disambiguates.
- Legacy `cwd = null` (old daemon) renders as an explicit "unknown path" instance, still individually selectable/addressable.

**Truncation contract** (a shared helper, since none exists today — all host display is currently inline empty-string coercion):
- `formatCwd(absPath)`: returns the last 2 path segments; if still over the chip's max width, drop leading segments with a leading ellipsis but **always keep the final segment whole** (it's the actual repo/working dir). Title = full absolute path.
- `formatHost(host)`: truncate from the right with a trailing ellipsis, capped at a fixed max width (≈120px) so host never crowds the path. Title = full host. `""` host → localized "unknown host" placeholder (existing behavior preserved).
- **Row integrity**: status dot, Queue/offline tag, and the radio/check control are pinned to row edges and never shrink; only the path (then host) flex-shrinks. When both are long, the path keeps shrink priority — it is the primary identity.

## Module contracts

- **`formatCwd` / `formatHost`** (new shared util, e.g. `src/lib/daemon-instance-format.ts`): pure functions, unit-tested against long-path / long-host / null-cwd / empty-host cases.
- **Presence rendering** (`agent-presence-pill.tsx`, `connections-view.tsx`, `identity-block.tsx`): group `listConnectionsForAgent` output by agent; render the per-agent header (with host once if single-host) and an expandable list of instance rows. Reuse `effectiveStatus` per row.
- **Instance picker** (new small component): given an agent's live instances, render a path-first selectable list; used by both the @-mention secondary picker and the assign-task / ad-hoc surfaces. Single instance auto-selects. Offline-selectability is a prop (true for durable intent, false for live send).
- **Mention resolution** (`mention.service.ts`): expose per-instance metadata so the picker can list `(host, cwd)` options for an agent with 2+ live instances. Additive to the existing `Mentionable` shape.
- **Wake routing** (`notification-turn.ts`): after resolving the agent, if the trigger carries a pinned `(host, cwd)`, resolve the matching live connection and pin the session origin there; else online-first as today. Never infer from project.
- **Chat header** (`transcript-view.tsx`): promote the session's cwd (path chip) inline; keep host in the "Connection details" collapsible, inline only when cross-host.

## Risks

- **Pin resolves to no live connection**: handled by fallback (online-first for live wakes) or queue+backfill (durable intent). Never a hard failure; never silently drops the turn.
- **HARD-1 (legacy daemons)**: old daemons reporting no cwd must keep working — they appear as "unknown path", are still addressable, and the online-first fallback covers them. No behavior regression for single-path / single-host setups.
- **i18n**: every new string (picker labels, "unknown path", "will queue", offline tooltips, truncation titles) localized in `en` + `zh`.
- **Migration**: the `targetCwd`/`targetHost` (and `assignedCwd`/`assignedHost`) columns ship via a Prisma-CLI migration, nullable, non-breaking, DDL-only (no backfill DML).
