# Design: Pin a cwd before waking a daemon

## Context

Wake routing lives in `src/services/notification-turn.ts`. The relevant pieces:

- `PinnedTarget = { host: string; cwd: string | null; soft: boolean }`. `soft` records the pin's **origin** and drives its offline policy.
- `makePinnedTarget(host, cwd, soft)` — three call sites in `resolvePinnedTarget` / `resolveIdeaInstancePin`:
  - mention pin → `soft: false` (HARD)
  - task's own `agent_instance` override → `soft: true` (SOFT)
  - idea's `agent_instance` (own-idea step 2.5 + root-idea step 3, same-agent-guarded) → `soft: true` (SOFT)
- `selectOriginConnection(connections, pin)`:
  - pin matches an ONLINE connection → `directed`
  - pin matches nothing + `!pin.soft` (HARD) → `offline_pin` (notify-only, no wake, no fallback)
  - pin matches nothing + `pin.soft` (SOFT) → fall through to online-first
  - no pin → online-first (`connections.find(online)`); none online → `none`
- `resolveIdeaSessionOriginTarget(companyUuid, agentUuid, directIdeaUuid, connections)` — reads `DaemonSession.originConnectionUuid` for the idea-anchored session and returns that `ConnectionView` when online; applied only when `selection.kind === "online_first"` and only for triggers in `IDEA_SESSION_ORIGIN_UPGRADE_TRIGGERS`.

The non-waking pin primitive already exists: `assignIdea` (`idea.service.ts`) and `claimTask` (`task.service.ts`) accept `instanceUuid`, promote to `agent_instance` via `resolveAssigneeFields` / `resolveTaskAssigneeFields`, and emit **only** `emitChange({action:"updated"})`. The **wake** is a separate `createActivity({action:"assigned"})` call in the server actions `claimIdeaToAgentAction` / `claimTaskToAgentAction`. So "reassign without waking" = "call the service with `instanceUuid`, skip the activity."

`resolveRootIdea(companyUuid, entityType, entityUuid)` (`lineage.service.ts`, exported) resolves any entity to its root idea. `listConnectionsForAgent(companyUuid, agentUuid)` (`daemon-connection.service.ts`) returns the agent's `ConnectionView[]` (online-first sorted, carrying `effectiveStatus`, `host`, `cwd`, and durable `agentInstanceUuid`).

## Goals / Non-Goals

- **Goals**: eliminate arbitrary-first-connection wakes by letting the user pin the cwd in the ambiguous case; make the pin durable on the assignee; make the offline pin policy HARD and uniform; make the @mention picker respect the root idea's pin.
- **Non-Goals**: no change to how a wake is delivered/executed; no per-resource pin inheritance for @mention; no schema change.

## Decisions

### D1 — The pre-wake outcome is server-computed via a read-only preview

The client cannot decide the pre-wake action alone because the session-origin liveness check is server-only. A new preview composes, for an Idea + resolved assignee agent, a **three-way outcome** (not a bare boolean) so the single-online case is handled per owner intent (q1=a "auto-pin the single connection" + q2=a "persist"):

```
online := onlineConnections(agent)
if assignee.type == "agent_instance":            outcome = direct   // already pinned
elif online.length == 0:                          outcome = direct   // nothing to pick; server handles offline
elif online.length == 1:                          outcome = auto_pin // persist the sole cwd, no prompt
elif idea has an online session-origin conn:      outcome = direct   // server session-origin upgrade targets it
else /* bare agent, >=2 online, no origin */:     outcome = pick     // ambiguous → prompt
```

Returns `{ outcome: "pick" | "auto_pin" | "direct", onlineInstances: InstanceCandidate[], assigneeAgentUuid }`. `onlineInstances` reuses `listConnectionsForAgent` filtered to online, mapped to the existing `InstanceCandidate` shape (carrying durable `agentInstanceUuid`, the pin the reassign persists). The session-origin online check mirrors `resolveIdeaSessionOriginTarget` (export it or replicate its 3-line query).

Exposed as `GET /api/ideas/[uuid]/wake-preview` (company-scoped; callable by the human user driving the UI). Chosen over a client-side heuristic so the gate exactly matches the server's real wake target. **`auto_pin` vs `direct` for the single-online case:** both wake the same connection, but `auto_pin` also persists the `agent_instance` assignee so the idea is durably pinned to the cwd it runs in (owner q1=a/q2=a); `direct` never persists. The two proposal entry points resolve the idea uuid from the proposal first (approve/reject act on a proposal, but the preview is idea-scoped).

### D2 — Non-waking reassign is a new server action, not a new service

The service layer (`assignIdea`, `claimTask`) is already non-waking. The new server actions `reassignIdeaInstanceNoWakeAction(ideaUuid, agentUuid, instanceUuid)` and the task equivalent call the service with `instanceUuid` and **do not** emit the `assigned` activity. They are distinct from `claimIdeaToAgentAction` (which wakes). Company-scoped, `auth.type` user/super_admin like the existing assign actions.

