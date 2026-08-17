# Tasks

## 1. Implement Step 4b deterministic single-connection narrow

- [ ] 1.1 Add Step 4b to `createTurnAndResolveTarget` in `src/services/notification-turn.ts`
      (after step 4a, before the `offline_pin`/`none` gate): promote a residual-family
      `online_first` selection to `directed` on the already-chosen online-first connection.
- [ ] 1.2 Add unit tests in `src/services/__tests__/notification-turn.test.ts` covering:
      narrow fires for un-pinned residual triggers with multiple online connections;
      convergence (same connection set → same target); step-4 origin precedence;
      pinned/offline-pin/none/`human_instruction` unaffected; un-pinned vs pinned mention.
- [ ] 1.3 `pnpm test` (notification-turn), `npx tsc --noEmit`, and `pnpm lint` all green.
