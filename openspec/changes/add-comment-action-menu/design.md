## Context

`UnifiedComments` is the single UI used by Idea, Proposal, Task, and Document discussions. It already owns cursor pagination, optimistic inserts, realtime reconciliation, and a `MentionEditor` supplied with entity context. Mention selection already resolves project-fixed cwd, direct-Idea assignee pins, single online instances, and the multi-instance picker, but that logic is only reachable through the editor's typed `@` suggestion flow.

Comments store `authorType` and `authorUuid`, not the Agent instance that originally posted them. The chosen product behavior is therefore to route an Agent reply using the discussion's current entity context rather than add historical instance provenance.

## Goals / Non-Goals

**Goals:**

- Provide accessible Delete and Reply actions on every unified comment surface.
- Enforce deletion ownership in the service layer, independent of UI visibility.
- Reuse the exact mention-selection precedence and instance picker used by typed mentions.
- Preserve pagination totals, optimistic state, realtime behavior, drafts, focus, localization, and responsive interaction conventions.

**Non-Goals:**

- Threaded or nested comments.
- Editing comments, restoring deleted comments, tombstones, or undo.
- Persisting the Agent instance that originally authored a comment.
- Adding a public MCP comment-delete tool.

## Decisions

### Deletion is authorized in the service layer

`deleteComment` will fetch the comment within the caller's company and permit deletion only when its author is the acting user or when its author is an Agent owned by that user. The server action accepts only browser user authentication and delegates authorization to the service. A transaction removes the comment and its derived Mention records, then emits the normal entity update event. Hiding Delete in the UI is an affordance, not the security boundary.

This is preferred over trusting author metadata returned to the browser because callers can invoke server actions directly and client state can be stale.

### Reply insertion goes through one pin-aware editor API

`MentionEditorRef` will expose an imperative reply method that accepts the author's stable mention identity. For humans it inserts the user mention immediately. For Agents it retrieves the same entity-enriched mentionable candidate used by typed mentions and runs the existing `resolveMentionSelection` precedence:

1. project-fixed cwd,
2. current direct-Idea assignee pin,
3. one online instance auto-pin,
4. multiple online instances open the existing picker,
5. no instance remains unpinned.

The method appends to, rather than replaces, editor content and focuses after insertion or picker completion. This avoids a second routing implementation and preserves hard-pin notify-only behavior when the selected destination is offline.

### One responsive action component follows incumbent Tracker patterns

Desktop uses the existing Radix/shadcn dropdown primitives aligned to the comment's top-right. Mobile uses the same `max-width: 639px` responsive convention as the Idea Tracker Actions menu and renders a bottom `Sheet` with safe-area padding and at least 44px touch rows. The destructive action is visually separated and confirmed in an `AlertDialog`.

The trigger remains keyboard reachable with a localized accessible label. Confirmation and picker state are owned above transient menu content so closing the dropdown or sheet cannot destroy them.

### Live delivery is part of completion

The code is deployed using the repository's existing deployment workflow and smoke-tested against the configured live Chorus environment. Only after a successful deployment check will the feature branch be pushed and a pull request opened against `develop`; the PR will not be merged automatically.

Pencil MCP is currently unavailable because no Pencil-enabled VS Code session is connected. The project owner explicitly approved temporarily skipping `docs/design.pen`, so the encrypted design artifact is a non-blocking follow-up rather than a completion gate. It MUST only be updated through Pencil MCP when connectivity is restored. This preserves the explicit delivery order and repository safety rules while keeping merge approval with a human.

### Local state updates are UUID-based

After successful deletion, `UnifiedComments` removes the UUID from its loaded window and decrements the server total once. A subsequent realtime refresh remains safe because merging is UUID-based and the deleted row is absent from the newest server page.

## Risks / Trade-offs

- **[Risk] A direct Agent reply accidentally bypasses existing pin rules.** → Route all programmatic insertion through the same `resolveMentionSelection` helper and add tests for fixed, inherited, single-instance, multi-instance, and unpinned outcomes.
- **[Risk] Menu state unmounts a confirmation dialog or instance picker.** → Keep dialog/picker ownership outside dropdown/sheet content and test the transition.
- **[Risk] A stale UI shows Delete after ownership changes.** → Re-check ownership in the service and return a generic failure without deleting.
- **[Risk] Realtime events race with local deletion.** → Apply UUID-based local removal and fetch authoritative pages on subsequent entity events.
- **[Risk] Design documentation temporarily trails the shipped UI.** → Preserve browser screenshots and automated responsive-state coverage now; update `docs/design.pen` through Pencil MCP as a non-blocking follow-up when connectivity is restored.
- **[Risk] Deployment succeeds but the PR omits generated or spec artifacts.** → Create the PR only after deployment smoke checks and inspect the final branch diff before push.

## Migration Plan

No database migration is required. Deploy service/action changes and UI changes together through the existing project workflow, then smoke-test Delete and Reply on the live environment. Rollback redeploys the prior application revision; existing Comment and Mention data remains compatible. After a successful check, push the feature branch and open a PR to `develop` without merging it.

## Open Questions

None.
