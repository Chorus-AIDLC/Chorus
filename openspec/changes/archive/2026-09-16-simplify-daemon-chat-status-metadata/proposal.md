## Why

The Agent Daemon transcript header repeats an “Active” session badge beside the more useful live running indicator, while the connection disclosure exposes a relative process start time that adds noise without helping users control or identify the conversation. Removing those two elements makes the chat header easier to scan while preserving actionable state.

## What Changes

- Remove the “Active” badge from the transcript header for every active Agent Daemon conversation.
- Keep the existing “Ended” badge for ended conversations and retain the running pulse, elapsed runtime, token usage, copy-session action, and connection-details trigger.
- Remove the relative “Started” row from the expanded connection details and let the remaining fields close the gap naturally.
- Preserve the connection identity, uptime (when online), host, controls, transcript behavior, and all backend data contracts.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `daemon-session-transcript-read`: Simplify the transcript header and connection disclosure without weakening live execution state or connection identity.

## Impact

- Frontend: `src/components/agent-presence/chat/transcript-view.tsx`.
- Tests: focused `TranscriptView` header/disclosure assertions in the existing agent-presence test suite.
- Design source: update `docs/design.pen` through Pencil so the canonical Agent Daemon chat screen matches the simplified header and connection disclosure.
- No API, database, daemon runtime, permission, dependency, or migration changes.
