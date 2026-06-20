# Proposal: Human "Verify Elaborate" button → wake daemon agent to write the proposal

## Why

Today the Idea-elaboration flow stops dead once a human finishes answering a round. The UI has no "I'm done — move this forward" action:

1. **No forward affordance after answering.** A human answers the elaboration questions in `elaboration-panel.tsx` and… nothing. There is no button that says "elaboration is confirmed, proceed." Resolving an elaboration (`resolveElaboration` / `chorus_pm_validate_elaboration`) exists **only** as an `idea:admin` MCP tool whose service guard requires the caller to be the Idea's *assignee* — i.e. the agent itself. A human user is neither the assignee nor an admin agent, so a human literally cannot resolve from the UI today.

2. **The human-facing "Create Proposal" button is the wrong job for a human.** The idea-detail panel footer (`src/app/(dashboard)/projects/[uuid]/ideas/idea-detail-panel.tsx:582`) shows a "Create Proposal" button gated on `elaborationStatus === "resolved"` — but since no human can reach `resolved` from the UI, the button is effectively dead, and writing a proposal by hand is exactly the PM agent's job under Chorus's **Reversed Conversation** philosophy (AI proposes, human verifies). Asking a human to hand-author the proposal inverts the model.

3. **No channel to tell the daemon agent "go write the proposal."** The 0.11.0 daemon-session line (PRs #332–#334) wakes a daemon agent on a fixed set of triggers and runs it as a conversation turn. There is no wake whose meaning is "the human verified the elaboration — now draft the proposal."

The net experience we want: a human only ever **answers questions, then clicks one button**. The daemon PM agent picks it up and writes the proposal. That closes the Reversed Conversation loop in the UI.

## What Changes

- **New human-callable elaboration resolution.** Add a server action (`verifyElaborationAction`) + service path that lets an authenticated **user** (company-scoped) resolve an Idea's elaboration: `idea.status → elaborated`, `elaborationStatus → resolved`. This is distinct from the existing agent-only `chorus_pm_validate_elaboration` MCP tool, which is unchanged. The human's click **is** the human confirmation the resolution requires.

- **New dedicated wake signal `elaboration_verified`.** Resolving via the human path emits an `elaboration_verified` activity → notification (recipient = the Idea's assigned daemon agent) → daemon wake. This is a new wake **action** that the daemon distinguishes from `elaboration_requested` / `elaboration_answered` (which mean "go answer questions"): `elaboration_verified` means **"the human confirmed — write the proposal."** A matching `elaboration_verified` value is added to the `DaemonSessionTurn.trigger` set for server/daemon symmetry.

- **Daemon writes the proposal on wake.** The daemon client (`cli/prompts.mjs`) gets a new case for `elaboration_verified` instructing the woken agent: the Idea is now `elaborated`; proceed to author the proposal via the existing proposal flow (`chorus_pm_create_proposal` / proposal skill). No change to how proposals are written.

- **"Verify Elaborate / 完成细化" button replaces the idea-panel "Create Proposal" button.** On **both** the `/ideas` route idea-detail panel (`idea-detail-panel.tsx`) and the dashboard idea-tracker detail panel (`dashboard/panels/idea-detail-panel.tsx`), render a single "Verify Elaborate" button, enabled only when the Idea is `elaborating`, has at least one elaboration round, and **every** round is fully answered (no `pending_answers`) and not yet resolved. On the `/ideas` panel this **replaces** the existing "Create Proposal" button.

- **Generic proposals-list "Create Proposal" is kept.** The proposals-list page (`proposals/page.tsx`) "Create Proposal" entry — a from-scratch, not-idea-bound authoring path — is **not** removed; it is out of scope for the idea→proposal handoff.

- **Offline = queue + backfill, no manual fallback.** If the assigned agent has no online daemon connection when the human verifies, the resolution still happens synchronously (idea → elaborated), and the wake is recovered through the existing reconnect notification-backfill. The UI surfaces that the agent will pick it up when it reconnects. No human "write it yourself" fallback is added on the idea panel.

- **Idea status feedback reuses the derived `planning` state.** No new stored Idea status. After resolution, an `elaborated` Idea with no Proposal already derives the display status `planning`; the UI reuses that to signal "agent is drafting the proposal." The 3-stored-state Idea model is unchanged.

- **i18n.** New keys for the button label, the post-verify status hint, and the offline hint in both `messages/en.json` and `messages/zh.json`.

- **design.pen.** Update the idea-detail panel mock(s) to show the "Verify Elaborate" button in place of "Create Proposal."

## Capabilities

### New Capabilities

- `elaboration-verify-wake`: The end-to-end "Verify Elaborate" feature — the UI button (placement, gating, replacement scope), the `elaboration_verified` wake that tells the daemon to write the proposal, the daemon's write-proposal behavior on that wake, the offline behavior, the reuse of derived `planning` status, and the explicit scope boundary.

### Modified Capabilities

- `elaboration-resolution`: Add a **human-callable** resolution path alongside the existing agent-only `chorus_pm_validate_elaboration` MCP tool. The existing admin-gated tool requirement is unchanged; this is purely additive.
- `daemon-session-conversation`: Extend the `DaemonSessionTurn.trigger` enumeration with `elaboration_verified` so a human-verify wake is recorded as a distinct turn kind.

## Impact

- **Schema**: **zero migrations.** No new Idea status, no new model. `DaemonSessionTurn.trigger` is a free-form string in Prisma (the enumeration is a contract, not a DB enum), so adding `elaboration_verified` is a contract/code change, not DDL.
- **Backend code**:
  - `src/services/elaboration.service.ts` — new `verifyElaboration` path (user-actor, company-scoped, same "all rounds answered / ≥1 round" precondition as resolve, sets `elaborated`/`resolved`, logs `elaboration_verified` activity).
  - `src/app/(dashboard)/projects/[uuid]/ideas/[ideaUuid]/elaboration-actions.ts` — new `verifyElaborationAction` server action (gated on `auth.type === "user"`/`super_admin`, company-scoped).
  - `src/services/notification-listener.ts` — map `idea:elaboration_verified` activity → `elaboration_verified` notification to the assigned agent.
  - `src/services/notification-turn.ts` — map notification action `elaboration_verified` → turn trigger `elaboration_verified`.
  - `src/services/daemon-session.service.ts` — add `elaboration_verified` to `TURN_TRIGGERS`.
- **Daemon client code** (in-repo, `cli/`):
  - `cli/prompts.mjs` — add `elaboration_verified` to `WAKE_ACTIONS` and a new prompt case ("write the proposal").
- **Frontend code**:
  - `src/app/(dashboard)/projects/[uuid]/ideas/idea-detail-panel.tsx` — replace the "Create Proposal" button with the gated "Verify Elaborate" button + post-verify status.
  - `src/app/(dashboard)/projects/[uuid]/dashboard/panels/idea-detail-panel.tsx` — add the same "Verify Elaborate" button to the footer.
  - `src/components/elaboration-panel.tsx` may expose whether all rounds are answered (or the panel computes it from the elaboration data already in props).
- **i18n**: `messages/en.json` + `messages/zh.json` — new keys.
- **Docs**: `docs/MCP_TOOLS.md` unchanged (no new MCP tool — the verify path is a server action, not an MCP tool). Skill docs (`public/skill/`, `public/chorus-plugin/skills/chorus/`) get a one-line note that the daemon wakes to write a proposal on human verify. `docs/design.pen` updated.
- **Runtime**: no new dependencies, no migrations, no new MCP tool, no new permission bit.
- **Backward compat**: fully additive. The existing agent-only resolve and the existing `elaboration` wake are unchanged. Ideas that reach `elaborated` via `skip_elaboration` or an agent's own MCP `validate` (i.e. **without** a human verify click) are explicitly **out of scope** — this change adds no new way to wake the agent for those.

## Out of Scope

- Waking the agent to write a proposal for Ideas that became `elaborated` **without** the human verify click (e.g. via `skip_elaboration`, or an agent calling `chorus_pm_validate_elaboration` itself). Deferred by explicit owner decision.
- Changing how a proposal is authored — the woken agent still uses the existing proposal flow.
- Removing the generic proposals-list "Create Proposal" entry.
- New elaboration question-generation or answering mechanics — unchanged.
- Introducing project-level user roles. The human-verify authorization is company-scoped (matching existing human-action patterns) until/unless project roles exist.
