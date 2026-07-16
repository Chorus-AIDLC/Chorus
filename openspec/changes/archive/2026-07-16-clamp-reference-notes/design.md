# Design: Clamp reference notes to 2 lines with hover tooltip + tap-to-expand

## Context

The `notes` field of a `ReferenceArtifact` (`ReferenceArtifactResponse.notes: string | null`) renders today as the exact same JSX in two components:

- `src/components/references-section.tsx:236-240` (editable; idea/proposal/task detail panels)
- `src/app/(dashboard)/projects/[uuid]/dashboard/idea-references-panel.tsx:73-77` (read-only dashboard idea-card)

Both:

```tsx
{ref.notes && (
  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
    {ref.notes}
  </p>
)}
```

No clamp, no truncation, no tooltip. A `line-clamp-2` precedent already exists (`proposals/[proposalUuid]/proposal-editor.tsx`), and a shadcn/Radix `Tooltip` primitive is available at `src/components/ui/tooltip.tsx` (there is **no** app-global `TooltipProvider` — each consumer wraps its own).

MCP side: the `notes` describe string appears 4 times (all `z.string()`, no length rule):
- `src/mcp/tools/pm.ts:48` — shared `referenceInlineItemSchema` (reused by `chorus_pm_create_idea`, `chorus_pm_create_proposal`)
- `src/mcp/tools/pm.ts:400` — `chorus_add_reference`
- `src/mcp/tools/pm.ts:442` — `chorus_update_reference`
- `src/mcp/tools/public.ts:44` — shared `referenceInlineItemSchema` used by `chorus_create_tasks`

## Decisions

### D1 — One shared `ReferenceNotes` component, not two edits

Extract `src/components/reference-notes.tsx` (client component) and use it from both surfaces, rather than duplicating clamp+tooltip+toggle logic. Single source of truth, single render-test target. Signature: `<ReferenceNotes notes={ref.notes} />` — it internally guards on empty/null and renders nothing when there is no text (preserving the current `{ref.notes && …}` behavior at each call site).

### D2 — Clamp + reveal interaction model (elaboration q1=all surfaces, q4=tap-to-toggle)

- **Default:** the `<p>` keeps its current classes plus `line-clamp-2` when collapsed. The clamp itself is display-only; the DOM still contains the full text.
- **Desktop hover:** wrap the collapsed `<p>` in a `Tooltip`/`TooltipTrigger`; `TooltipContent` shows the full `notes`. The component renders its own `TooltipProvider` (no global one exists). Constrain tooltip width (`max-w-xs`/`max-w-sm`) and allow wrapping so long notes stay readable.
- **Tap/click:** clicking the notes toggles an `expanded` state; expanded removes the clamp (full text inline) and the tooltip is suppressed while expanded (nothing hidden to preview). This is the touch fallback — tap works without hover. Clicking again collapses.
- The trigger is a `<button type="button">` styled to look like the current paragraph (`text-left`, inherits the muted/xs styling), so it is keyboard-focusable and accessible; it carries an `aria-expanded` and an aria-label from i18n (e.g. `references.toggleNotes`).
- **Tooltip-only-when-clamped nicety:** if the text is short enough not to overflow 2 lines, the tooltip/expand still function harmlessly; we do not add JS overflow-measurement in v1 (keeps it dependency-free and deterministic for tests). Interaction is always available but is a no-op visual when text already fits.

### D3 — Docs nudge only, no cap (elaboration q2=docs-only, q3=~200 chars)

Reword the 4 `notes` describe strings to a single consistent sentence that:
- states it is an optional short summary,
- asks for **one concise sentence (~200 characters, ≤2 lines)**,
- keeps the existing "stored verbatim; no fetch" fact where present.

Example new wording (create/add path):
`"Optional one-line summary of why this reference is relevant — keep it to a single concise sentence (~200 chars, ≤2 lines); the UI clamps to 2 lines. Stored verbatim; no fetch."`

Update path keeps its clear-semantics note:
`"New notes — one concise sentence (~200 chars, ≤2 lines; the UI clamps to 2 lines). null clears; omit to leave unchanged."`

No `.max()` is added — `notes` stays `z.string()`; over-long text is accepted and simply clamped in the UI.

### D4 — Theme + i18n

- The component uses only semantic tokens already in the `<p>` (`text-muted-foreground`) and the shared `TooltipContent` (which is `bg-foreground text-background`), so both light and dark themes are correct with no new color.
- Any new label goes into all four locale files (`en`, `zh`, `ja`, `ko`), per project i18n rule.

## Risks / trade-offs

- **jsdom + Radix Tooltip:** Radix popper needs `ResizeObserver` / pointer-capture stubs in jsdom (existing pattern in `yolo-button.test.tsx`). The render test stubs those and asserts on the trigger + expand toggle rather than the portalled hover content (hover-open is timing/portal heavy); tooltip *wiring* is asserted structurally.
- **No overflow measurement:** interaction is always present even for short notes. Accepted for v1 simplicity; the visual result for short notes is identical (nothing to reveal).
- **design.pen:** this is a user-facing UI change, so `docs/design.pen` should reflect the clamped-notes state. `.pen` is encrypted and only editable via Pencil MCP tools; in a headless run this is captured as an acceptance criterion and handed to a human if it cannot be completed automatically.

## Migration / rollout

Pure display + docs change; no data migration. Ships behind no flag. Verified by: `pnpm test` (new component test + describe-nudge test), `npx tsc --noEmit`, `pnpm lint`, and an e2e/browser check of a reference with long notes in both themes.
