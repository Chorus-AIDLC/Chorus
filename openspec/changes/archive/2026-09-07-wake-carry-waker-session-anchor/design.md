# Design — wake-carry-waker-session-anchor

## Context

When an agent wakes a peer, the woken agent receives a Notification (read via
`chorus_get_notifications`, which the daemon already calls) carrying the waker's
identity (`actorType/actorUuid/actorName`) and — for idea/task resources with an
agent assigner — a derived `orchestrator` attribution. Neither tells the woken
agent **where the waker's live conversation is**, so a reply scatters or opens a
new session. The landing substrate already exists: `DaemonSession` is idea-anchored
(`sessionId === directIdeaUuid`, `prisma/schema.prisma:665-707`, no 1h auto-close),
`resolveIdeaSessionOriginTarget` (`notification-turn.ts:676`) already maps
`(agentUuid, ideaUuid) → online origin connection`, and un-pinned `@mention` returns
already ride the upgraded `RESIDUAL_CWD_UPGRADE_TRIGGERS` ladder back onto that
session. The only missing piece is **telling the woken agent the anchor is there**.

## Goals / non-goals

- **Goal:** an agent-originated, idea/task-anchored wake surfaces the waker's live
  session anchor to the woken agent, advisory-only.
- **Non-goal:** any new server routing, enforced return-routing, offline
  queue/replay, ad-hoc (no shared idea) anchoring, or persisted state. All left to
  sibling theme children.

## Decisions (from elaboration round 1, `1dbbfac0`)

| # | Decision | Realization |
|---|----------|-------------|
| 1 | Carry via the orchestrator-attribution mechanism, **no schema column** | Reuse the derived / non-persisted / read-projection / prompt-append machinery. See "Sibling field, not nested" below. |
| 2 | Stamp on **all agent-originated wakes** | Actor-scoped resolution keyed on `actorType === "agent"`, over the idea/task resource keying the read projection already uses. |
| 3 | Return path **advisory only** | Prompt wording only; `createTurnAndResolveTarget` routing ladder is untouched; return reply lands via the existing ladder. |
| 4 | Waker offline → **notify-only** | Anchor is emitted only when the waker's idea-anchored session has an **online** origin connection; otherwise absent, and the prompt makes no live-session claim. |

### Sibling field, not nested — a deliberate refinement of decision #1

The elaboration answer was "extend the `orchestrator` attribution." Grounding shows
`OrchestratorAttribution` (`orchestrator.service.ts:7` = `{ type:"agent", uuid, name }`)
is **assignment-scoped** — derived by `resolveResourceOrchestrator` from the
resource's `assignedByType/assignedByUuid`, and by contract (existing capability
requirement) it reads only that resource's typed provenance. The waker anchor is
**actor-scoped**: it must appear for *any* agent waker (e.g. a bare `@mention` with
no assignment) and must be present even when `orchestrator` is absent, or identify a
*different* agent than the orchestrator.

So we honor the intent of #1 — reuse the exact derived / non-persisted / read-time /
prompt-append plumbing, add no DB column — but implement the anchor as a **sibling**
derived field `wakerSession` on `NotificationResponse`, not a sub-field of
`OrchestratorAttribution`. `orchestrator` and `wakerSession` are independent: either,
both, or neither may be present on a wake.

## Data shape (no schema change)

New transport-only type (derived, never persisted), added next to
`OrchestratorAttribution`:

```ts
export interface WakerSessionAnchor {
  agentUuid: string;   // the waking agent (= notification actorUuid)
  agentName: string;   // resolved current display name (= actorName)
  ideaUuid: string;    // the idea whose session the reply reaches (DaemonSession.sessionId)
}
```

`NotificationResponse` (`notification.service.ts:67-93`) gains:

```ts
wakerSession: WakerSessionAnchor | null;   // sibling of `orchestrator`
```

`RawNotification` is unchanged (no new column). The `Notification` model is
unchanged.

## Resolution — read time, in `formatNotifications`

`formatNotifications` (`notification.service.ts:157-195`) already batch-resolves
`orchestrator` per idea/task resource. Add a parallel batch resolve for the anchor:

