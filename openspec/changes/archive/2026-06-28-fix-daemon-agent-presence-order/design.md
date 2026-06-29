# Design: Deterministic daemon presence ordering

## Overview

This fix moves ordering from "whatever the latest query/heartbeat produced" to an explicit deterministic contract. The server remains the authority for the API order, and the frontend applies the same defensive identity ordering before any derived grouping so a future local refactor cannot reintroduce array-order jitter.

The important constraint is that not every layer has the same information:

- The API projection knows `effectiveStatus`, `agentName`, `agentUuid`, `cwd`, `host`, `clientType`, `uuid`, and timestamps.
- The presence UI also knows current executions, so it can identify running/queued/idle states for display.

Therefore the shared rule is layered:

1. Backend: deterministic connection order by `effectiveStatus` and stable identity fields.
2. Frontend: deterministic connection/group order by status/activity rank where available, then the same stable identity fields.

## Ordering Contract

### Backend connection comparator

For `ConnectionView[]` returned by `listConnectionsForOwner` and `listConnectionsForAgent`:

1. `effectiveStatus` rank: `online` before `offline`.
2. `agentName`, normalized for display sorting: trim, case-fold, missing name sorts after named agents.
3. `agentUuid`.
4. `cwd` path: known full path string ascending; `null` uses a deterministic sentinel and sorts after known paths.
5. `host`: string ascending, with `""` as the existing unknown-host sentinel.
6. `clientType`: string ascending.
7. `uuid`: final stable tie-break.

`lastSeenAt`, `connectedAt`, and `startedAt` remain display fields only. They must not decide primary order because heartbeats and reconnects can change them when the user-visible set is otherwise equivalent.

Use a locale-stable comparison rather than browser/runtime-locale-dependent collation. A simple normalized string compare is sufficient because these fields are identifiers, not natural-language prose.

### Frontend grouping comparator

For agent-presence UI grouping:

1. If execution-derived activity is available for an agent/instance, activity rank may be applied: `running`, `queued`, `online idle`, `offline`.
2. Then apply the backend identity tie-breaks: agent name, agent uuid, cwd path, host, client type, uuid.
3. Grouping must not preserve unsorted input order as a semantic decision. First appearance can only be used after the input has already been normalized by the comparator.

This keeps "busy agents first" possible while preventing two equally-busy agents or two cwd entries from swapping on refresh.

## Implementation Notes

- Keep the comparator pure and unit-testable. The current `sortConnectionViews` in `src/services/daemon-connection.service.ts` is the backend hook point.
- Prefer reusing one frontend helper from `src/components/agent-presence/instance-group.tsx` or a nearby utility so the popover and modal do not drift.
- Do not mutate arrays in place; sort a copy.
- Do not hide errors by returning empty arrays. Existing read-path error behavior should remain unchanged.
- Do not remove `lastSeenAt` from `ConnectionView`; only stop using it as a primary sort key.

## Test Strategy

### Backend unit tests

Seed multiple `DaemonConnection` rows with:

- different raw database orders,
- duplicate `agentName` values,
- missing/null `agentName`,
- multiple cwd values under one agent,
- online and offline statuses,
- different `lastSeenAt` values.

Assert that two shuffled inputs map to byte-identical ordered `ConnectionView.uuid` sequences. Assert that heartbeat-only timestamp changes do not move rows unless status changes.

### Frontend unit/component tests

Cover `groupConnectionsByAgent` or the new sorting helper with:

- same agent in multiple cwd paths, shuffled input,
- same display name across two agent uuids,
- unknown cwd plus known cwd,
- running/queued/idle status ranks when execution data is part of the rendered surface.

Existing tests in `src/components/agent-presence/__tests__/instance-group.test.ts` and `src/components/agent-presence/__tests__/presence-pill-drilldown.test.tsx` are the natural places.

### Local E2E

Add a local E2E check following the project's existing daemon/Claude local E2E style:

1. Start the app against fixture or mocked connection data.
2. Render the resident presence surface and expand the relevant agent/cwd list.
3. Simulate repeated refreshes that return the same logical connection set in different raw array orders.
4. Assert the visible agent row order and cwd sub-row order remain unchanged across refreshes.

The E2E should prove the user-facing symptom is gone, not just that a pure comparator sorts correctly.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Users expect recency-first ordering because `lastSeenAt` used to influence order. | The idea explicitly prioritizes stable scanning over recency. Last-active remains visible in the detail panel. |
| Backend and frontend comparators drift. | Document the same identity tie-break order in the spec and keep focused tests on both sides. |
| Activity rank causes movement while work starts/stops. | That is a real state change and acceptable. Ties within the same activity rank remain deterministic. |
| Locale-sensitive sorting differs across environments. | Use normalized string comparison for identifiers rather than default locale collation. |
