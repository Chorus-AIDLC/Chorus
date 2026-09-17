## Context

`AgentConnectionsModal` is a controlled Radix dialog whose open state lives in `AgentPresenceProvider`. Below the Tailwind `sm` breakpoint it currently stretches `DialogContent` to `100dvh`; at `sm` and above it is a centered, height-capped modal. The Idea Tracker Actions menu already establishes the product's mobile bottom-sheet language through the shared `Sheet` primitive: bottom entry/exit motion, backdrop, rounded top corners, a drag-handle affordance, and safe-area-aware spacing.

The hosted `DaemonChat` has its own bounded flex and scroll chain. That content and its `< lg` list-to-detail drill-down must continue to receive a definite height so the transcript scrolls internally and the reply composer stays reachable.

## Goals / Non-Goals

**Goals:**

- Use the current `< sm` breakpoint to render Agent Daemon conversations in a near-full-height bottom sheet.
- Reuse the existing Sheet primitive, visual treatment, overlay behavior, and motion.
- Support outside-click, Escape, close-button, and top-handle drag dismissal.
- Isolate drag recognition to the handle so transcript/list scrolling is never interpreted as sheet dragging.
- Preserve the existing desktop dialog and all conversation behavior.

**Non-Goals:**

- Changing the `DaemonChat` information architecture, transcript behavior, composer, or `< lg` drill-down.
- Introducing snap points, resizing, body-wide swipe gestures, or a new drawer dependency.
- Changing the Tracker Actions sheet or other dialogs/sheets.

## Decisions

### Choose the responsive primitive before mounting content

`AgentConnectionsModal` will use a hydration-safe `matchMedia("(max-width: 639px)")` subscription to choose one controlled surface:

- mobile: `Sheet` + `SheetContent side="bottom"`;
- `sm` and wider: the existing `Dialog` + `DialogContent`.

Both branches use the provider's existing `modalOpen` / `setModalOpen`, render the same hidden localized title/description, and host one `DaemonChat`. Selecting one branch avoids mounting two open focus traps or two chat trees.

The breakpoint exactly matches the current fullscreen behavior and the Tracker Actions sheet. The usual entry points open the surface after hydration, so the server's desktop fallback cannot expose duplicate interactive content.

### Reuse the shared Sheet shell with a conversation-specific height

The mobile content will reuse `SheetContent side="bottom"` and the Tracker sheet's `rounded-t-2xl`, handle, backdrop, and safe-area treatment. Its height will be `calc(100dvh - 1rem)`, establishing a 16 CSS-pixel top gap while retaining a bounded height for the chat flex chain. The content remains padding-free except for safe-area handling because `DaemonChat` owns its own spacing.

Desktop retains the current centered `92vh` dialog classes without visual or behavioral changes.

### Recognize dragging only on the top handle

A small pointer-drag controller will be attached to the visual handle region, not to `SheetContent` or `DaemonChat`. It will:

1. capture the initiating primary pointer;
2. clamp movement to downward translation;
3. close after a 96 CSS-pixel vertical threshold;
4. animate back to rest when released early or cancelled;
5. clear transient inline styles after the gesture.

The handle uses `touch-action: none`; the body keeps its normal touch scrolling and overscroll behavior. Escape, backdrop click, and the Sheet close button remain available for keyboard and non-drag users. Reduced-motion preferences suppress the snap-back transition.

The 16px gap is large enough to expose a reliable backdrop target without materially reducing the chat workspace. The 96px threshold requires an intentional pull while remaining reachable on short phone viewports. Both values are named constants in the component and are asserted by focused tests.

### Keep accessibility semantics in each responsive branch

Both the Sheet and Dialog branches retain a localized title and description through their matching Radix primitives. The visible `DaemonChat` heading remains unchanged. The default close control, Escape behavior, focus trap, and focus restoration continue to come from Radix.

### Verify both themes in the acceptance gate

Browser acceptance will cover both light and dark appearances, using semantic theme tokens already supplied by `Sheet`; no new hardcoded color is introduced.

## Risks / Trade-offs

- **Hydration switches from the desktop fallback to the mobile branch.** → Use `useSyncExternalStore` with a server-safe snapshot and rely on post-hydration controlled opens; add branch-selection tests.
- **A drag could fight transcript scrolling.** → Bind pointer handlers and `touch-action: none` only to the top handle; never observe body gestures.
- **The near-full-height sheet could break the reply composer's height chain.** → Keep `h-full min-h-0` wrappers and verify the mobile transcript/composer path.
- **Inline drag transforms could leak into the next open.** → Centralize style cleanup on close, cancel, unmount, and completed snap-back.

## Migration Plan

No data migration is required. The change is a frontend-only responsive replacement. Rollback consists of restoring the mobile classes on the existing Dialog branch and removing the Sheet branch and drag controller.

After all Chorus task and aggregate code-review gates pass, the verified branch will be pushed as a PR targeting `develop`. The PR will merge only after required CI is green. The merged `develop` revision will then be deployed through the repository's established production deployment path and smoke-verified in production. The Idea owner explicitly authorized PR creation, merge, and production deployment in the Idea discussion.

## Open Questions

None. The elaboration fixes the breakpoint, top-gap behavior, dismissal gestures, and component reuse.
