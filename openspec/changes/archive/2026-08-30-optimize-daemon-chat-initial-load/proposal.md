## Why

Opening a Daemon Agent conversation can remain loading long enough to block interaction,
especially for long-lived sessions. The startup path can issue duplicate session-list
requests, while the transcript detail read scans an unbounded number of historical turns
to return a 20-entry first page.

## What Changes

- Coalesce concurrent `GET /api/daemon-sessions` calls made by one mounted daemon-chat
  surface, including the mount/focus race and React development remount behavior.
- Bound the transcript detail query to the small newest candidate-turn window sufficient
  to produce the requested message page and its `hasMore` sentinel.
- Preserve transcript cursor semantics, synthetic prompt messages, placeholder turn bands,
  live SSE updates, list refresh behavior, and authorization fences.
- Add regression tests that make both performance bounds observable: one in-flight list
  request and a fixed maximum candidate-turn query size.
- Record a browser-level before/after baseline for the seeded-conversation entry path in
  both the development server and a production build, using the same long-session fixture.
  Production-build median time to an interactive transcript must improve by at least 30%;
  development mode must not regress and must retain query/request evidence because its
  fixed compiler and middleware overhead dominates short API timings.

## Capabilities

### New Capabilities

- `daemon-chat-loading-performance`: Defines bounded and deduplicated initial data loading
  for the Daemon Agent conversation surface.

### Modified Capabilities

None.

## Impact

- Frontend: `src/components/agent-presence/chat/daemon-chat.tsx`
- Backend: `src/services/daemon-session.service.ts`
- Tests: daemon chat modal/component tests and daemon session service tests
- Verification: Playwright timing runs against local development and production-build
  servers with a long-session fixture
- API payloads, database schema, permissions, and user-visible copy remain unchanged.
