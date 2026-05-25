# Tasks (mirror of Chorus task drafts)

These are the implementation tasks. The Chorus task drafts inside the proposal are the source of truth; this file is a local mirror for `openspec validate` / `openspec archive` parity.

- [ ] 1. **DB migration + schema delta** — drop `expiresAt`, backfill `inactive → active`, add `@@index([lastActiveAt])`. Run `pnpm db:migrate:dev`, regenerate Prisma client, restart dev server.
- [ ] 2. **Service layer refactor** — delete `markInactiveSessions` and its tests; remove `inactive→active` branch from `heartbeatSession`; introduce `SESSION_STALE_THRESHOLD_MS`, `freshSessionWhereClause`, `touchLastActiveAt`; split `listAgentSessions` into unfiltered (MCP) + `listAgentSessionsForUI` (filtered); wire `touchLastActiveAt` into every session-touching service function. Remove all `'inactive'` literal references.
- [ ] 3. **UI wiring + filter enforcement** — point Settings page session loader at `listAgentSessionsForUI`; verify project worker-avatar header passes through the now-stricter `getActiveSessionsForProject`; verify per-agent count badge reflects filtered count.
- [ ] 4. **Tests** — add tests for: 1h cutoff boundary, default-list filter, MCP non-filtered paths, side-effect refresh on each session-touching tool, closeSession not mutating task status, no-op on existing tests for removed code paths.
- [ ] 5. **Docs sync** — update `docs/MCP_TOOLS.md`, `public/skill/`, `public/chorus-plugin/skills/chorus/` to remove `inactive` and `expiresAt` references and document the implicit-heartbeat contract.
