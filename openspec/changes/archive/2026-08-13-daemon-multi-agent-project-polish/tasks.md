# Tasks

## 1. Overview cwd badge — agent-identifiable
- [ ] 1.1 In `project-cwd-summary.tsx`, render a colored agent identity dot + visible agent name; move the cwd path into the hover tooltip
- [ ] 1.2 Thread `agent.uuid` into the local `FixedCwdPreference` shape and derive the dot color from the existing agent-color helper (light + dark)
- [ ] 1.3 i18n both locales; component test asserts two agents' badges are distinguishable and cwd is in the tooltip

## 2. Autonomous wake resolves the agent-owner's project cwd pin
- [ ] 2.1 In `notification-turn.ts` `resolvePinnedTarget`, add a project-pin step after root-idea inheritance and before returning null
- [ ] 2.2 Resolve the agent owner (`Agent.ownerUuid`) and look up `ProjectAgentCwdPreference` for `(owner, project, agent)`, reusing `resolveProjectAgentCwdTarget`'s `project_fixed` branch; return a hard pin
- [ ] 2.3 Verify hard-pin offline behavior (no reroute) and online-first fallback when no owner preference; unit tests cover pin-hit, offline-no-reroute, and no-preference fallback

## 3. Presence pill counts distinct online agents
- [ ] 3.1 In `daemon-presence-entry.tsx`, display the distinct-online-agent count (`onlineAgentGroups.length`) for the pill number + `onlineUnit` pluralization
- [ ] 3.2 Update `agent-presence-context.test.tsx`, `instance-group.test.ts`, `daemon-presence-entry.test.tsx` to assert distinct-agent counting
