# Tasks

## Part 1 — Pin cwd before wake

- [ ] 1. HARD pin flip: change the two assignment `makePinnedTarget(..., true)` sites to `soft: false` in `notification-turn.ts`; update `require_online` stage-advance to check the pinned instance's online state; update the SOFT-degrade tests in `notification-turn.test.ts`.
- [ ] 2. Wake-ambiguity preview: service function + `GET /api/ideas/[uuid]/wake-preview` (bare-agent ∧ ≥2 online ∧ no online session-origin), returning online instance candidates. Tests.
- [ ] 3. Non-waking instance-reassign server actions (idea + task): call `assignIdea`/`claimTask` with `instanceUuid`, omit the `assigned` activity. Tests.
- [ ] 4. Pin-then-wake UI: wire the preview + picker + reassign into Verify Elaborate, Start Development, Yolo, Proposal approve/reject across both idea-detail-panel copies and proposal-actions. i18n (4 locales). design.pen.

## Part 2 — @mention respects the root idea's pin

- [ ] 5. Mentionables entity-context: `entityType`/`entityUuid` on the route + `searchMentionables`; resolve root-idea assignee + pin per candidate. Tests.
- [ ] 6. mention-editor inherit branch: thread entity context from `UnifiedComments` → `MentionEditor`; implement inherit-pin / picker / current-behavior in `selectMentionableRef`. Tests. design.pen.
