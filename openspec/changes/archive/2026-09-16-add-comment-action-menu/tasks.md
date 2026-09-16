## 1. Ownership-safe deletion

- [x] 1.1 Add company-scoped comment deletion authorization for a user's own comments and comments from Agents they own, including Mention cleanup and realtime notification.
- [x] 1.2 Expose the authenticated server action and cover allowed, forbidden, missing, and failure cases.

## 2. Responsive comment actions

- [x] 2.1 Extend MentionEditor with a draft-preserving, entity-aware programmatic mention insertion path that reuses existing Agent pin and instance-picker precedence.
- [x] 2.2 Add desktop dropdown and mobile bottom-sheet comment actions, deletion confirmation, local count/list updates, focus handling, and localized English/Chinese copy.
- [x] 2.3 Add component tests for visibility, confirmation, reply insertion, Agent routing ambiguity, accessibility, and responsive presentation.

## 3. Verification

- [x] 3.1 Run focused service/action/component tests, TypeScript and lint checks, OpenSpec validation, and responsive browser verification in both themes.

## 4. Delivery

- [x] 4.1 Deploy the verified change through the repository's existing deployment workflow and smoke-test Delete and Reply on the configured live Chorus environment.
- [x] 4.2 Inspect the final diff, push the feature branch, and open (but do not merge) a pull request targeting `develop`.

## Deferred follow-up

- Update `docs/design.pen` through Pencil MCP with desktop dropdown, mobile bottom-sheet, and deletion-confirmation states after Pencil connectivity is restored. The project owner explicitly approved this as non-blocking for the current delivery.
