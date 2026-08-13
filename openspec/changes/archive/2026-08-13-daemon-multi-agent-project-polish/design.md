# Technical Design: Polish multi-agent daemon project scope

## Overview

Three independent, small changes. Two are frontend-only over existing data; one
is a server-side addition to the wake cwd-resolution chain. No schema change, no
migration, no new permission bit, no API contract change.

## 1. Overview cwd badge — agent-identifiable (`project-agent-cwd`)

**Where:** `src/app/(dashboard)/projects/[uuid]/dashboard/project-cwd-summary.tsx`
(mounted from `dashboard-content.tsx` next to the project title).

**Today:** each badge renders only `preference.cwd` (truncated, `font-mono`) with
`title={`${agent.name}: ${preference.cwd}`}` — the agent name is visible only on
hover; the local `FixedCwdPreference` interface deliberately drops everything but
`agent.{uuid,name}` and `preference.cwd`.

**Target:** the visible badge content becomes a **colored agent identity dot +
the agent name**; the **cwd path moves into the hover tooltip** (`title`).

- The color dot MUST use the existing per-agent color helper
  **`getAgentColor(agentName)` from `src/lib/agent-color.ts`** (deterministic
  hash → `AGENT_COLOR_PALETTE`), whose palette is documented as "distinguishable
  on both light and dark backgrounds" — so no new hue function is introduced and
  no `dark:` variant is required for the dot. (Note: the presence roster's
  `PillDot` / `StatusDot` are *status*-colored, not per-agent — do NOT reuse
  those for identity; `getAgentColor` is the per-agent one.) The dot color is
  applied inline (data-driven); if any surrounding chrome needs a dark variant,
  follow the project's inline-CSS-variable + scoped `.dark` rule pattern.
- Keep the badge compact; `agent.name` may truncate but the dot + name make each
  badge distinguishable at a glance. The tooltip shows the full cwd path (and
  host when present).
- The dot color derives from `agent.name`, which the local `FixedCwdPreference`
  shape already carries — no new field and no API change. (`agent.uuid` is already
  the badge `key`.)

**Data source (unchanged):** `GET /api/projects/[uuid]/agent-cwds` →
`listAgentCwdOptions` already returns `agent.{uuid,name}`, `preference.{host,cwd,status}`.

**i18n / theme:** any new/relocated string uses `t()` in both `en` and `zh`; the
badge renders correctly in light and dark themes.

## 2. Autonomous wake resolves the agent-owner's project pin (`project-cwd-anchoring`)

**Where:** `src/services/notification-turn.ts` — `createTurnAndResolveTarget`
(the wake resolver). The new step lands here, **not** in `resolvePinnedTarget`
(the pre-selection precedence sub-chain that feeds `selectOriginConnection`) — see
"Why the project pin must NOT go into `resolvePinnedTarget`" below.

**Today (precedence).** `createTurnAndResolveTarget` does:
`pin = resolvePinnedTarget(ctx, trigger)` (pre-resolved target → temporary → mention
→ task instance-pin → own-idea pin → root-idea inheritance → `null`), then
`selection = selectOriginConnection(connections, pin)`. **Then a critical second
step (lines ~753-766): the idea-session-origin upgrade** — for autonomous
idea-anchored triggers, *when and only when* `selection.kind === "online_first"`
(i.e. the idea has no instance pin), selection is upgraded to the idea's existing
**online** session origin (where its conversation already lives). This is the fix
for the proposal-approve/reject random-cwd wake (b729713b). Only if that upgrade
finds nothing does the wake stay a raw first-online-connection pick ("first cwd").
The UI/mention/stage-advance paths pre-resolve the project pin and thread it via
`ctx.resolvedCwdSource`; a plain autonomous wake carries none, so today it skips
the project pin (the DEC-5 "never infer cwd from project" stance lives here).

**Why the project pin must NOT go into `resolvePinnedTarget`.** Returning a hard
pin there makes `selectOriginConnection` classify the selection `directed` /
`offline_pin`, which **bypasses** the session-origin upgrade (it only fires on
`online_first`). That would let a project pin override a live online conversation
and, with strict-offline, stall an idea whose conversation is online in cwd A to
notify-only when the project pin (cwd B) is offline — a regression of b729713b.

**Change (correct placement).** Add ONE new step in `createTurnAndResolveTarget`
**after** the idea-session-origin upgrade block, still gated on
`selection.kind === "online_first"` (so neither an instance pin nor an online
session-origin applied):

