## Why

Comments currently expose no direct way to remove an accidental post or address its author, forcing users to leave the discussion flow and manually reconstruct mentions. A consistent action surface should make those operations immediate while preserving ownership boundaries and Chorus's instance-aware Agent routing.

## What Changes

- Add a three-dot action trigger to every comment in the shared comment component.
- Show Reply for every comment and show Delete only for comments authored by the current user or one of that user's Agents.
- Require confirmation before deletion, enforce the same ownership rule on the server, and remove a successfully deleted comment from the list.
- Preserve an existing draft when replying, insert a structured mention for the comment author, and focus the editor.
- Reuse current entity-aware mention routing for Agent replies, including project-fixed cwd, Idea pins, hard-pin behavior, and the existing multi-instance picker.
- Render actions as a dropdown on desktop and a touch-sized bottom sheet on mobile.
- Add localized English and Chinese copy plus service, server-action, and component coverage.
- After verification, deploy the change through the repository's existing deployment workflow, smoke-test the live comment actions, and open (but do not merge) a pull request targeting `develop`.

## Capabilities

### New Capabilities

- `comment-actions`: Ownership-safe deletion and entity-aware reply actions across all unified comment surfaces.

### Modified Capabilities

None.

## Impact

- `src/services/comment.service.ts` gains company-scoped deletion authorization and deletion behavior.
- `src/app/(dashboard)/projects/comment-actions.ts` exposes the user-authenticated delete operation.
- `src/components/unified-comments.tsx` and `src/components/mention-editor.tsx` gain the responsive action UI and an imperative, pin-aware reply insertion path.
- Comment translations and focused unit/service tests are extended.
- Delivery includes the configured Chorus deployment and a feature-branch PR to `develop`; merge remains a human gate.
- No Comment schema migration is required because Agent replies deliberately target the current entity route rather than the historical author instance.
- The project owner explicitly waived `docs/design.pen` as a completion requirement while Pencil MCP is unavailable. Updating the encrypted design artifact remains a non-blocking follow-up and MUST use Pencil MCP when connectivity is restored.
