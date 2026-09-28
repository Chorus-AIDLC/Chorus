## Context

ResearchAction owns dispatch and renders a StageAction into IdeaActionsMenu.
Both desktop ActionItem and MobileActionItem already display disabled reasons,
expose aria-disabled/aria-describedby, and prevent unavailable selections.
Research currently checks stage eligibility but does not subscribe to presence.
YoloButton uses useAgentPresenceOptional and assigneeOwningAgentUuid to require
any connection of the owning agent with effectiveStatus === "online".

## Decisions

1. Subscribe ResearchAction to the existing presence context and use the same
   owning-agent identity and effectiveStatus predicate as YOLO. A missing provider,
   empty connections, stale/offline connections, or connections belonging only to
   another agent do not qualify. An agent-instance's owning agent is used, not
   its instance UUID. This intentionally aligns with the existing agent-level UI
   baseline; precise pinned origin and fixed-cwd checks remain server-authoritative.
2. Derive a single disabled reason shared by renderAction and onSelect. Preserve
   external blocking and submission busy precedence; expose assignment required
   and agent offline ahead of stage eligibility so recovery guidance is immediate.
   Eligibility still runs and prevents actions when presence returns.
3. Require an owning agent before the Research action can open anything. Remove
   ResearchAction's ResearchAgentPicker state/render/fallback. Use a distinct
   localized assignment hint so the existing server assignment_required error
   can still describe cwd disambiguation without misleading unassigned users.
4. Preserve usePinThenWake and its captureSelection adapter for already assigned
   agents. Research's atomic selection dispatch must not be replaced with generic
   assignment APIs, which can advance the Idea lifecycle. Keep single-submission
   protection and queued/retry behavior.
5. Keep existing menu visuals, focusable disabled entries, desktop tooltip and
   mobile inline explanation. No new confirmation dialog or visual redesign.
6. Limit this change to the Research UI. The backend continues rejecting offline,
   stale, changed, unauthorized, or conflicting targets even when UI presence is
   momentarily stale. Do not modify other stage actions or server selection APIs.

## Risks and Validation

- Presence is optimistic and agent-level: test backend agent_offline feedback
  after an initially online client, and retain all server routing checks.
- Assignment may change while the menu is mounted: rerender with null, a user,
  an instance, and another agent; assert no unintended dispatch/chooser.
- Regression tests must cover desktop pointer and keyboard activation, mobile
  inline reasons, disconnect/reconnect, missing provider, unrelated/stale
  connections, initial eligibility loading/failure, development eligibility,
  in-flight duplicate clicks, and assigned cwd retry.
- Run focused ResearchAction and IdeaActionsMenu tests, existing server-action
  and research eligibility/service regressions, scoped lint and TypeScript.
- Use the project's supported browser workflow to verify desktop/mobile disabled
  states in both light and dark themes. Update `docs/design.pen` through Pencil
  for the corresponding offline and assignment-required states, and inspect the
  result through Pencil. These are mandatory repository delivery obligations.
  If tools remain unavailable, record the limitation and leave the corresponding
  acceptance criterion incomplete; do not claim verification or silently waive it.

## Delivery

One cohesive implementation task, independently reviewed at task level and then
at the whole-Idea code gateway. Worktree:
`/home/ubuntu/dev/ai-pm-research-action`, branch
`fix/research-action-availability`, base `81172eff` (origin/develop).
After successful verification, archive the OpenSpec change and mirror the
cumulative specification to Chorus. Commit locally; publishing or merging is
outside the present YOLO authorization.

At proposal revision 2, Pencil get_app_state and execute with the explicit
worktree file path both returned "A file needs to be open in the editor to
perform this action." Implementation and browser checks can proceed after
proposal approval, but delivery remains pending until the artifact can be
updated or the human explicitly changes this delivery requirement.
