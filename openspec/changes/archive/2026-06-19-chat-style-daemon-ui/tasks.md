# Tasks — Chat-style Daemon UI

## 1. Backend: session detail read + ad-hoc visibility fix

- [ ] 1.1 Add `getSessionDetail(auth, sessionUuid)` to `daemon-session.service.ts`
      returning session + turns-with-messages (one batched message query, no N+1),
      owner-scoped, `null` → 404 non-disclosure. Unit tests.
- [ ] 1.2 Add `GET /api/daemon-sessions/[sessionUuid]/route.ts` wrapping it.
- [ ] 1.3 Ad-hoc fix: add `daemon_session` to `EXECUTION_ENTITY_TYPES`; validate it
      against `DaemonSession` in `filterValidExecutionEntities` /
      `groupEntityUuidsByType`; enrich its title from `DaemonSession`; confirm the
      ingest route zod enum derives from the constant. Unit tests.

## 2. Backend: live transcript SSE forwarding

- [ ] 2.1 Extend `/api/events` to subscribe `transcript:{sessionUuid}` for the open
      session (visibility-checked), tag events `type: "transcript"`.
- [ ] 2.2 Carry the appended message tail on the `transcript_appended` publish so
      the client renders appends without a refetch.
- [ ] 2.3 Add `useTranscriptSubscription(sessionUuid, cb)` to `realtime-context.tsx`.

## 3. Frontend: chat-style modal

- [ ] 3.1 `chat/conversation-list.tsx` — agent dropdown + paginated session list.
- [ ] 3.2 `chat/turn-band.tsx` + `chat/message.tsx` — turn provenance bands +
      message rendering, running-turn pulse (motion-safe).
- [ ] 3.3 `chat/transcript-view.tsx` — right pane: header + collapsible metadata +
      bands + reused `SendInstructionBox` + interrupt control.
- [ ] 3.4 `chat/daemon-chat.tsx` — two-pane composition, detail fetch, live SSE
      wiring, empty/offline/error states, responsive desktop↔mobile.
- [ ] 3.5 Swap modal body to `DaemonChat`; `daemon_session` label in
      `useEntityTypeLabel`; i18n keys in en.json + zh.json.

## 4. Design + verification

- [ ] 4.1 Update `docs/design.pen` for the redesigned modal.
- [ ] 4.2 Local e2e: typecheck, lint, tests, and a Playwright walkthrough of the
      chat modal against the running dev server.
