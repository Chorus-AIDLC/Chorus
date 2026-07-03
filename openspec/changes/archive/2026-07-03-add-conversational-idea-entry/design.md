# Technical Design: Conversational Idea Entry

## Overview

Frontend-only increment. Three moving parts:

1. A reusable `ConversationalEntry` component (detect online connections → pick instance → compose instruction from template → dispatch ad-hoc session).
2. `NewIdeaDialog` grows a mode switch (form ↔ conversational) and becomes the component's first consumer.
3. The presence context's one-shot chat focus target learns to focus a specific session, so dispatch can land the user in the right transcript.

Everything server-side already exists: `POST /api/daemon-sessions/ad-hoc` creates the session + human-instruction turn and pings the daemon; the SSE pipeline streams the transcript; `MAX_INSTRUCTION_CHARS = 4000` is enforced server-side.

## Architecture

```
NewIdeaDialog (mode: "form" | "conversation")
 ├── form mode: existing static form (unchanged, default)
 └── conversation mode:
      ConversationalEntry
       ├── useAgentPresenceOptional() → connections (effectiveStatus === "online")
       ├── agent select + InstancePicker (ConnectionView[] → InstanceCandidate[])
       ├── description textarea (client cap, see Template Contract)
       ├── buildInstruction(userText) ← passed by consumer (NewIdeaDialog)
       └── POST /api/daemon-sessions/ad-hoc { agentUuid, connectionUuid, instructionText }
             └── onStarted(session) → NewIdeaDialog closes itself
                   └── openChatForSession(agentUuid, session.uuid)  ← extended focus target
                         └── AgentConnectionsModal / DaemonChat selects the session,
                             setOpenSession(session.uuid) → live SSE transcript
```

## Component Contracts

### `ConversationalEntry` (new, `src/components/agent-presence/conversational-entry.tsx`)

Reusable across future entry points (create task, create proposal). This release wires exactly one consumer.

```ts
interface ConversationalEntryProps {
  // Composes the final instruction around the user's free text.
  // The CONSUMER owns the template; the component owns transport + selection.
  buildInstruction: (userText: string) => string;
  // Rendered when no daemon connection is online (consumer may pass a
  // DaemonConnectCta-based hint; component provides a sensible default).
  offlineFallback?: React.ReactNode;
  // Called with the created session after successful dispatch.
  onStarted: (session: SessionView) => void;
  // Optional preselected agent (e.g. future idea-detail entry point).
  defaultAgentUuid?: string;
}
```

Behavior:

