# Technical Design: Daemon chat mobile fullscreen + content-width fix

## Overview

Two CSS/layout-only fixes on the daemon conversation modal. No server, schema, API, or data changes. The component chain is:

```
AgentConnectionsModal (connections-modal.tsx)
  └─ DialogContent                      ← problem 1: responsive sizing
       └─ DaemonChat (daemon-chat.tsx)
            ├─ mobile drill-down box     ← problem 1: full-height flex column
            ├─ ConversationList
            └─ TranscriptView (transcript-view.tsx)
                 └─ TurnBand → Message (message.tsx)
                      └─ MarkdownContent  ← problem 2: wide-block width constraint
```

## Problem 1 — Mobile fullscreen modal

### Layout contract

The whole modal is a single flex column whose total height is bounded by the viewport, so the inner transcript `ScrollArea` scrolls internally and the footer (reply input) is pinned to the bottom edge rather than pushing the dialog past the viewport.

- **`DialogContent` (connections-modal.tsx):** responsive split at the `sm` breakpoint.
  - Mobile (`< sm`): `h-dvh max-h-dvh w-screen max-w-none rounded-none border-0` — edge-to-edge fullscreen, no floating margins. Use `dvh` (dynamic viewport height), **not** `vh`, so the mobile browser URL bar collapsing/expanding cannot push the pinned input off-screen.
  - Desktop (`sm+`): restore the floating, height-capped card — `sm:h-[92vh] sm:max-h-[92vh] sm:w-[min(96vw,1100px)] sm:max-w-[min(96vw,1100px)] sm:rounded-lg sm:border`.
  - Stays padding-free (`p-0 gap-0 overflow-hidden flex flex-col`); the chat view owns its own padding and internal scroll regions.
- **Mobile drill-down body (daemon-chat.tsx):** the `mobileDetailOpen` branch is a full-height flex column (`flex h-full min-h-0 flex-lg:hidden`): a non-shrinking back-button header row (`shrink-0`) plus a content region that takes the remaining height (`min-h-0 flex-1`) and owns its own scroll. Replaces the previous fixed `h-[70vh]` box that floated the footer mid-screen with dead space below.

> **Source of truth:** the working tree already carries this exact change (verified in `connections-modal.tsx` and `daemon-chat.tsx`). This task's job is to confirm it is correct, complete (e.g. any other hardcoded mobile heights), and e2e-verified — not to redesign it. If it diverges from the contract above, reconcile to the contract.

### Why the height chain must be unbroken

For the footer to pin to the bottom, **every** ancestor from `DialogContent` down to the `TranscriptView` flex column must propagate a bounded height (`h-full`/`flex-1`) and allow shrinking (`min-h-0`). `TranscriptView` is already `flex h-full min-h-0 flex-col` with the body `ScrollArea` as `min-h-0 flex-1` and the footer as a static (non-scrolling) row, so once the drill-down box stops capping at `70vh` the existing structure does the rest. Watch for any intermediate wrapper that drops `min-h-0` — a single missing `min-h-0` makes a flex child refuse to shrink and reintroduces the overflow/dead-space.

## Problem 2 — Wide markdown block content width

### Root cause

`message.tsx` renders an assistant reply as:

```tsx
<div className="prose prose-sm max-w-none break-words ...">
  <MarkdownContent>{message.text}</MarkdownContent>
</div>
```

`MarkdownContent` (Streamdown) emits raw `<table>` / `<pre>` / `<img>` with no width clamp. A wide table establishes a min-content width larger than the bubble; because no ancestor sets `min-w-0`, the flex/`prose` container grows to fit it and the whole transcript column (and the dialog on mobile) overflows horizontally.

### Fix (scoped to the daemon transcript message)

Constrain wide blocks at the message wrapper level, leaving the shared `MarkdownContent` / global markdown surfaces (Ideas / Comments / Documents) untouched:

1. **Allow the wrapper to shrink:** the markdown wrapper (and its relevant flex ancestors inside the message/turn band) must carry `min-w-0` so a wide child cannot force the column wider than its track. This is the single most important fix — without `min-w-0`, intra-block scrolling never engages because the container itself expands.
2. **Tables & code blocks scroll within their own region:** apply `overflow-x-auto` (with `max-w-full`) to the table and `<pre>` blocks so a wide table/code line scrolls horizontally inside its own box, preserving column alignment, instead of widening the bubble. Implement by targeting the rendered descendants from the message wrapper (e.g. scoped utility classes / `[&_table]:` / `[&_pre]:` arbitrary variants, or a thin wrapper) — chosen so it does **not** require editing the shared renderer.
3. **Long words / URLs wrap:** `break-words` / `overflow-wrap: anywhere` (the wrapper already has `break-words`; ensure it actually applies to inline code and long links).
4. **Images width-capped:** `max-w-full h-auto` so a wide image scales down to the bubble width.

The human `user` side already renders verbatim with `whitespace-pre-wrap break-words` and is not markdown — leave it as-is (it is not the overflow source).

### Behavior summary (from elaboration)

| Block kind | Behavior |
|---|---|
| Table | horizontal scroll within its own region (layout preserved) |
| Code block | horizontal scroll within its own region |
| Long word / URL | wrap |
| Wide image | scale down to container width (`max-w-full`) |
| Bubble / container | width fixed — never blown out |

### Scope guard

Default is **scoped** to the daemon transcript message — smallest blast radius, no risk to Ideas / Comments / Documents which share `MarkdownContent`. Promote to the shared `MarkdownContent` / `streamdown-plugins` layer **only** if the fix is naturally global (e.g. a Streamdown control/class that belongs there) **and** a regression check on Ideas / Comments / Document detail pages confirms no visual change. Absent that confirmation, keep it scoped.

## Verification

Playwright e2e at a mobile viewport (per the idea's acceptance):
- Open the daemon conversation modal, drill into a conversation. Assert: dialog is fullscreen (no rounded card / margins), the reply input is at the bottom edge, the transcript fills the middle and scrolls internally.
- Render a conversation message containing a markdown **table** (and other wide blocks). Assert: no horizontal overflow of the document/container (`document.scrollWidth <= clientWidth` / the transcript track is not widened); the table scrolls within its own region.
- Desktop viewport regression: the floating card + two-pane layout and behavior are unchanged.

## Risks & Mitigations

- **Risk:** `min-w-0` / overflow utilities placed too high leak into desktop two-pane and shift its layout. **Mitigation:** scope to the message/transcript subtree; verify desktop two-pane visually unchanged.
- **Risk:** `dvh` support on older mobile browsers. **Mitigation:** `dvh` is broadly supported on current iOS/Android Safari/Chrome; the layout degrades gracefully to `100vh`-equivalent. No JS fallback needed.
- **Risk:** Targeting rendered markdown descendants with arbitrary variants is brittle if Streamdown's DOM changes. **Mitigation:** keep selectors to standard semantic tags (`table`, `pre`, `img`) which Streamdown emits stably; the change is additive CSS and fails safe (no constraint) rather than crashing.