1. **Which notifications qualify:** `actorType === "agent"` **and** the addressed
   entity resolves to an idea anchor. Reuse the existing idea/task resource keying
   (`notificationResourceKey`, `notification.service.ts:151-154`): an `idea` entity's
   anchor is itself; a `task` entity's anchor is the task's own `ideaUuid` (the
   resource's *direct* containing idea — a single lookup, **not** parent/container
   lineage traversal). Comment-mention notifications already carry the comment's
   target kind as `entityType` (`mention.service.ts:445-455`), so a comment-on-idea
   wake is an `idea` notification and a comment-on-task wake is a `task` notification —
   both covered. Proposal/document-addressed wakes are **out of V1** (they carry no
   idea/task key today; matches the orchestrator projection's own scope).
2. **Resolve the anchor** with a new helper `resolveWakerSessionAnchor(companyUuid,
   agentUuid, ideaUuid)` modeled on `resolveIdeaSessionOriginTarget`
   (`notification-turn.ts:676`): find the waker's `DaemonSession` where
   `sessionId === ideaUuid`, then confirm its `originConnectionUuid` maps to a
   connection whose `effectiveStatus === "online"` (reusing the connection-registry
   liveness the target resolver already applies). Return the `WakerSessionAnchor`
   only when online; else `null`.
3. **Batch:** group distinct `(agentUuid, ideaUuid)` pairs and resolve in parallel,
   exactly like the orchestrator map, so a page of notifications adds at most one
   session lookup + one connection lookup per distinct waker/idea.
4. **Exclusions:** user-actor wakes → no anchor; a waker with no idea-anchored
   session or no online origin → no anchor; self-notifications never occur (the
   notification listener already skips notifying the actor).

No change to `createTurnAndResolveTarget` or the routing ladder — the anchor is a
read-projection enrichment, identical in spirit to how `orchestrator` is merged.

## Prompt surface — advisory, `cli/prompts.mjs`

`buildPrompt(n)` (`cli/prompts.mjs:120-125`) assembles
`HEADLESS_PREAMBLE + body + orchestratorGuidance(n)`. Add a sibling
`wakerSessionGuidance(n)` appended alongside `orchestratorGuidance`:

- Returns `null` unless `n.wakerSession` is present.
- Emits one advisory block naming `@[${n.wakerSession.agentName}](agent:${n.wakerSession.agentUuid})`
  and stating that **replying on this resource reaches that agent's live session**
  rather than opening a new one — with an explicit "this is where a reply lands, not
  an enforced route" framing (no server-routing claim).
- Independent of `orchestratorGuidance`: both may render on the same wake; a null
  action body stays null (anchor guidance never creates a preamble-only wake).
- Update the `NotificationDetail` typedef (`cli/prompts.mjs:19-34`) with the
  `wakerSession` field.

**Keep the OpenClaw twin in sync:** `packages/openclaw-plugin/src/event-router.ts`
carries `buildOrchestratorGuidance` (the OpenClaw port of `orchestratorGuidance`) and
its own NotificationResponse-equivalent type. Add the matching `wakerSession` field +
guidance there with identical wording, per the `plugin-maintenance` sync rule.

## Skill contract — `chorus:orchestrate`

Document the "reply-here-reaches-the-waker" semantics and the offline notify-only
boundary in the orchestrate skill body, across every plugin surface that carries it
(`public/skill/orchestrate-chorus/SKILL.md`, `public/chorus-plugin/skills/orchestrate/SKILL.md`,
and the ports kept in sync by `plugin-maintenance`). This is guidance only — it must
not imply an automatic server subscription or enforced routing.

## Module contracts (cross-task)

- **Anchor type + resolver** (T1) is the shared contract T2 and T4 consume:
  `WakerSessionAnchor` shape above, `wakerSession: WakerSessionAnchor | null` on
  `NotificationResponse`, emitted only when the waker's origin is online.
- **Prompt block** (T2) reads only `n.wakerSession`; it must render the advisory
  line iff the field is present, with no routing claim, and never on a null body.

## Risks & mitigations

- **Read-time cost:** one extra session + connection lookup per distinct waker/idea
  in a notifications page. Mitigation: batch by distinct pair, mirroring the existing
  orchestrator batch; negligible for typical page sizes.
- **Staleness between read and reply:** the anchor reflects liveness at read time; the
  waker could go offline before the reply. Acceptable — the return path already
  degrades to the existing ladder / notify-only; the advisory wording promises a
  landing, not a guarantee.
- **CC / OpenClaw prompt drift:** the two guidance builders must stay in sync
  (existing hazard for `orchestratorGuidance`). Mitigation: T2 updates both and the
  `plugin-maintenance` skill enforces parity.
- **Scope creep to ad-hoc / proposal-document wakes:** explicitly deferred; the
  resolver keys only on the idea/task projection already in place.

## Verification

- **Unit:** anchor resolver (online → anchor, offline/no-session/user-actor → null,
  no lineage climb) and `formatNotifications` wiring; prompt builder (block iff field,
  coexists with orchestrator, null body stays null) on both CC and OpenClaw twins.
- **Integration + live e2e (acceptance gate):** a real agent-originated wake yields a
  `NotificationResponse` carrying the anchor and a rendered advisory line; a live
  Claude + Codex daemon run proves a peer wake → reply lands in the original waker
  session (not a new one), and an offline waker degrades to notify-only.
