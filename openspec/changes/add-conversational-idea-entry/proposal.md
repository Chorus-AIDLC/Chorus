# Proposal: Conversational Idea Entry — describe an idea to an online daemon from the create-idea modal

## Why

Creating an idea today is a static form: the user types a title and description, submits, and then waits for an agent to claim and elaborate it in separate asynchronous steps. Meanwhile 0.13.x already shipped the full infrastructure this flow could ride on — resident daemon connections with owner-scoped presence, ad-hoc daemon sessions woken by human instructions, and a live chat-style transcript view. The create-idea entry point simply doesn't use any of it.

This change compresses "create idea → agent claims → elaboration starts" into a single conversational interaction: the user describes the idea directly to an online daemon and immediately watches the agent create the idea and open elaboration, live in the chat view.

## What Changes

1. **Reusable conversational entry component** (`ConversationalEntry`): detects online daemon connections via the presence context, lets the user pick the target agent + connection instance (host+cwd, reusing the shared `InstancePicker`), composes the user's free-text description into a fixed instruction template, dispatches it as an ad-hoc daemon session (`POST /api/daemon-sessions/ad-hoc`), and hands the created session to its consumer. Designed as a reusable component so later releases can attach it to other entry points (create task, create proposal); this release wires exactly one consumer.
2. **Create-idea modal integration**: `NewIdeaDialog` keeps the static form as the default and gains an explicit "describe to an agent" switch, visible when the presence context is available. When no daemon connection is online the conversational mode is disabled with a hint that reuses the shared `DaemonConnectCta` (startup command stays out of i18n strings).
3. **Instruction template with project context**: the dispatched instruction embeds the project UUID + name and a fixed directive — create the idea in this project via MCP, claim it, start elaboration, and report the created ideaUuid back into the session. The idea entity is created by the woken agent, not the frontend (pure conversational mode). The template is a reviewed deliverable in the tech design.
4. **Session-focused chat handoff**: after dispatch, the modal closes and the existing daemon chat modal opens focused on the newly created session. This extends the presence context's one-shot chat focus target (which today can only focus an agent) to also carry a session UUID.

No backend, API, or schema changes: all server capabilities (ad-hoc session creation, human-instruction turn, deliver_turn ping, SSE transcript) already exist. This is a frontend-only increment.

## Capabilities

### New

- `conversational-idea-entry`: the reusable conversational entry component, its create-idea modal integration, the instruction template contract, offline fallback behavior, and the session-focused chat handoff.

### Modified

- None. (The chat focus-target mechanism in the presence context is not covered by any existing spec; its extension is specified as part of the new capability.)

## Impact

- **Frontend components**: `src/app/(dashboard)/projects/[uuid]/dashboard/new-idea-dialog.tsx` (mode switch), new `src/components/agent-presence/conversational-entry.tsx` (or equivalent), `src/contexts/agent-presence-context.tsx` (focus target gains `sessionUuid`), `src/components/agent-presence/chat/daemon-chat.tsx` (consume session focus).
- **i18n**: new keys in both `messages/en.json` and `messages/zh.json`.
- **Reused as-is**: `InstancePicker`, `DaemonConnectCta` (`DAEMON_START_COMMAND` constant), `POST /api/daemon-sessions/ad-hoc`, SSE transcript pipeline, `MAX_INSTRUCTION_CHARS` (4000) server cap.
- **Out of scope**: offline queuing of instructions; structured "idea created" cards in the transcript; other entry points (create task/proposal) consuming the component; any daemon CLI/prompt changes.

## Risks

- **Idea creation depends on agent compliance**: with pure conversational mode there is no frontend fallback if the woken agent fails to create the idea. Accepted trade-off (elaboration q2=a): the user's description survives in the session transcript and can be re-sent; the instruction template pins the expected actions to maximize compliance.
- **Ad-hoc turns carry no project entity**: the server stamps ad-hoc sessions as `daemon_session` entities with empty projectUuid, so project context must live inside the instruction text. The template makes this explicit and the char budget reserves room for it.
