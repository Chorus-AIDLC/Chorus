# Show a loading state in the daemon chat conversation list

## Why

In the daemon session chat window (the "View all" modal), the left-pane **conversation
list** shows an empty-state card — "No conversations for this agent" — **before the
session list has finished loading**. That empty state is byte-for-byte identical to the
one shown when an agent genuinely has zero conversations, so during the first-load window
the user is told they have no conversations when in fact the data is still in flight. It
is ambiguous and reads as data loss.

Root cause is in `DaemonChat` (`daemon-chat.tsx`). The loading flag is:

```ts
const loading = status === "loading" && listStatus === "loading";
```

`status` (the shell-level presence/connections poll) and `listStatus` (this component's
own `GET /api/daemon-sessions` fetch) settle **independently**. There is a window where
`status === "ok"` but `listStatus === "loading"`, so `loading` is `false`, all three
other derived states (`showListError`, `noConversations`, `noAgentsAtAll`) are also
`false` (they each require `listStatus === "ok"` or an error), and control falls through
to the two-pane branch. `ConversationList` then receives an empty `rows` array and renders
its `rows.length === 0` empty state — the ambiguous "No conversations" card.

## What Changes

- **Fix the loading gate** so the chat body treats the conversation list as loading
  whenever `listStatus === "loading"` — no longer AND-ed with the independent presence
  `status`. This closes the leak window that shows the empty state prematurely.
- **Add a skeleton loading affordance** to the conversation-list pane: a small stack of
  `Skeleton` placeholder rows shaped like real conversation rows, shown while the list is
  loading, instead of the empty state. Reuses the existing `@/components/ui/skeleton`
  primitive (theme-adaptive, works in light and dark for free).
- **Show the loading state only on first load and agent switch, not on the 15s poll.**
  The list already re-fetches every 15s and on agent switch; `fetchSessions` only sets
  `listStatus` back to a non-`ok` value on genuine failure, so once the first load
  succeeds the background poll updates the list silently without flashing the skeleton.
  This is preserved (and verified) — the skeleton must not blink on every poll tick.
- **Verify the error path stays distinct.** A list-load failure with nothing cached must
  still show the existing error card (`loadErrorTitle` / `loadErrorBody`), never the empty
  state. Confirm this is unaffected by the gate change.

## Capabilities

- `daemon-session-conversation` — adds one UI requirement governing the conversation
  list's loading / empty / error state disambiguation.

## Impact

- **Affected code:** `src/components/agent-presence/chat/daemon-chat.tsx` (loading gate +
  passing a loading flag), `src/components/agent-presence/chat/conversation-list.tsx`
  (render skeleton rows when loading). Possibly one small `daemonChat` i18n key if a
  loading label is surfaced; `daemonChat.loading` already exists and is reused.
- **Scope:** left conversation-list pane only. The right transcript pane already has its
  own loading state (`TranscriptView`'s `loading` prop) and is out of scope.
- **No backend, schema, or API changes.** Pure client-side rendering fix.
- **i18n:** any new user-facing string is added to both `messages/en.json` and
  `messages/zh.json`. No hardcoded text.
- **Themes:** the skeleton uses the semantic `bg-accent` token and works in both light
  and dark themes with no extra work.
