# Proposal: Conversational idea entry pre-creates the Idea and makes the conversation its root session

## Why

The 0.13.1 conversational idea entry (add-conversational-idea-entry) lets a user describe a new idea to an online daemon agent, but the conversation it creates is a plain **ad-hoc** daemon session (`directIdeaUuid = null`, server-generated `sessionId`). The woken agent creates the Idea via `chorus_pm_create_idea`, and from that point the conversation and the Idea are strangers:

- Every subsequent idea-anchored wake (elaboration answers, Verify Elaborate, proposal approval/rejection, task assignment) derives its session key by the `sessionId === directIdeaUuid` convention and therefore **opens a new session** instead of continuing the conversation the user is already in.
- The agent stops at an "idea created" report; the user must leave the chat and wait for a separate wake before elaboration starts.
- The chat list shows the conversation as an anonymous ad-hoc entry with no link to the Idea it produced.

Elaboration (2 rounds, 13 questions, human-verified) converged on a pre-creation design proposed by the owner: since the UI knows everything at dispatch time, **create the Idea first and anchor the session to it from birth** — no session mutation, no relaxation of the write-once invariants, and every existing wake-routing mechanism works unchanged.

## What Changes

- **New transactional dispatch endpoint** (`POST /api/ideas/conversational`): in one service-layer operation —
  1. pre-create the Idea **as the initiating user** (`createdBy` = user), with a placeholder title derived from the description and the full verbatim description as content;
  2. assign it to the chosen agent **instance** (host+cwd) and set it to `elaborating` (assignment-equals-claim, matching existing `assignIdea` semantics), so the `agent_instance` pin points at the correct cwd from day one;
  3. create the daemon session **idea-anchored from birth**: `sessionId = ideaUuid`, `directIdeaUuid = ideaUuid`, origin = the chosen connection — the write-once fields are written once, correctly, at creation;
  4. create the first `human_instruction` turn (via the existing chokepoint) and deliver it precisely to the origin connection (existing `deliverTurnPing`).
- **New instruction template** (replacing the create-claim template for this entry): the woken agent **edits** the pre-created Idea (real title + polished content), immediately starts elaboration, posts a guidance summary into the conversation, and ends the turn. The user answers in the idea panel (structured answers remain the source of truth); the resulting elaboration wake lands back in this same session automatically via the existing `sessionId === directIdeaUuid` convention.
- **ConversationalEntry component** gains a consumer-owned dispatch function (parallel to the existing `buildInstruction` contract) so the create-idea consumer can call the new endpoint while the component keeps owning detection/selection/transport UX. The old ad-hoc endpoint is untouched.
- **No wake-chokepoint changes**: because the session is idea-anchored from birth, `resolveIdeaSessionOriginTarget`, `resolvePinnedTarget`, and the session-key derivation in `createTurnAndResolveTarget` all work as-is. The full idea lifecycle (elaboration → proposal → tasks) converges on this conversation with zero routing changes.

## Non-goals / explicitly decided against

- **No backfill of `directIdeaUuid` on existing ad-hoc sessions** (round-1 q1a superseded by round-2 r2q1=a). Write-once invariants stay intact.
- **No hidden/draft idea state** (r2q2=b): the pre-created Idea is a normal, immediately visible Idea with a placeholder title; the agent edits it into shape within seconds. Zero schema change, no orphan-cleanup machinery.
- **No auto-cleanup of orphans** (r2q3=a): if the wake fails, the placeholder Idea stays visible for manual edit/delete — the user's description is preserved (no silent data loss).
- **Only this entry point** (q3=a): agent-initiated `chorus_pm_create_idea` from arbitrary ad-hoc chats does NOT bind sessions. A session, once anchored, never re-binds (q4=a).
- **Panel-first elaboration answering** (q5=b): the chat guides; the idea panel records.

## Capabilities

- `conversational-idea-entry` (MODIFIED + ADDED): dispatch becomes pre-create + idea-anchored session; template becomes edit + elaborate; new requirements for root-session convergence, orphan visibility, and the component's consumer-owned dispatch. The `daemon-session-conversation` capability needs **no delta** — its existing requirements already define idea-anchored sessions (`sessionId = directIdeaUuid`) and the chat list already renders them with idea affordances; this change just creates such a session from a new call site.

## Impact

- **Backend**: new route `src/app/api/ideas/conversational/route.ts`; new service function in `daemon-instruction.service.ts` (composes `idea.service.createIdea`+`assignIdea` semantics with `resolveOrCreateSession` + `createInstructionTurn`); no schema change; no MCP tool change.
- **Frontend**: `ConversationalEntry` gets an optional `dispatch` prop; `new-idea-dialog` supplies the new-endpoint dispatch + revised template; chat handoff (`openChatForSession`) unchanged.
- **Docs/skills**: create-idea template contract update is code-local (build-idea-instruction.ts); no MCP tool docs change needed (no new tool).
- **Risk**: placeholder title briefly visible in idea lists (accepted, r2q2=b); wake failure leaves a visible placeholder idea (accepted, r2q3=a — matches "no silent errors").
