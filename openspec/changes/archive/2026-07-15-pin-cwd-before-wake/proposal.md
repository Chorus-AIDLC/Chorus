# Proposal: Pin a cwd before waking a daemon — picker + non-waking reassign; unify pins to HARD; @mention inherits the idea's pin

## Why

When an Idea/Task is assigned to a **bare agent** (`assigneeType = "agent"`, no pinned `(host, cwd)`) and that agent has **multiple online daemon connections** (several machines, or several cwds on one machine), the wake-triggering UI actions — **Verify Elaborate**, **Start Development**, **Yolo**, **Proposal approve/reject** — fall back to waking the agent's **first online connection** (`selectOriginConnection` → `connections.find(online)` in `src/services/notification-turn.ts`). "First" is deterministic but arbitrary: the agent can start working in the wrong repo / branch.

The server already mitigates one case: an un-pinned **idea** wake is re-pointed to the idea's existing conversation's session-origin cwd (the 0.13.0 random-cwd fix, `resolveIdeaSessionOriginTarget`). So the arbitrary-first-connection problem now bites specifically when the wake target is **ambiguous**: a brand-new idea with no session yet, or whose session-origin connection is offline.

Two consistency gaps compound this:

1. **No way to deliberately choose the cwd before a stage-advance/approval wake.** The task/idea *assign* modals already have a cwd picker (`InstancePicker`), but the stage-advance and proposal-approval buttons have none — they wake at agent granularity and let the server pick.
2. **The comment-box @mention picker ignores the idea's pin.** `mention-editor.tsx` pops the secondary cwd picker whenever a mentioned agent has ≥2 online instances — even when the idea is already pinned and you're @-mentioning that same agent. It should respect the idea's pin (the "idea owner"), and only prompt when genuinely ambiguous.

The elaboration for this idea (2 rounds, 9 questions) settled the exact behavior; this proposal implements it.

## What Changes

### Part 1 — Pin the cwd before the wake

- **New wake-target preview (server-owned).** A read-only server endpoint reports, for an Idea + its assignee agent, a three-way pre-wake **outcome**: `pick` (ambiguous — bare `agent`, **≥2** effectively-online connections, **no** online session-origin → prompt for a cwd), `auto_pin` (bare `agent` with **exactly one** online connection → silently persist that cwd, then wake), or `direct` (already `agent_instance`-pinned, or an online session-origin exists, or no online connection → wake as-is). It also returns the agent's online `(host, cwd)` candidate instances. The client cannot compute this alone because the session-origin check is server-only (`DaemonSession.originConnectionUuid` + liveness). The `auto_pin` outcome honors the elaboration decision (q1=a/q2=a) that a single online connection is **durably pinned**, not just transiently targeted.

- **New non-waking reassign server action.** A server action promotes an Idea's (or Task's) assignee from the bare `agent` to a chosen `agent_instance` (durable `AgentInstance.uuid`) and emits **no wake** — only the existing `emitChange({action:"updated"})` UI-refresh. It reuses the existing non-waking service primitives (`assignIdea` / `claimTask` with `instanceUuid`) and deliberately **omits** the `createActivity({action:"assigned"})` call that the current `claimIdeaToAgentAction` / `claimTaskToAgentAction` add (that activity is what wakes today).

- **Stage-advance & proposal buttons pin-then-wake.** For **Verify Elaborate**, **Start Development**, **Yolo**, and **Proposal approve/reject**, the button acts on the preview outcome: `pick` → open the cwd picker (reusing `InstancePicker`) → non-waking reassign to **persist** the chosen instance → wake; `auto_pin` → non-waking reassign to **persist** the sole online instance (no picker) → wake; `direct` → wake immediately, no picker, no reassign. The picker (prompt) therefore appears only in the **bare agent ∧ ≥2 online ∧ no online session-origin** case. Proposal approve/reject resolve the idea uuid from the proposal before requesting the idea-scoped preview.

- **All `agent_instance` assignment pins become HARD (owner choice "B").** Today an assignment pin is **SOFT**: if the pinned instance is offline at wake time, the wake degrades to the agent's first online connection. This change makes **all** `agent_instance` assignment pins **HARD**: an offline pin is never silently re-routed — the wake is notify-only (recovered on reconnect) or, for `require_online` actions, fails with an agent/instance-offline error. This reverses the existing `instance-addressed-assignment` "degrades to a plain agent" requirement. Mention pins were already HARD; this unifies the two.

### Part 2 — Comment @mention respects the root idea's pin

- **Mentionables enrichment with entity context.** `GET /api/mentionables` (and `searchMentionables`) accept an optional `entityType` + `entityUuid`. When present, the service resolves the comment's **root idea** (`resolveRootIdea`) and, for each candidate agent, returns whether that agent is the **root idea's assignee agent** and, if the idea is instance-pinned, the idea's pinned `(host, cwd)` place. The pin inherited is **always the root idea's**, never a per-resource pin — so @-mentioning inside a derived Task's comment box inherits the *idea's* pin, not the task's.