The two-step flow (elaboration answer q3=a) is client-orchestrated: (1) reassign-no-wake persists the pin; (2) fire the wake. Middle-state handling: if step 2 fails, the assignee is already pinned (not rolled back) and the button surfaces a retry — a benign state (a correctly-pinned idea that simply hasn't been woken yet). We accept the two-step over an atomic "wake carries instanceUuid" variant per the owner's q3=a choice, because it keeps "pin" and "wake" as independently-auditable actions and reuses the untouched wake actions.

### D3 — HARD pin flip (owner choice B)

Flip the two assignment `makePinnedTarget(..., true)` → `soft: false`. Effect via `selectOriginConnection`: an offline assignment pin now returns `offline_pin` (notify-only / `suppressWake`) instead of degrading to online-first — identical to the existing mention-pin path. This unifies SOFT away entirely: **every** pin (mention, task override, idea instance) is HARD. Consequences to handle:

- `require_online` stage-advance actions (`start_development`, `yolo_requested`): when the pinned instance is offline, the action must fail with a distinguishable instance-offline error (the server re-validates online at `stage-advance.service.ts`). Today it checks agent-granularity online; with a HARD instance pin it must check the **pinned instance's** connection.
- `IDEA_SESSION_ORIGIN_UPGRADE_TRIGGERS`: the session-origin upgrade only runs on `online_first`, so a HARD idea pin (now `directed` or `offline_pin`) still bypasses it — unchanged.
- Test blast-radius: the `notification-turn.test.ts` cases asserting "SOFT degrades to online-first" invert to "notify-only + suppressWake". These are updated as part of the flip task.

Because the `soft` field becomes always-`false`, we keep the field (minimal diff, mention path already sets it) rather than removing it in this change; a follow-up cleanup can drop it.

### D4 — @mention respects the root idea's pin (Part 2)

`searchMentionables` gains optional `entityType`/`entityUuid`. When present:
1. `resolveRootIdea` → root idea (null → "no idea ancestor", treat every candidate as non-assignee → current behavior).
2. Read the root idea's `assigneeType`/`assigneeUuid`; if `agent_instance`, resolve its `AgentInstance` place `(host, cwd)`.
3. Per candidate agent, set `isRootIdeaAssignee` (candidate agent uuid === root idea's owning agent uuid) and, when the idea is pinned, `rootIdeaPin: { host, cwd, agentInstanceUuid }`.

`mention-editor.tsx` `selectMentionableRef` branch becomes:
- candidate.`isRootIdeaAssignee` && candidate.`rootIdeaPin` → insert mention pinned to `rootIdeaPin` (no picker), **even if that place is currently offline** (HARD; the wake becomes notify-only). This mirrors the assignment HARD policy.
- candidate.`isRootIdeaAssignee` && no pin && ≥2 online instances → open picker (ambiguous).
- otherwise (not the assignee, or ≤1 online) → the existing logic: ≥2 online → picker; 1 → auto-pin; 0 → un-pinned. Not persisted to the idea.

The single production caller `UnifiedComments` already knows `targetType`/`targetUuid`; it threads them into `<MentionEditor>`, which appends them to the `/api/mentionables` query.

### D5 — Button gating reuses the preview, not a new client predicate

`StartDevelopmentButton` / `YoloButton` / Verify-Elaborate / proposal approve-reject keep their existing enable/disable logic (agent-online gate). The **only** addition is: on click, fetch the wake-target preview and branch on its outcome — `pick` → picker → reassign-no-wake → wake; `auto_pin` → reassign-no-wake (sole instance) → wake; `direct` → wake immediately. The preview is fetched on click (or lazily when the panel opens). This keeps the buttons' disabled semantics unchanged and localizes the new behavior to the click handler. Proposal approve/reject resolve the idea uuid from the proposal's input before requesting the idea-scoped preview.

## Risks / Trade-offs

- **HARD flip is a behavior change for existing pinned assignments.** An operator who pinned an idea to a now-offline cwd will see the wake queue (notify-only) instead of running elsewhere. This is the intended behavior (owner choice B) and is the safer default (never run in the wrong place), but it is a semantic change captured as a MODIFIED spec requirement so review is explicit.
- **Two-step reassign middle state.** Mitigated by D2 (pin persists, retry the wake). No data corruption is possible — a pinned-but-not-woken idea is a valid resting state.
- **Preview staleness.** Connections can go offline between preview and wake. The server's wake resolution is authoritative; if the chosen instance went offline, the HARD policy applies (notify-only / require_online error) — consistent, not a new failure mode.

## Migration

None. No schema/data migration. Existing stored `agent_instance` assignments and comment mention tokens are unaffected in shape; only the offline-resolution *policy* changes (SOFT→HARD).
