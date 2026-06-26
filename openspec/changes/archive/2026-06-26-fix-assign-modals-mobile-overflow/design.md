# Design: mobile-safe Assign Idea / Assign Task modals via a shared scrollable-dialog skeleton

## Context

Two hand-written fixed-position modals overflow short mobile viewports and cannot
scroll, hiding their footer Assign / Cancel buttons (see `proposal.md` for the
root cause). The resolved elaboration chose: keep a centered card (not
full-screen), cap height with dynamic viewport units + internal scroll, extract a
reusable skeleton, and build it on shadcn `Dialog`.

Both modals are structurally near-identical today:

```
<>
  <div className="fixed inset-0 z-50 bg-black/40" onClick={onClose} />   {/* backdrop */}
  <div className="fixed left-1/2 top-1/2 z-50 w-[400px] -translate-x-1/2 -translate-y-1/2 rounded-2xl ...">
    <div className="... px-6 py-5 border-b">{/* Header: title + X close */}</div>
    <div className="p-6 space-y-4">{/* Body: idea/task info, radio options, agent select, InstancePicker, release */}</div>
    <div className="... px-6 py-6 border-t">{/* Footer: Cancel + Assign */}</div>
  </div>
</>
```

The body grows with the shared `InstancePicker`
(`src/components/agent-presence/instance-picker.tsx`), one row per online
`(host, cwd)` instance, no height ceiling. There is the reference pattern in
`src/components/agent-presence/connections-modal.tsx` (`h-dvh max-h-dvh` full-screen
— rejected by q1=A) and `src/components/assign-modal.tsx`
(`max-h-[80vh] overflow-y-auto` — close, but a single scroll container, not a
pinned header/footer).

## Goals / Non-Goals

**Goals**
- One reusable skeleton: pinned header + scrolling body + pinned footer, height
  capped in dynamic viewport units, narrow-viewport width fallback, built on
  shadcn `Dialog`.
- Adopt it in both assign modals with **zero** business-logic change and **zero**
  call-site change.

**Non-Goals**
- No full-screen mobile layout (rejected: q1=A).
- No change to assignment / instance-pin / wake logic.
- No migration of other modals (the mention picker `d3f31086` is separate); the
  skeleton is merely *available* for future reuse.

## The skeleton component

New component family under `src/components/ui/scrollable-dialog.tsx`, composed from
the existing `@/components/ui/dialog` primitives (Radix-backed). Proposed shape
(final names/props settle in implementation; behavior is normative):

```tsx
// Wraps DialogContent with a flex column whose body is the only scroll region.
<ScrollableDialog open={open} onOpenChange={onOpenChange}>
  <ScrollableDialogHeader>{title}</ScrollableDialogHeader>   {/* pinned, shrink-0 */}
  <ScrollableDialogBody>{children}</ScrollableDialogBody>     {/* min-h-0 flex-1 overflow-y-auto */}
  <ScrollableDialogFooter>{actions}</ScrollableDialogFooter>  {/* pinned, shrink-0 */}
</ScrollableDialog>
```

Layout contract on the `DialogContent`:

- `flex max-h-[85svh] flex-col overflow-hidden` — the content is a flex column
  capped at a fraction of the **small** viewport height (`svh`, which excludes the
  mobile browser UI / accounts for the soft keyboard) so it never exceeds the
  viewport. `overflow-hidden` confines scrolling to the body.
  - Rationale for `svh` over `dvh`/`vh`: `vh` ignores mobile browser chrome and is
    the original bug; `svh` is the conservative (smallest) stable height so the
    dialog fits even with the URL bar expanded and is not clipped when the soft
    keyboard is up. (`dvh` is acceptable but reflows as chrome shows/hides; `svh`
    is steadier for a capped centered card. Either dynamic unit satisfies the
    requirement; `svh` is the chosen default.)
- Header & footer: `shrink-0` so they never compress; the body is the only flexible
  row.
- Body: `min-h-0 flex-1 overflow-y-auto` — `min-h-0` is **required** so the flex
  child is allowed to shrink below its content size and actually scroll (a flex
  item defaults to `min-height:auto`, which would otherwise let it grow and re-push
  the footer off-screen — the exact bug).
- Width: rely on shadcn `DialogContent`'s base `w-full max-w-[calc(100%-2rem)]`
  plus a `sm:max-w-[400px]` to preserve the current desktop 400px width. This also
  fixes the secondary horizontal-overflow symptom (the old fixed `w-[400px]`).
