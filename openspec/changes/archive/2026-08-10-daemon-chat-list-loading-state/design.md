# Design: daemon chat conversation-list loading state

## Context

`DaemonChat` (`src/components/agent-presence/chat/daemon-chat.tsx`) is the two-pane chat
modal. Its left pane is `ConversationList`
(`src/components/agent-presence/chat/conversation-list.tsx`), a purely presentational
component that renders the `rows` array it is given and shows an empty state when
`rows.length === 0`.

Two independent async sources feed the chat body:

1. **Presence `status`** — from the shell-level `useAgentPresence()` provider
   (connections poll). Values: `"loading" | "ok" | ...`.
2. **List `listStatus`** — local to `DaemonChat`, tracks its own
   `GET /api/daemon-sessions` fetch. Values: `"loading" | "ok" | "error"`. Set to
   `"loading"` only at initial mount (its `useState` seed); `fetchSessions` sets it to
   `"ok"` on success or `"error"` on failure — **it never resets to `"loading"`**, so the
   15s `setInterval` poll and any re-fetch update the list without returning to a loading
   state.

### The bug

Current derived states (`daemon-chat.tsx:772-782`):

```ts
const loading = status === "loading" && listStatus === "loading";
const showListError = listStatus === "error" && sessions.length === 0;
const noConversations = listStatus === "ok" && sessions.length === 0;
const noAgentsAtAll = noConversations && agents.length === 0;
```

Because `loading` is an **AND** of two independently-settling sources, the interval
`[status becomes "ok"] .. [listStatus becomes "ok"]` has `loading === false` while the
list is still loading. In that window none of the four states are true, so the render
falls through to the two-pane branch, `ConversationList` gets `rows === []`, and shows the
`noSessions` empty card — indistinguishable from a genuinely empty list. This is the
reported ambiguity.

## Decision

### 1. Fix the loading gate

Make the chat body's loading state depend on the **list** fetch alone:

```ts
const listLoading = listStatus === "loading";
```

Rename/repurpose the existing `loading` to this. Rationale: the conversation list is the
thing whose emptiness is ambiguous, and its load status is exactly `listStatus`. The
presence `status` gates agent *names*, not the list's population, so AND-ing it in only
created the leak. Ordering of the derived branches is unchanged (`listLoading` first, then
`showListError`, then `noAgentsAtAll`, then the two-pane body), so the error and
no-agents cards keep priority over the normal list.

Because `listStatus` only ever returns to `"loading"` via the initial `useState` seed
(never re-set by `fetchSessions`), this naturally satisfies the "first load + agent switch
only, silent on 15s poll" requirement: the background poll keeps `listStatus === "ok"`, so
`listLoading` stays false and the skeleton never re-appears. (Agent switch does not
re-fetch the list — the full list for all agents is already loaded and filtered
client-side by `selectedAgentUuid` — so switching agents is instant and shows no skeleton;
the "agent switch" case in the elaboration answer is subsumed by "list not yet loaded".)

### 2. Skeleton in the conversation-list pane

The loading affordance belongs **inside `ConversationList`**, replacing its
`rows.length === 0` empty branch when a new `loading` prop is true, so the agent Select and
"New conversation" button (the list's chrome) stay visible and the skeleton sits in the
list card exactly where rows will land — the smoothest visual transition (elaboration
q1 = Skeleton).

- Add an optional `loading?: boolean` prop to `ConversationList`.
- When `loading` is true, render the list card with a stack of ~5 `Skeleton` placeholder
  rows (from `@/components/ui/skeleton`) in place of both the empty state and the rows.
  Each placeholder mirrors a real row's geometry: a small leading dot-sized skeleton, a
  wider title-line skeleton, and a short meta-line skeleton, padded like the real
  `Row` (`px-4 py-3.5`), separated by the same hairline divider.
- The list header count (`rows.length`) is not meaningful mid-load; render a neutral
  placeholder (e.g. blank or a tiny skeleton) for the count while loading so it doesn't
  flash `0`.

`DaemonChat` passes `loading={listLoading}` to `ConversationList` in **both** the mobile
and desktop instances. The container-level branch is simplified: instead of a top-level
`loading ? <p>…</p>` text branch, the two-pane body renders always (once past the error /
no-agents cards) and the list pane shows its own skeleton — so the header stays visible and
the layout doesn't jump. The right pane during load shows the existing
`NewConversationPane` (nothing selected), which is already a valid, non-error default.

Alternative considered: keep the container-level `loading` text branch and only fix the
gate. Rejected — it produces a bare centered "Loading conversations…" line with no list
chrome, a visual regression from the polished two-pane layout, and does not satisfy the
skeleton choice.

### 3. Error path unchanged

`showListError` (list error with nothing cached) keeps priority over the normal two-pane
body and is evaluated after `listLoading`. Since `listStatus` moves `loading → error` on
failure, `listLoading` is false in the error case and `showListError` wins — the existing
`WifiOff` error card renders, never the empty state. No change needed beyond confirming the
branch order; covered by a scenario + test.

## Risks / trade-offs

- **Very fast loads flash the skeleton briefly.** Acceptable — a sub-frame skeleton is
  strictly better than the current ambiguous empty card, and matches the app's existing
  skeleton usage (e.g. `idea-tracker-list.tsx`). No artificial min-display delay is added
  (avoids added latency perception).
- **`ConversationList` gains a prop.** Small, backward-compatible (optional, defaults to
  non-loading). Its existing tests keep passing without the prop.

## Testing

- Unit/component test for `ConversationList`: `loading` true → renders skeleton rows, not
  the `noSessions` empty state; `loading` false + empty rows → renders empty state;
  `loading` false + rows → renders rows.
- `DaemonChat` state-derivation: assert the previously-leaking combination
  (`status === "ok"`, `listStatus === "loading"`, empty sessions) now yields the loading
  state, not the empty state; and that `listStatus === "error"` yields the error card.
- Manual e2e (Playwright MCP) on the running dev server: open the daemon chat modal, throttle
  the `/api/daemon-sessions` response, confirm the skeleton shows during load and the empty
  state only after a settled empty load, in both light and dark themes.
