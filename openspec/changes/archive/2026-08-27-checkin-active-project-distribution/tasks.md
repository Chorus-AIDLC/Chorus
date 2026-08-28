# Tasks

## 1. Server — checkin active-project distribution + guidance

- [ ] 1.1 Add `buildActiveProjectDistribution(auth)` to `idea-tracker.service.ts`, derived from the uncapped `buildIdeaTracker` result (no `maxIdeas` cap).
- [ ] 1.2 In `checkin.service.ts`: replace `ideaTracker` with `activeProjects: Record<projectUuid,{name,activeIdeaCount}>`; add `guidance: string[]` (always non-empty); remove now-unused `CheckinIdea`/`CheckinProject`.
- [ ] 1.3 Leave `buildIdeaTracker`/`buildTaskTracker` and `chorus_get_my_assignments` untouched.
- [ ] 1.4 Rework `checkin.service.test.ts` (`ideaTracker` → `activeProjects`: counts, done/closed exclusion, container rollup, empty state, uncapped, guidance non-empty). Update `collection-migration.test.ts` mock if needed.
- [ ] 1.5 `npx tsc --noEmit`, `pnpm lint`, `pnpm test` green.

## 2. Plugin / doc copy sync

- [ ] 2.1 `public/chorus-plugin/bin/on-session-start.sh`: replace the "up to 10 most recently updated ideas" Quick Reference line with the active-project distribution + `chorus_search` / `chorus_get_my_assignments` guidance.
- [ ] 2.2 `public/kiro-plugin/bin/on-agent-spawn.sh:64`: same edit.
- [ ] 2.3 `docs/MCP_TOOLS.md`: update the `chorus_checkin` example (`activeProjects` + `guidance`) and the `chorus_get_my_assignments` "structurally identical" note (now diverged).
- [ ] 2.4 Bash 3.2 syntax check passes (`public/chorus-plugin/bin/test-syntax.sh`).
