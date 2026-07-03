# Design: Conversational idea root session (pre-create + idea-anchored dispatch)

## Overview

Replace the conversational entry's ad-hoc dispatch with a transactional "pre-create idea + idea-anchored session + first instruction" dispatch. The key insight (owner's elaboration answer, r2q1=a): at dispatch time the UI already knows the project, the agent, and the instance — so the Idea can exist **before** the session, and the session can be born idea-anchored (`sessionId = ideaUuid`, `directIdeaUuid = ideaUuid`). All downstream wake routing then works with **zero changes** because the `sessionId === directIdeaUuid` convention holds from the first byte.

## Architecture

### Dispatch flow (new)

```
User (new-idea dialog, conversational tab)
  │  agent + instance picked, description written, Send
  ▼
POST /api/ideas/conversational          ← NEW route
  │  auth: any valid user context (mirrors ad-hoc route posture)
  ▼
createConversationalIdeaSession()       ← NEW service fn (daemon-instruction.service.ts)
  1. validateInstructionText(composed)               — existing, unchanged cap
  2. ownership + connection fences                    — same gates as createAdHocSessionWithInstruction
     (callerOwnsAgent + connectionBelongsToAgent + isConnectionLive)
  3. resolve the connection's AgentInstance            — connection.agentInstanceUuid
  4. idea.service: create Idea
     • createdByUuid = auth.actorUuid (the USER)
     • title = placeholder (first N chars of description, single line)
     • content = user description VERBATIM
     • assigneeType = "agent_instance", assigneeUuid = instance uuid,
       status = "elaborating" (assignment-equals-claim)
  5. resolveOrCreateSession({ sessionId: ideaUuid, directIdeaUuid: ideaUuid,
                              originConnectionUuid: connection })   — write-once, once, correctly
  6. createInstructionTurn (existing chokepoint, promptText = composed instruction)
  7. deliverTurnPing (precise turnUuid to origin connection)        — existing
  ▼
{ session, turn, idea } → frontend closes dialog, openChatForSession(session)
```

Steps 4–6 run inside a `prisma.$transaction` where practical; the turn ping (7) stays
fire-and-forget outside it. If the transaction fails, nothing is created (no orphan).
If the wake later fails (daemon dies, turn errors), the Idea remains visible with the
placeholder title — the accepted orphan posture (r2q3=a, "no silent errors").

### Why no wake-chokepoint change is needed

`createTurnAndResolveTarget` (notification-turn.ts) derives the session key for
idea-anchored wakes as `sessionId = directIdeaUuid` and resolves connections via
(1) the idea's `agent_instance` pin (soft, higher priority) then (2) the idea-session-origin
upgrade. With this design:

- the idea's `agent_instance` pin points at the chosen instance from creation (step 4);
- the session with `sessionId = ideaUuid` already exists with the same origin (step 5);
- so an elaboration/proposal/task wake resolves to the SAME session row and the SAME
  origin connection — `--resume <ideaUuid>` continues the on-disk transcript.

The previously identified "chokepoint opens a new session" defect simply cannot occur:
there is no ad-hoc session to diverge from.

### Instruction template (v2)

`buildIdeaInstruction` is replaced for this entry point. New shape (English, agent-facing;
description passes through verbatim):

```
[Chorus conversational idea entry] A new idea has been PRE-CREATED for project "<name>"
(projectUuid: …) from the user's description below and assigned to you.
  ideaUuid: <uuid>

Do the following, in order:
1. Edit the idea (chorus_edit_idea): derive a concise title from the description and
   polish the content (keep the user's original meaning; you may restructure).
2. Start elaboration immediately (chorus_pm_start_elaboration) following the idea skill —
   do NOT wait for another wake. Post a short summary of your questions in this
   conversation and direct the user to answer in the idea's elaboration panel.
3. End the turn. The user's panel answers will wake this same conversation.

--- User's idea description ---
<verbatim text>
```

Notes:
- No `chorus_pm_create_idea`, no `chorus_claim_idea` — the idea exists and is already
  assigned+elaborating (claim would fail; the template must not mention it).
- Char budget: template overhead stays comfortably under the reserved 1000-char headroom
  (USER_TEXT_MAX_CHARS 3000 / MAX_INSTRUCTION_CHARS 4000 split is unchanged).

### Placeholder title derivation

`deriveplaceholderTitle(description)`: first non-empty line, trimmed, truncated to
~60 chars with ellipsis. Server-side (service), not client-side, so every consumer of the
endpoint gets identical behavior. The agent's first action is to replace it.

