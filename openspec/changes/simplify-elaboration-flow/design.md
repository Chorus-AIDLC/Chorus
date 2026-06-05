# Design: Simplify Elaboration Flow

## Context

Elaboration (AI-DLC Stage 3) clarifies an Idea's requirements through structured Q&A rounds before a Proposal is authored. Today it is modeled by two Prisma models — `ElaborationRound` and `ElaborationQuestion` — and driven by five MCP tools. See `src/services/elaboration.service.ts` for the current lifecycle.

This change keeps the round/question data model and the human-in-the-loop verification gate, but redistributes the tool responsibilities so the common flows take fewer calls and less UUID bookkeeping, and so rounds can be appended after resolution.

## Current vs. target tool surface

| Concern | Today | Target |
|---|---|---|
| Generate a round (first / follow-up / appended) | `start_elaboration` (first) + `validate(followUpQuestions)` (follow-up); no appended path | `start_elaboration` for **all** cases |
| Answer a round | `answer_elaboration(roundUuid required)` | `answer_elaboration(roundUuid optional)` |
| Resolve the elaboration | `validate(issues=[])` (idea:write) | `chorus_pm_validate_elaboration` — pure resolve (idea:admin, human-confirmed) |
| Tag per-question issues | `validate(issues=[...])` | not supported |
| Skip | `skip_elaboration` | unchanged |

## State machine (unchanged statuses, new transitions)

`Idea.status`: `open → elaborating → elaborated`. `Idea.elaborationStatus`: `null → pending_answers → validating → resolved`. `Round.status`: `pending_answers → answered` (the only active states; `validated`/`needs_followup` are legacy-only and read the same as `answered`).

New transitions introduced by this change:

- **Appended round from a resolved Idea.** `start_elaboration` is now allowed when `Idea.status === "elaborated"`. It creates a new `pending_answers` round with `isAppended = true`, and does **not** change `Idea.status` (stays `elaborated`). It MAY set `elaborationStatus` back to `pending_answers` so the UI shows there is an open round, but `Idea.status` stays `elaborated` (the gating signal for proposal submission is `elaborationStatus === "resolved"`, so an open appended round will re-block submission until re-resolved — see Risk R2).

> **Decision (R2):** appended rounds are a *pure supplement*. To honor "never blocks downstream proposals", `start_elaboration` on a resolved Idea leaves `elaborationStatus = "resolved"` and only the new round sits at `pending_answers`. The "answered → validating" auto-transition in `answerElaboration` must therefore be guarded so it does not flip a resolved Idea back to `validating`. Net effect: an appended round can be answered and (optionally) re-resolved without ever un-resolving the Idea or blocking proposal submission. This is the behavior the owner asked for.

- **`chorus_pm_validate_elaboration`**: Idea-level resolve → Idea `elaborated`, `elaborationStatus → resolved`. Takes only `ideaUuid` (gated `idea:admin`; backing service fn `resolveElaboration`). It does not target or mutate any single round's status. Precondition: the Idea has ≥1 round and every round is answered. Idempotent-friendly: resolving an already-resolved Idea with a freshly answered appended round simply re-confirms resolution.

