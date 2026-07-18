# Tasks — Fix daemon session running indicator / Interrupt disagreement

## P0 — Conversation-list status uses the composer's cross-connection match

- [ ] Add `sessionExecStatusForRow(executionsByConnection, session)` to
      `src/components/agent-presence/chat/session-execution.ts` — composes
      `sessionExecutionsForComposer` + `sessionExecStatus`.
- [ ] Switch the list-row status in `daemon-chat.tsx` (~line 332) to call it.
- [ ] Add `session-execution` unit tests (origin match, non-origin fallback,
      no cross-borrow, interrupted/error on fallback).
- [ ] `pnpm test` (new tests) + `npx tsc --noEmit` + `pnpm lint` green.

## P1 — Visible warning on null directIdeaUuid with non-null root

- [ ] Add the `root != null && direct == null` `warn` in
      `cli/lineage.mjs#resolveViaServer`, before the success `info`.
- [ ] Extend `cli/__tests__/lineage.test.mjs` (warns on root-without-direct;
      no warn on both-null; no warn on both-present).
- [ ] `pnpm test` green (the lineage suite is a vitest `.test.mjs`, matched by
      `vitest.config.ts` `cli/**/__tests__/**/*.test.mjs` — not `node --test`).