### ConversationalEntry component contract

The component keeps owning: online detection, agent Select, InstancePicker, textarea +
budget counter, error surface. Change: dispatch becomes pluggable.

```ts
interface ConversationalEntryProps {
  buildInstruction: (userText: string) => string;
  // NEW — when provided, replaces the default ad-hoc POST. Receives everything the
  // consumer needs to hit its own endpoint; must return the created SessionView.
  dispatch?: (args: {
    agentUuid: string;
    connectionUuid: string;
    instructionText: string;
  }) => Promise<SessionView>;
  offlineFallback?: ReactNode;
  onStarted: (session: SessionView) => void;
  defaultAgentUuid?: string;
}
```

Default `dispatch` = current ad-hoc POST (backward compatible; component tests keep
passing). The create-idea consumer passes a dispatch that calls
`POST /api/ideas/conversational` with `projectUuid` closed over. Error mapping (409 →
`connectionWentOffline` + refresh, other → `sendError`) stays inside the component; the
consumer dispatch throws a typed error carrying the response so the component can keep
that behavior — concretely the dispatch returns the parsed `SessionView` on success and
throws `ConversationalDispatchError { status, serverMessage }` on failure.

### API design

`POST /api/ideas/conversational`

```jsonc
// request
{
  "projectUuid": "…",
  "agentUuid": "…",
  "connectionUuid": "…",
  "descriptionText": "…"   // the USER's raw text; server composes the final instruction
}
// 200 → { success: true, data: { idea, session, turn } }
```

Decision: the server composes the instruction (template moves server-side next to the
endpoint) — the ideaUuid must be inside the instruction, and only the server knows it
before the idea exists. `build-idea-instruction.ts` therefore moves from the dashboard
folder to the service layer (exported for unit tests); the client sends only the raw
description. This also removes the client-side template/char-budget coupling: the server
validates the COMPOSED length against MAX_INSTRUCTION_CHARS as before, and the client
keeps the 3000-char user cap purely as UX.

Error mapping mirrors the ad-hoc route: unowned/foreign/absent connection → 404
non-disclosure; offline connection → 409; empty/over-length text → 400; unknown
project or project not in caller's company → 404.

### Chat-list presentation

`daemon-chat.tsx` already renders sessions with `directIdeaUuid != null` with the idea
title + "Idea" badge + jump-to-idea affordance, and the ad-hoc fallback only fires for
null anchors. Since the session is born anchored, the conversation list shows the idea
title as soon as the list refreshes (the seeded `SessionView` from the dispatch response
already carries `directIdeaUuid`; `ideaTitle` hydrates on the next list fetch — matching
how other idea-anchored sessions behave today). q6=a is satisfied with **no new UI work**
beyond verifying the seeded-session path carries the anchor.

## Data model

No schema change. No new Prisma model, no new field. (This is the main payoff of
pre-creation over backfill.)

## Module contracts (cross-task)

- `createConversationalIdeaSession(auth, { projectUuid, agentUuid, connectionUuid, descriptionText })`
  → `{ idea: IdeaResponse, session: SessionView, turn: TurnView }`; throws
  `ConnectionNotVisibleError | ConnectionOfflineError | InstructionTextError |
  ProjectNotVisibleError(new)`.
- `composeConversationalIdeaInstruction(idea, project, descriptionText)` → string
  (server-side template; exported for tests; single source of the template text).
- `deriveplaceholderTitle(description)` → string (exported for tests).
- `ConversationalEntry.dispatch` prop contract as above; default preserves current
  behavior byte-for-byte.

## Risks & mitigations

- **Template drift between skill docs and server template** — the template is code
  (service layer), reviewed in diff; skill docs describe behavior, not the literal text.
- **Placeholder idea visible before agent edits** — accepted (r2q2=b); typical window is
  seconds. If the agent never edits, the idea remains editable/deletable by the user
  (r2q3=a).
- **Idea created but session/turn creation fails mid-transaction** — steps 4–6 are one
  transaction: all-or-nothing. Ping failure after commit is the existing
  fire-and-forget posture (turn persists; reconnect backfill delivers).
- **Agent tries to claim the pre-created idea** (stale habit from old template) —
  `claimIdea` throws `AlreadyClaimedError`; template explicitly says edit-not-claim; the
  idea skill already tolerates claim failure by reading current assignee.
