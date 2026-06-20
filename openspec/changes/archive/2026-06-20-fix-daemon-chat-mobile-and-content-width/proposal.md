## Why

The chat-style daemon conversation modal ("View all" → `AgentConnectionsModal` → `DaemonChat` → `TranscriptView`) shipped in 子3 (`chat-style-daemon-ui`) has two display defects:

1. **Mobile is not a native chat screen.** The `DialogContent` is a centered floating card at every breakpoint (`h-[92vh] w-[min(96vw,1100px)]` + rounding + border), and the mobile drill-down body was a fixed `h-[70vh]` box — so on a phone the modal floats with margins and the reply input sits mid-screen with dead space below it instead of pinned to the bottom edge.
2. **Wide markdown blocks overflow horizontally.** Agent replies render Markdown through the shared `MarkdownContent` (Streamdown). A **table** (or other wide block — code block, long URL/word, wide image) has no width constraint, so it blows the bubble/container width out past the viewport, especially on a narrow phone.

The fix makes the modal read like a native chat surface on mobile (fullscreen, input pinned to bottom, transcript fills the middle and scrolls), and constrains wide markdown blocks to the available conversation width — without regressing the desktop floating card / two-pane layout.

## What Changes

- **Mobile fullscreen modal.** On `< sm` the `DialogContent` fills the viewport edge-to-edge (`h-dvh w-screen`, no rounding/border); the mobile drill-down body becomes a full-height flex column so the transcript `ScrollArea` fills the middle and the reply input lands at the very bottom of the viewport. The desktop (`sm+`) floating, height-capped card and the desktop (`lg+`) two-pane layout are unchanged. (Largely realized in the working tree already; this change finalizes and e2e-verifies it.)
- **Transcript content-width discipline.** Wide markdown blocks inside an agent transcript message are constrained to the bubble's available width: tables and code blocks scroll horizontally **within their own region** (layout preserved), long words/URLs wrap, images are width-capped — the message/container width never blows out. Scoped to the daemon transcript message renderer; the shared global Markdown renderer is left unchanged to avoid regressing Ideas / Comments / Documents.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `daemon-session-transcript-read`: add two requirements to the chat-style conversation surface — (a) the modal SHALL be a fullscreen, input-pinned-to-bottom layout on mobile while keeping the desktop floating card/two-pane, and (b) wide markdown blocks in a transcript message SHALL be constrained to the available content width (intra-block horizontal scroll / wrap) rather than overflowing the container.

## Impact

- **Code (UI only, no server / schema / API changes):**
  - `src/components/agent-presence/connections-modal.tsx` — `DialogContent` responsive sizing (mobile `h-dvh w-screen rounded-none border-0`; desktop card restored at `sm:`).
  - `src/components/agent-presence/chat/daemon-chat.tsx` — mobile drill-down container from fixed `h-[70vh]` to `flex h-full min-h-0 flex-1`.
  - `src/components/agent-presence/chat/message.tsx` (and/or a scoped wrapper around `MarkdownContent`) — width constraints on wide markdown blocks within a transcript message.
- **No** change to `MarkdownContent` / `streamdown-plugins` global behavior, so Ideas / Comments / Documents markdown rendering is untouched.
- **Verification:** Playwright at a mobile viewport — fullscreen modal, input pinned to bottom, transcript fills & scrolls; a transcript containing a markdown table (and other wide blocks) does not overflow horizontally; desktop layout/behavior does not regress.