- **Follow-up while still `elaborating`** (the old `validate(followUpQuestions)` path): the PM just calls `start_elaboration` again. The prior answered round stays `answered` (no `needs_followup` status needed — that status existed only to record validate's issue path, which is gone). `getElaboration` treats any non-`pending_answers` round as "done" for display, exactly as the UI already does.

## Data model

```prisma
model ElaborationRound {
  // ... existing fields ...
  isAppended Boolean @default(false) // true when created after the Idea was first resolved
}
```

- Default `false` → all existing rows are non-appended, no backfill needed (DDL-only migration, per project rule "no DML in migrations").
- `isAppended` is set at creation time in `startElaboration`, computed from whether the Idea was already `elaborated` (equivalently `elaborationStatus === "resolved"`) at the moment of the call.

`ElaborationQuestion.issueType` / `issueDescription` columns are **retained** (no destructive migration) but become write-dead once `validate` is removed. Removing the columns is out of scope to keep the migration DDL-additive only.

## Service contracts

### `startElaboration` (modified)

- Precondition relaxed: allow `idea.status` ∈ `{ elaborating, elaborated }` (previously `elaborating` only).
- `isAppended = (idea.status === "elaborated")` at call time.
- When `isAppended`: do NOT downgrade `idea.status`; set `elaborationStatus` only if it is currently `resolved` → leave as `resolved` (R2 decision) — i.e. do not write `pending_answers` over `resolved`. The new round itself is `pending_answers`.
- When not appended (normal `elaborating` flow): behavior unchanged.
- Round cap: keep the max-rounds guard but raise/relax it so appended rounds aren't blocked by the old "max 5" — count is fine but appended rounds should not be permanently capped. **Decision:** keep a generous cap (e.g. 10) rather than 5, since appended rounds extend the lifetime. Document the number in the spec.

### `answerElaboration` (modified)

- `roundUuid` optional. When omitted: find the Idea's unique round with `status === "pending_answers"`. If zero → error "no active round". If more than one → error "multiple active rounds; specify roundUuid" (defensive; normally impossible).
- Guard the "all required answered → elaborationStatus = validating" write: only apply when `idea.elaborationStatus !== "resolved"` (R2). For an appended round on a resolved Idea, mark the round `answered` but keep `elaborationStatus = resolved`.

### `resolveElaboration` (new)

- Inputs: `companyUuid, ideaUuid, actorUuid, actorType` (no `roundUuid` — resolve operates on the whole Idea, not a single round).
- Preconditions: actor is the Idea assignee; the Idea has ≥1 round and every round is answered (none in `pending_answers`).
- Effect: Idea → `elaborated`; `elaborationStatus → resolved`; activity `elaboration_resolved`. Round statuses are not modified.
- Permission: `idea:admin` (see permission-map).

### `chorus_pm_validate_elaboration` wiring

- The `chorus_pm_validate_elaboration` tool routes to `resolveElaboration`. It does not carry issue-tagging or follow-up-creation logic. Update all tests/skills accordingly.

## MCP & permissions

- `chorus_pm_validate_elaboration` → `permission-map.ts`: `idea:admin`. The tool calls `resolveElaboration` and takes only `ideaUuid`.
- `chorus_answer_elaboration` stays public; `roundUuid` becomes optional in its zod schema.
- `chorus_pm_start_elaboration` stays `idea:write`.
- The `chorus_pm_validate_elaboration` tool description MUST include: *"Requires human confirmation before calling (except in YOLO mode). Marks the elaboration complete."*

## Frontend

- `ElaborationResponse.rounds[].isAppended` flows through `formatRoundResponse`.
- `elaboration-panel.tsx` `RoundCard` header renders an "appended / follow-up" badge when `round.isAppended` (i18n keys `elaboration.appendedBadge`). Distinct color from the round-number badge.
- No change to the carousel answer UX itself.

## Risks / trade-offs

- **R1 — Removing a public-ish MCP tool.** `validate_elaboration` is `idea:write`-gated and used by our own skills only. Mitigation: update all four skill surfaces + docs in the same change; reviewer checks no live references remain.
- **R2 — Appended round re-blocking proposal submission.** `submit_proposal` requires every input Idea's `elaborationStatus === "resolved"`. If appending a round flipped it to `pending_answers`, an in-flight proposal could be blocked. Decision above keeps `elaborationStatus = resolved` for appended rounds, so submission is never blocked; re-resolving is optional and only re-validates the appended round. This exactly matches the owner's "pure supplement, doesn't block proposal" requirement.
- **R3 — Round cap.** Appended rounds extend lifetime; bumping the cap from 5 → 10 avoids surprising lockouts while still bounding abuse.
- **R4 — i18n.** New badge strings must land in both `en` and `zh` (project rule).

## Migration

DDL-only, via `pnpm db:migrate:dev` after editing `schema.prisma`. One additive nullable-with-default column. No data backfill (project rule: no DML in migrations).
