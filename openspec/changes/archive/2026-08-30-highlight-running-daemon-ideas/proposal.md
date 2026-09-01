## Why

The Idea Tracker and project graph do not reveal which Ideas currently have daemon sessions executing. Users must open the global daemon chat and search manually, making concurrent runs difficult to monitor and slow to locate.

## What Changes

- Publish two lightweight company-wide session-activity SSE events: `session_started` when a daemon turn begins running and `session_ended` when it leaves running.
- On SSE connection, replay the currently running session activities through the same `session_started` event shape so first paint and reconnects converge without another polling loop.
- Show running activity from every user in the same company, while marking only sessions owned by the current user as navigable; other users' sessions remain status-only.
- Maintain the active-session set entirely in frontend shell state, grouped by each session's existing `directIdeaUuid`; do not persist a second activity model.
- Add a running indicator to Idea rows in both flat and lineage Tracker views.
- Add a distinct running treatment to Idea nodes in the project graph.
- On hover, show every active session's Agent avatar, identity, and CWD; when more than one exists, show their count and allow choosing one.
- Preserve the existing project-header CWD focus while carrying the activity's already-known session UUID, so desktop and mobile open the exact conversation without another backend lookup.
- Remove the indicator immediately when the final active session ends; do not retain recent/history markers.

## Capabilities

### New Capabilities

- `idea-daemon-activity`: Session start/end realtime events, frontend Idea activity derivation, Tracker indicator, and agent/CWD chat location.

### Modified Capabilities

- `project-resource-graph`: Add a daemon-running treatment and its hover/click interaction to Idea nodes while preserving existing graph navigation.

## Impact

- Session transition/event source: `src/services/daemon-session.service.ts`.
- Company-wide SSE forwarding: `src/app/api/events/route.ts`.
- Shell activity state and existing agent/CWD locator: `src/contexts/agent-presence-context.tsx`.
- Tracker surfaces under `src/app/(dashboard)/projects/[uuid]/dashboard/`.
- Graph orchestration and canvas rendering under `src/app/(dashboard)/projects/[uuid]/graph/`.
- Localized labels in `messages/en.json` and `messages/zh.json`.
- No Prisma/schema migration, new table, execution projection enrichment, exact-session navigation API, dependency, or periodic poll.
