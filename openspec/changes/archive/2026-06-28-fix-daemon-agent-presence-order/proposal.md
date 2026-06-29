# Proposal: Stabilize daemon agent presence ordering across refreshes

## Why

The daemon presence UI polls `GET /api/agent-connections` and also derives grouped agent/cwd rows locally. Today the server orders connections by `effectiveStatus` and `lastSeenAt` descending, while the frontend grouping preserves whatever order the current array happens to carry. That makes the UI visually unstable:

1. A heartbeat refresh can change `lastSeenAt` without changing the set of agents or cwd entries, causing rows to move.
2. Equal connection sets can arrive from the database in different raw orders, and the client preserves that accidental order.
3. One agent's cwd rows inherit the same instability, so expanded content jumps even when the actual online state did not change.

This breaks the main value of the resident presence surface: users need to scan and repeatedly target a known agent/cwd without the list moving underneath them.

## What Changes

- **Backend authoritative deterministic order.** `GET /api/agent-connections` returns a stable order for the same logical dataset. The server ranks by connection status first (`effectiveStatus: online` before `offline`), then by agent display name, agent uuid, cwd path string, host, client type, and connection uuid. `lastSeenAt` remains projected for display but is not a primary ordering key because it changes on heartbeat.

- **Frontend defensive sort for derived views.** The agent-presence frontend adds a shared comparator/grouping helper and applies it before rendering the presence pill popover, the full connections modal, and any local agent/cwd grouping that can receive unsorted arrays. Where a view has local execution state and wants to show activity groups, it may rank `running` before `queued` before idle, but it must still tie-break by agent name/uuid and cwd/host so equivalent data renders identically.

- **cwd rows sort by path string.** Within a given agent/status group, cwd entries sort by the full cwd path string ascending. `null` cwd uses the existing "unknown path" sentinel and sorts deterministically after known paths unless the existing formatter establishes a stricter local sentinel rule.

- **Status changes may move rows; raw array order may not.** A row can move when its actual status/activity changes, because that is meaningful content. A row must not move solely because the API/database returned the same set in another order.

- **Tests cover backend and local E2E behavior.** Unit tests cover the backend comparator against shuffled inputs. Frontend tests cover grouping/sorting of agent/cwd arrays. A local end-to-end test, using the project's existing daemon/Claude-style local E2E pattern, verifies repeated refreshes with equivalent connection sets do not reorder the visible agent and cwd rows.

## Capabilities

### Modified Capabilities

- `agent-connection-observability`: adds deterministic ordering requirements for the daemon connection API and the resident presence UI.

## Impact

- **Schema**: none. No Prisma migration, no new model, no permission change.
- **Backend code**:
  - `src/services/daemon-connection.service.ts`: replace `lastSeenAt`-first ordering with a deterministic comparator and export or test the pure helper as appropriate.
  - `src/services/__tests__/daemon-connection.service.test.ts`: add shuffled-input tests proving identical sets produce identical output.
- **Frontend code**:
  - `src/components/agent-presence/instance-group.tsx` and related presence helpers: sort defensively before grouping/rendering.
  - `src/contexts/agent-presence-context.tsx` if needed: normalize connection arrays as they enter the shared data spine.
  - Existing component tests under `src/components/agent-presence/__tests__/` and `src/contexts/__tests__/agent-presence-context.test.tsx`.
- **Local E2E**:
  - Add or extend the existing local Playwright/daemon E2E coverage so repeated refreshes with shuffled equivalent fixture data preserve DOM row order.
- **Docs/design.pen**: not required unless implementation changes visible layout. This is a behavior/stability fix, not a new surface.

## Out of Scope

- Adding new presence states or changing the meaning of `effectiveStatus`.
- Changing the daemon registry write path, heartbeat behavior, or `lastSeenAt` semantics.
- Adding manual disconnect/delete actions.
- Reworking the presence UI layout.
- Making recency a user-selectable sort mode.