- Presence source: `useAgentPresenceOptional()`. `null` context or zero online connections → render `offlineFallback` (with a built-in default that composes `DaemonConnectCta` variant "compact"; command literal stays in `DAEMON_START_COMMAND`, never in i18n strings).
- Grouping: online `ConnectionView[]` grouped by `agentUuid`; agent picked via shadcn `Select` (same pattern as `AdHocSendForm`); instances of the picked agent mapped to `InstanceCandidate[]` and rendered with the shared `InstancePicker` (single instance auto-selects).
- Dispatch: `POST /api/daemon-sessions/ad-hoc`. Error surfaces follow the api-response envelope; 409 (connection went offline between poll and send) shows a retry-able inline error and refreshes the connection list.
- Enter-to-send in the textarea MUST route through `isImeComposing(e)` from `@/lib/ime` before treating Enter as submit (project-wide IME guard rule). Plain Enter sends; Shift+Enter inserts a newline (the verified `AdHocSendForm`/`ComposeField` binding — proposal-review Note-1 corrected this doc's earlier Cmd/Ctrl+Enter wording).
- Implementation should extract/reuse rather than duplicate `AdHocSendForm` internals where practical (`send-instruction-box.tsx` already implements agent+instance selection and the ad-hoc POST; acceptable outcomes are either `ConversationalEntry` wrapping a generalized `AdHocSendForm` or sharing extracted hooks).

### Instruction Template Contract (owned by `NewIdeaDialog`, reviewed deliverable)

```ts
function buildIdeaInstruction(projectUuid: string, projectName: string, userText: string): string {
  return [
    `[Chorus conversational idea entry] The user is describing a NEW IDEA for project "${projectName}" (projectUuid: ${projectUuid}).`,
    ``,
    `Do the following, in order:`,
    `1. Create the idea in that project via chorus_pm_create_idea — derive a concise title from the description; use the full description as the idea content.`,
    `2. Claim the idea (chorus_claim_idea) and start elaboration following the idea skill.`,
    `3. Report the created ideaUuid and title back in this session so the user can open it.`,
    ``,
    `--- User's idea description ---`,
    userText,
  ].join("\n");
}
```

- Template language is English (agent-facing, consistent with daemon prompt precedent in `cli/prompts.mjs`); the user's description passes through verbatim in whatever language it was written.
- Char budget: template overhead is ~500 chars; the textarea client-caps user text at 3000 chars so the composed instruction stays safely under the server's `MAX_INSTRUCTION_CHARS = 4000`. Show a character counter near the limit.
- The template is intentionally imperative and enumerated: with pure conversational mode (elaboration q2=a) there is no frontend fallback if the agent ignores it, so compliance rides on the template. Any wording change is a review-visible diff of this file.

### Focus target extension (`src/contexts/agent-presence-context.tsx` + `chat/daemon-chat.tsx`)

Today `ChatFocusTarget` is `{ agentUuid, pin? }` and `openChatForAgent(agentUuid, pin?)` opens the modal focused on an agent, clearing session selection. Extend:

```ts
interface ChatFocusTarget {
  agentUuid: string;
  pin?: { host: string; cwd: string | null };
  sessionUuid?: string;   // NEW: one-shot session focus
}
// context gains:
openChatForSession(agentUuid: string, sessionUuid: string): void;
```

`DaemonChat`'s focus-target consumption (currently pins the agent and clears session selection) additionally selects `sessionUuid` when present — same code path as `handleSessionStarted` (sets selected session + `setOpenSession(sessionUuid)` for the SSE transcript channel). One-shot semantics unchanged: consumed then cleared. If the session isn't in the fetched list yet (freshly created, list poll lag), seed selection optimistically with the `SessionView` already returned by the ad-hoc POST — `handleSessionStarted` already handles exactly this shape, so route through it.

`openChatForAgent` callers are untouched (`sessionUuid` optional).

### `NewIdeaDialog` integration

- Mode state defaults to `"form"` (elaboration q3=b). A switch control (shadcn `Tabs` or a `Button` toggle — follow existing dialog patterns) appears in the dialog; the conversational tab is disabled-with-hint when zero connections are online (q6=b), never hidden.
- Conversational mode replaces the title/description form body with `ConversationalEntry`, passing `buildInstruction: (text) => buildIdeaInstruction(projectUuid, projectName, text)`. The dialog already receives `projectUuid`; `projectName` must be threaded from the caller (IdeaTracker has it) or fetched — prefer threading a new optional prop.
- `onStarted(session)`: close the dialog, then `openChatForSession(session.agentUuid, session.uuid)`. The `onCreated` callback (panel deep-link) is NOT called — no idea exists yet at dispatch time.
- Derive-child mode (`parentUuid` set) keeps form-only for this release: the template contract doesn't cover lineage; hide the conversational switch when `parentUuid` is present.

## i18n

New keys in BOTH `messages/en.json` and `messages/zh.json` (namespaces: extend `ideaTracker.newIdea.*` for the mode switch, new `conversationalEntry.*` for the component). Offline hint interpolates the command via parameter (`{command}`) fed from `DAEMON_START_COMMAND` — the literal never enters a message string. Every user-facing string via `t()`, including error fallbacks.

## design.pen

The create-idea modal gains a mode switch and a new conversational pane (picker + textarea + offline state) — update `docs/design.pen` via Pencil MCP tools as part of the UI task.

## Testing

- Unit (Vitest): template builder (exact composed output, char budget), connection grouping/mapping to `InstanceCandidate[]`, focus-target reducer behavior (`sessionUuid` consumed once), offline gating logic.
- Manual e2e (Playwright MCP, per e2e-verification skill): with a live local daemon — open modal → switch mode → pick instance → send → chat modal opens on the new session → transcript streams → agent creates idea. Offline path: no daemon → switch disabled with CTA hint.

## Risks & Mitigations

- **Agent non-compliance** (no idea created): accepted per elaboration; template pins actions; description survives in transcript for re-send.
- **Race: connection goes offline between poll and dispatch**: server returns 409 `ConnectionOfflineError`; component shows inline retry + refreshes presence.
- **Session list lag in chat modal**: optimistic seed via the POST's returned `SessionView` (reuses `handleSessionStarted`).
- **projectName unavailability**: threaded prop is optional; template degrades gracefully (uuid always present, name falls back to empty → template still valid).
