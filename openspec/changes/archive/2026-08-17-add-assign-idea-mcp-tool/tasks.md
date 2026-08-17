# Tasks

## 1. `chorus_pm_assign_idea` MCP tool (backend)
- [ ] Register `chorus_pm_assign_idea` in `src/mcp/tools/pm.ts` (near `chorus_pm_assign_task`)
- [ ] Add `chorus_pm_assign_idea: "idea:admin"` to `src/mcp/tools/permission-map.ts`
- [ ] Params: `ideaUuid`, `assigneeType` (`agent`|`user`), `assigneeUuid`, `instanceUuid?` (agent only)
- [ ] Validate target: agent holds `idea:write` (reuse existing eligibility), user same-company, instance belongs to company+agent
- [ ] Call `ideaService.assignIdea(...)` (silent takeover; open→elaborating else preserve)
- [ ] Emit `createActivity({action:"assigned", targetType:"idea", actorType:"agent", actorUuid, value})` (fires the wake)
- [ ] Unit tests: agent/user/instance targets, takeover, ineligible-agent reject, status behavior, activity emitted

## 2. Rework the assignment wake (provenance + stage-correct guidance)
- [ ] `cli/prompts.mjs` `idea_claimed` body — interpolate assigner (`n.actorName`/`n.actorType`)
- [ ] Same body — replace the `chorus_claim_idea` instruction with "review + advance from current stage, stop at gate" (blocker: claim throws on an already-assigned/elaborated idea)
- [ ] Mirror BOTH changes in the OpenClaw twin `packages/openclaw-plugin/src/event-router.ts:339`
- [ ] Prompt-builder test: assigner shown for agent & user actor; prose does NOT instruct `chorus_claim_idea`

## 3. Docs
- [ ] Add `chorus_pm_assign_idea` to `docs/MCP_TOOLS.md`
- [ ] Add the tool to the idea-skill Tools table across the six skill surfaces

## 4. `chorus:orchestrate` skill
- [ ] Author `SKILL.md` in all six surfaces (Claude Code, Codex, OpenClaw, Kiro `chorus-` prefix, Pi, standalone `-chorus` suffix)
- [ ] Add a `## Skill Routing` row to each entry skill + the Kiro steering overview
- [ ] Content: assign-idea / assign-task / independent review, mode selection by scenario, single-owner & Reversed-Conversation
- [ ] No version bump (release-time concern)

## 5. Integration & verification
- [ ] Integration test of the tool path (assignee/status/Activity) + provenance prompt test
- [ ] Document the live daemon-wake + provenance-display human verification step
