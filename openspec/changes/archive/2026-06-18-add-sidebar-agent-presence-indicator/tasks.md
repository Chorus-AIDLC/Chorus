# Tasks — Sidebar Online-Agent Presence Indicator

## 1. Aggregate executions endpoint
- [ ] 1.1 Add `GET /api/daemon/executions` wrapping `getVisibleExecutions(auth)` (owner-scoped, standard envelope, `withErrorHandler`)
- [ ] 1.2 Route tests: 401 unauth, owner-scoped aggregate, agent-key self-scope, company isolation

## 2. Shared rendering module
- [ ] 2.1 Extract `IdentityBlock`, `StatusDot`, `StatusBadge`, client-type label, `useRelativeTime`, `useUptimeMono`, execution-row renderer from `agent-connections/page.tsx` into `src/components/agent-presence/`
- [ ] 2.2 Keep the former page rendering byte-identical via the shared module (no visual drift)

## 3. Presence data provider
- [ ] 3.1 `AgentPresenceProvider` at the dashboard shell: 15s poll of `/api/agent-connections`, first-paint `/api/daemon/executions`, own company-wide `/api/events` EventSource merging `execution` events, visibility-reconnect
- [ ] 3.2 Expose `useAgentPresence()` → `{ status, connections, onlineCount, executionsByConnection }`; failure sets `status:"error"` (never zeroes count)

## 4. Sidebar pill + popover
- [ ] 4.1 `AgentPresencePill` above the profile block (desktop + mobile), three states (idle/loading/error), reduced-motion-gated pulse
- [ ] 4.2 Popover: online connections + nested running/queued executions, task deep-links, "View all" footer

## 5. Modal + page removal
- [ ] 5.1 Refactor `agent-connections/page.tsx` body into `AgentConnectionsView` reading from the provider; host in a `Dialog` (master-detail + execution + interrupt/resume parity)
- [ ] 5.2 Delete the `/agent-connections` route + `RadioTower` nav item; add redirect for the former path
- [ ] 5.3 Update/move existing page tests to the modal; ensure interrupt/resume controls still covered

## 6. i18n + verification
- [ ] 6.1 Add all strings (pill states, popover, "View all", modal, empty/idle/error) to `en.json` + `zh.json`
- [ ] 6.2 `pnpm lint`, `npx tsc --noEmit`, `pnpm test`; manual e2e of pill→popover→modal and the redirect