- Centering, backdrop, Esc, focus-trap, aria, and the close button come from
  shadcn `DialogContent` for free; the bespoke backdrop `div` and `X` button are
  dropped.

The header/body/footer are simple slot wrappers (padding + borders matching the
current look: header `border-b`, footer `border-t`, both opaque so body content
scrolling under them is clipped by `overflow-hidden`).

## Open/close contract (critical)

The call sites mount conditionally and pass only `onClose` — there is no `open`
prop today:

```tsx
{showAssignModal && <AssignIdeaModal … onClose={() => setShowAssignModal(false)} />}
{task && showAssignModal && <AssignTaskModal … onClose={() => setShowAssignModal(false)} />}
```

(Call sites: `ideas/idea-detail-panel.tsx`, `dashboard/panels/idea-detail-panel.tsx`,
`dashboard/panels/basic-view.tsx`, `tasks/task-detail-panel.tsx`.)

A Radix `Dialog` is controlled by `open` / `onOpenChange`. To keep all call sites
untouched, each assign modal continues to own the `onClose` prop and internally
renders the skeleton as **always open**, translating a close intent back to
`onClose`:

```tsx
<ScrollableDialog open onOpenChange={(o) => { if (!o) onClose(); }}>
```

Because the parent only mounts the modal while `showAssignModal` is true,
`open` is effectively always `true` while mounted, and any close path (Esc, overlay
click, the close button, Cancel) funnels through `onOpenChange(false) → onClose()`,
which unmounts it. No exit-animation regression matters because the component
unmounts immediately on close, exactly as the hand-written version did.

## Migration mapping per modal

For each of `assign-idea-modal.tsx` and `assign-task-modal.tsx`, replace only the
outer JSX shell — keep all hooks, state, effects, `handleSubmit`, `canSubmit`,
`resolvePinLabel`, the `RadioGroup` options, the agent `Select`, the
`InstancePicker`, and the `error` block exactly as-is:

| Old | New |
|---|---|
| `<><div backdrop/><div fixed card>…</div></>` | `<ScrollableDialog open onOpenChange={…}>…</ScrollableDialog>` |
| Header `div` with `<h2>` + `<button><X/></button>` | `<ScrollableDialogHeader>` with the title (shadcn close button replaces the bespoke `X`) |
| Body `<div className="p-6 space-y-4">` | `<ScrollableDialogBody className="space-y-4">` (the wrapper owns padding) |
| Footer `<div … border-t>` Cancel/Assign | `<ScrollableDialogFooter>` Cancel/Assign (unchanged Buttons) |

The Cancel `Button` keeps calling `onClose`; the Assign `Button` keeps calling
`handleSubmit`. No prop signatures change.

## Risks & Mitigations

- **Risk:** moving to a portal-based Radix `Dialog` changes stacking / z-index vs
  the old `z-50` siblings. **Mitigation:** shadcn `DialogContent` already portals
  to `document.body` at `z-50` with an overlay; verify the modal still sits above
  the detail panels in the Playwright pass.
- **Risk:** the `min-h-0` flex pitfall — forgetting it silently reintroduces the
  exact "footer pushed off-screen" bug. **Mitigation:** it is encoded once in the
  skeleton (not per-modal) and covered by an explicit acceptance criterion +
  Playwright check at a short viewport with ≥3 instances.
- **Risk:** desktop visual drift (radius, width, padding). **Mitigation:** match
  `sm:max-w-[400px]` and the existing padding/border tokens; desktop is expected to
  look unchanged.
- **Risk:** focus-trap now active (was absent in the hand-written version) could
  change tab behavior. **Mitigation:** this is an accessibility *improvement* and
  the intended q3=B benefit; just confirm the agent `Select`/`InstancePicker`
  remain operable inside the trap.

## Verification

Per the idea's acceptance, reproduce and verify in a real mobile browser viewport
(Playwright), covering all three:

1. Standard mobile viewport (375×667): open Assign Idea and Assign Task, choose
   Assign to Agent, expand a multi-instance `InstancePicker`.
2. Soft-keyboard-shortened short viewport (≈360×420).
3. Longest body: ≥3 online instances + already-assigned (the Release option shows).

In all three: the title and the bottom Cancel / Assign buttons stay visible and
clickable, and the body scrolls to any row. Plus `pnpm lint`, `npx tsc --noEmit`,
and `pnpm test` for the new skeleton's unit tests.