- **@mention picker triggering respects the idea pin.** In every comment box (idea/task/proposal/document — all served by the single `UnifiedComments` → `MentionEditor` caller):
  - **@ the root idea's assignee agent, idea pinned** → the mention inherits that pin, **no picker** (even if that cwd is currently offline → HARD, notify-only on wake, never re-routed).
  - **@ the root idea's assignee agent, idea not pinned, agent has ≥2 online instances** → present the picker (ambiguous).
  - **@ any other agent (not the root idea's assignee)** → unchanged: picker when >1 online cwd (the choice is **not** persisted to the idea, so it must be re-chosen each time), auto-pin when exactly one, un-pinned when none.

## Capabilities

### New Capabilities

- `pin-cwd-before-wake`: the Part 1 feature — the wake-ambiguity preview, the non-waking instance-reassign action, and the pin-then-wake gating of the stage-advance + proposal buttons.

### Modified Capabilities

- `instance-addressed-assignment`: replace the SOFT "unreachable assignment-pinned instance degrades to a plain agent" requirement with a HARD "unreachable assignment pin stays notify-only, never re-routed" requirement (owner choice B).
- `daemon-cwd-instance-addressing`: extend the @-mention pin requirement so the picker-trigger logic first honors the root idea's pin for the idea's assignee agent (inherit-no-picker), refining the general uniform picker heuristic for the @-mention surface.

### Extended Capability (ADDED requirement)

- `mention-agent-liveness`: add a requirement that the mention search resolves the comment's root-idea assignee + pin when given entity context, so the client can implement the Part 2 branch.

## Impact

- **Schema**: **zero migrations.** No new model, column, status, or permission bit. `agent_instance` assignee, `AgentInstance`, `DaemonConnection`, `DaemonSession.originConnectionUuid` all already exist.
- **Backend**:
  - `src/services/notification-turn.ts` — flip the two assignment-pin `makePinnedTarget(..., true)` call sites (lines ~347, ~396) to `soft: false` (HARD). Re-examine downstream `suppressWake` / `offline_pin` paths.
  - New wake-ambiguity preview: a service function composing `listConnectionsForAgent` + `resolveRootIdea` + the idea's assignee/session-origin, exposed via a new REST route (agent/user callable, company-scoped).
  - New non-waking reassign server action(s) for idea + task (call `assignIdea`/`claimTask` with `instanceUuid`, omit the `assigned` activity).
  - `src/services/mention.service.ts` + `src/app/api/mentionables/route.ts` — accept `entityType`/`entityUuid`, resolve root-idea assignee + pin per candidate; add the fields to `Mentionable`/`MentionableInstance` (or a sibling field).
- **Frontend**:
  - `src/components/start-development-button.tsx`, `src/components/yolo-button.tsx`, both `idea-detail-panel.tsx` copies (`/ideas` route + `dashboard/panels`), and `src/app/(dashboard)/projects/[uuid]/proposals/[proposalUuid]/proposal-actions.tsx` — the pin-then-wake flow with the picker.
  - `src/components/mention-editor.tsx` (`selectMentionableRef` branch) + `src/components/unified-comments.tsx` (thread `targetType`/`targetUuid` into `<MentionEditor>`).
  - Shared predicate libs `src/lib/start-development.ts` / `src/lib/yolo-request.ts` may gain an ambiguity helper.
- **i18n**: new keys for the picker title/subtitle/confirm on the stage-advance/proposal surfaces and any new hints — in **all four** locales (`messages/en.json`, `zh.json`, `ko.json`, `ja.json`).
- **design.pen**: update the idea-detail panel (stage-advance cwd picker) and the @mention-in-comment behavior mocks via Pencil MCP.
- **Tests**: heavy churn in `src/services/__tests__/notification-turn.test.ts` (SOFT-degrade cases invert to notify-only); new tests for the preview endpoint, the non-waking reassign action, the mentionables entity-context enrichment, and the mention-editor inherit branch.
- **Backward compat**: the picker only appears in the newly-ambiguous case; non-ambiguous wakes are unchanged. The HARD flip is a deliberate behavior change (owner-approved) — its only user-visible effect is that an offline pinned instance no longer silently runs elsewhere.

## Out of Scope

- Changing how proposals/tasks are authored or how the daemon executes a wake once delivered.
- A per-resource (task-level) pin inheritance for @mention — the inherited pin is always the **root idea's** (owner decision).
- Persisting the @mention cwd choice for a non-assignee agent (it stays per-comment, re-chosen each time — owner-accepted).
- New project-level roles; the non-waking reassign + preview stay company-scoped like the existing assign actions.
- Auto-pinning on the assign modals (they already have a picker) — this proposal only adds the picker to the stage-advance + proposal-approval surfaces.
