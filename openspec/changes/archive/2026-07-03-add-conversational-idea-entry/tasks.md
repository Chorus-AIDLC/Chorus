# Tasks: add-conversational-idea-entry

> Chorus task drafts are the source of truth; this file is a local index only.

## 1. Session-focused chat handoff (presence context + DaemonChat)
- Extend `ChatFocusTarget` with optional `sessionUuid`; add `openChatForSession(agentUuid, sessionUuid)` to the presence context.
- `DaemonChat` consumes `sessionUuid` when present: select the session + `setOpenSession` (route through `handleSessionStarted` semantics so a freshly created session is selectable before list refresh).
- One-shot semantics preserved; existing `openChatForAgent` callers untouched.

## 2. Reusable ConversationalEntry component
- New `src/components/agent-presence/conversational-entry.tsx` per the tech-design contract (`buildInstruction`, `offlineFallback`, `onStarted`, `defaultAgentUuid`).
- Presence-based online detection, agent select + shared `InstancePicker`, description textarea with char budget + counter, IME-guarded Enter, ad-hoc POST dispatch, 409 retry + refresh, built-in offline fallback composing `DaemonConnectCta`.
- Reuse/extract from `AdHocSendForm` where practical. Unit tests.

## 3. Create-idea modal integration + instruction template + i18n
- `NewIdeaDialog` mode switch (form default; conversational disabled-with-hint when offline; hidden in derive-child mode).
- `buildIdeaInstruction(projectUuid, projectName, userText)` template as a reviewable unit; thread `projectName` prop from IdeaTracker.
- `onStarted`: close dialog → `openChatForSession`. i18n keys in en+zh. Update `docs/design.pen`.
- Depends on: 1, 2.

## 4. Integration checkpoint: end-to-end conversational idea entry
- Live local daemon e2e: modal → switch → pick instance → send → chat modal focused on new session → transcript streams → agent creates idea in project.
- Offline path verified. Full suite: lint, tsc, tests.
- Depends on: 3.
