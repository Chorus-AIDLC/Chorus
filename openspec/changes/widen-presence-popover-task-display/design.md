# Design: Widen the presence popover & roomy task rows

## Overview

A small, contained frontend change to two existing presentational components. No
data-layer, API, or information-architecture changes. The guiding constraint is
**`ExecutionRow` is shared across three surfaces** (popover, "View all" modal, and the
modal-hosted connection view), so any layout change must be opt-in to avoid disturbing
the surfaces that already read well.

## Current state (verified)

- `src/components/agent-presence-pill.tsx`
  - `PopoverContent className="max-h-[60vh] w-[300px] overflow-y-auto p-3"` (line ~236).
  - Renders `<ExecutionRow exec={exec} nowMs={nowMs} />` for running and queued execs.
- `src/components/agent-presence/execution-row.tsx`
  - `ExecutionRow({ exec, nowMs })` renders a single flex `<li>` row:
    icon tile · `min-w-0 flex-1` body (type badge + truncated title link + optional
    root-idea session line) · trailing status block (`running` → elapsed `<span>` +
    `<InterruptButton>`; `interrupted` → badge + Resume/auto-recovers; `queued` →
    "waiting"). The trailing block is `shrink-0`, so at narrow widths the `flex-1` body
    loses width and the title truncates first.
- `ExecutionRow` consumers (verified via grep):
  - `agent-presence-pill.tsx` (popover) — 2 call sites (running, queued).
  - `agent-presence/connections-view.tsx` (modal body) — 3 call sites (running, queued,
    interrupted).

## Approach

### 1. Widen the popover

In `agent-presence-pill.tsx`, change the `PopoverContent` width:

```
w-[300px]  →  w-[min(92vw,400px)]
```

`max-h-[60vh] overflow-y-auto p-3` unchanged. The `min(92vw, …)` clamp keeps it inside
small viewports (the popover can open on the mobile drawer too). 400px is the owner's
chosen target (Round 2 / q3 = a).

### 2. Add an opt-in two-line layout variant to `ExecutionRow`

Add a `layout` prop, defaulting to today's behavior so the modal/connection-view call
sites are untouched:

```ts
export function ExecutionRow({
  exec,
  nowMs,
  layout = "inline", // "inline" (default, current single-line) | "stacked" (popover)
}: {
  exec: ExecutionView;
  nowMs: number;
  layout?: "inline" | "stacked";
})
```

- **`inline`** (default): byte-for-byte the current single-row markup. Modal and
  connection-view keep passing nothing → no visual change there.
- **`stacked`**: the title/body occupies the full row width on line 1 (title may relax
  the hard `truncate` — e.g. allow up to two lines via `line-clamp-2`, or keep a single
  line that now has ~2× the room); the status/controls block (elapsed + Interrupt, or
  the interrupted badge + Resume, or "waiting") drops to a second line beneath the body,
  left-aligned, no longer `shrink-0`-competing with the title.

Implementation note: factor the existing trailing status/controls JSX into a small
local sub-render (e.g. `renderTrailing(exec)`) so both layouts reuse identical control
logic (InterruptButton / ResumeButton / elapsed / waiting) — only the *position*
differs (`inline`: same flex row, `shrink-0` trailing; `stacked`: a second flex row
under the body). This avoids duplicating the running/interrupted/queued branching and
keeps the Interrupt/Resume behavior contract identical across layouts.

The popover (`agent-presence-pill.tsx`) passes `layout="stacked"` at both call sites.

### Why opt-in prop, not a new component or a CSS-only tweak

- A **new component** would duplicate the running/interrupted/queued + Interrupt/Resume
  logic — the exact "second drifting copy" the agent-presence module's `index.ts` doc
  comment warns against. One component, one behavior, two layouts.
- A **container-query / pure-CSS** approach (reflow purely on available width) is
  fragile here because the trailing block contains an AlertDialog trigger button with
  intrinsic width; an explicit layout prop is more predictable and testable.

## Module contracts

- `ExecutionRow`'s `layout` prop is **additive and optional**; omitting it preserves
  current rendering exactly. No consumer outside the popover changes.
- Interrupt/Resume behavior, deep-link `href`, root-idea session line, status icons, and
  the `motion-safe:` spin are **identical** across both layouts — only geometry changes.
- The popover continues to render only `running` + `queued` (interrupted stays
  modal-only); this change does not touch that filter.

## Risks & mitigations

- **Risk:** widening to 400px overlaps main content on small laptops. **Mitigation:**
  `min(92vw,400px)` clamps to viewport; the popover is anchored `side="top" align="start"`
  off the rail, so 400px sits over the sidebar/edge, not center content. Verify live at
  ~1280px and at mobile (390px) widths.
- **Risk:** a regression in the modal if the shared row changes. **Mitigation:** the
  `inline` default means modal call sites pass nothing and are unaffected; a unit test
  asserts the modal/default still renders single-line (trailing controls inline).
- **Risk:** `line-clamp-2` wrapping could make rows uneven. **Mitigation:** acceptable —
  readability beats strict row height; the popover already scrolls (`overflow-y-auto`).

## Test plan

- Update `src/components/__tests__/agent-presence-pill.test.tsx`: popover content width
  reflects the new class; running rows render the Interrupt control and elapsed in the
  stacked position; title is not hard-truncated in the popover.
- Update / add `src/components/agent-presence/__tests__` coverage for `ExecutionRow`:
  `layout="stacked"` places controls on a second line; default `inline` unchanged.
- Live verification (Playwright) against the running dev server: popover at desktop +
  mobile widths shows fuller task titles; modal unchanged; 0 new console errors.