1. Only for the autonomous triggers (the `task_assigned` family already handled by
   the upgrade block). Require `ctx.projectUuid` and `ctx.recipientUuid` (both
   already on `WakeNotificationContext`).
2. Resolve the agent's **owner** (`Agent.ownerUuid`, company-scoped). Per the
   owner's elaboration decision, autonomous wakes use the **agent owner's** pin
   (the `ProjectAgentCwdPreference` is keyed per user).
3. Look up `ProjectAgentCwdPreference` by
   `(userUuid = agent.ownerUuid, projectUuid, agentUuid = ctx.recipientUuid)`,
   preferring to reuse `resolveProjectAgentCwdTarget`'s `project_fixed` branch
   (`project-agent-cwd.service.ts`) so normalization/anchor logic stays in one place.
4. If a preference exists → rebuild `selection = selectOriginConnection(connections,
   projectPin)` with a **hard** pin from its `(host, cwd)`: `directed` if that
   exact `(host, cwd)` is online, `offline_pin` if not.
5. If no preference exists → leave `selection` as `online_first` (unchanged).

**Resulting precedence:** instance pin → online idea-session-origin (b729713b) →
**project-owner pin (new)** → raw online-first. The project pin replaces exactly
the "first cwd" fallback the idea complains about, and never disrupts a live online
conversation.

**Offline behavior (owner decision Q3 = strict):** when the project pin's
`(host, cwd)` has no online connection, the resulting `offline_pin` means the wake
MUST NOT fall back to another cwd — it follows the existing fixed-anchor hard-pin
failure behavior (`suppressWake` / notify-only for a recoverable wake; reconnect
backfill only to the original host+cwd).

**Scope note:** autonomous wake path only. Paths that already thread a resolved
target (`ctx.resolvedCwdSource !== "unconfigured"`) never reach `online_first`, so
the new step cannot override them.

## 3. Presence count by distinct agent (`agent-connection-observability`)

**Where:** `src/components/daemon-presence-entry.tsx` (the single bottom-right
floating entry). It already derives `onlineAgentGroups` via
`groupConnectionsByAgent(onlineConnectionsOnly(connections, ...))` and renders
`.length`-worth of roster rows, but the pill *number* uses the provider's
`computeOnlineCount(connections)` (`agent-presence-context.tsx`), which counts
online **connections** `(agent, host, cwd)`.

**Change:** the pill's displayed number and its `onlineUnit` pluralization use
the **distinct online agent** count — `onlineAgentGroups.length` — so an agent
online across multiple hosts/cwds counts once. Dedup keys on `agentUuid` (stable),
never `agentName` (nullable / can collide). The existing `onlineUnit` string
("{count} agents online") already matches this unit.

**Kept as-is:** `computeOnlineCount` and the connection-oriented "View all" modal
(`connections-view.tsx`) — the modal is a connection list and its counts stay
connection-based. If the implementer finds the modal *labels* its number
"agents", make it unit-consistent there too; otherwise leave it.

**Tests:** update the specs that lock the current per-connection semantics —
`agent-presence-context.test.tsx`, `instance-group.test.ts`,
`daemon-presence-entry.test.tsx` — to assert distinct-agent counting for the pill.

## Module Contracts

- The badge (Task 1) and the count (Task 3) are independent frontend surfaces;
  neither shares state with the other.
- The wake fallback (Task 2) is server-side only and does not touch either
  frontend surface.
- All three tasks are independently runnable/testable and have no ordering
  dependency.

## Risks & Mitigations

- **Reversing DEC-5.** Intentional and scoped to the autonomous wake path; the UI
  paths already resolve the project pin, so this makes the two paths consistent
  rather than introducing new divergence. Documented in `notification-turn.ts`
  where the DEC-5 note lives.
- **Wrong owner's pin.** The preference is per-user; using the agent owner's pin
  is the owner's explicit decision. If the agent owner has no pin for this
  (project, agent), behavior is unchanged (online-first).
- **Count change breaks existing tests.** Expected — the tests encode the old
  semantics; they are updated as part of Task 3, not worked around.
- **Dark-theme dot color.** `getAgentColor`'s `AGENT_COLOR_PALETTE` is already
  chosen to read on both light and dark backgrounds, so the inline dot color needs
  no `dark:` variant. (Data-driven colors can't use `dark:` classes anyway.)
- **Precedence regression (b729713b random-cwd fix).** Mitigated by placing the project
  pin after the session-origin upgrade and gating on `online_first`; covered by a
  dedicated precedence test in Task 2.
