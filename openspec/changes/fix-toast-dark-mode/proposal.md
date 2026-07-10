# Fix notification toasts not adapting to dark mode

## Why

The 0.14.0 dark-mode rollout (`theme-mode` capability) migrated app surfaces to semantic
tokens, but the notification **toast** — the transient pill that pops in the corner on
save/copy/error (`sonner`, mounted in `src/app/(dashboard)/layout.tsx`) — still renders
light-on-light in dark mode: a white/near-white background with pale text, low contrast and
visually jarring against the dark UI.

The root cause is a CSS-specificity loss against third-party unlayered CSS, verified against
source and the installed `sonner@2.0.7` stylesheet:

1. **No `theme` prop is passed.** `src/components/ui/sonner.tsx` renders `<Sonner …>` with no
   `theme`, so sonner falls back to its default `theme='light'` and stamps
   `data-sonner-theme='light'` on the toaster root (`node_modules/sonner/dist/index.mjs`,
   default `theme = 'light'`).
2. **Sonner's own theme rule outranks our override.** Sonner ships
   `[data-sonner-toaster][data-sonner-theme='light'] { --normal-bg: #fff; … }` — a selector
   with specificity **(0,2,0)**. The Chorus override in `src/app/globals.css:196`
   (`[data-sonner-toaster] { --normal-bg: var(--color-card); … }`) is only **(0,1,0)**, so it
   loses: `--normal-bg` stays `#fff` and the toast background never flips.
3. **The text colors *do* flip** (they use `!important` at `globals.css:207/212`), which is
   why the symptom is specifically "light background + light text = unreadable" rather than a
   fully-light toast.

This is exactly the CLAUDE.md "Dark / Light Theme Rules" third case — third-party unlayered
CSS wins over `className`/CSS overrides, so the fix must go through the library's own theming
API (wire `theme` to next-themes), not fight it with more CSS.

A subtlety that shapes the fix: even after we pass a `theme`, sonner's **dark** default sets
`--normal-bg: #000` (pure black) at the same (0,2,0) specificity, which would give a
cold pure-black toast instead of the warm `--color-card` surface the rest of the dark UI uses,
and would still outrank our globals.css override. So the theme prop alone is necessary but not
sufficient — the toast surface/text/border/button colors must additionally be **locked to
Chorus design tokens via inline CSS variables** on the Toaster (inline `style` beats any
selector), matching the stock shadcn sonner wrapper's approach.

## What Changes

- **Wire the Toaster to the active theme.** `src/components/ui/sonner.tsx` reads
  `useTheme()` from `next-themes` and passes `theme={resolvedTheme}` — the **resolved**
  `light`/`dark`, never `"system"` (passing `"system"` makes sonner read the OS media query,
  which is wrong for the class-driven next-themes setup — the same trap documented for
  ReactFlow's `colorMode` in CLAUDE.md).
- **Lock toast colors to Chorus tokens via inline CSS variables** on the Toaster
  (`--normal-bg`, `--normal-text`, `--normal-border`, and the button colors) so the warm
  card surface wins in both themes regardless of sonner's `#fff`/`#000` defaults. This
  supersedes the specificity-losing `[data-sonner-toaster]` block in `globals.css`.
- **Fix the dark-invisible shadow.** The toast shadow `rgba(0,0,0,0.08)`
  (`globals.css:203`) is near-invisible on a dark background; give it a dark-aware value so
  the toast still reads as an elevated surface in dark mode.
- **Keep the neutral appearance** — no semantic (success=green / error=red / warning=amber /
  info=blue) coloring is introduced (confirmed with the requester in elaboration). Toasts stay
  the current neutral card style; only theme adaptation is fixed.
- **Verify both themes by reading back pixels**, not screenshots alone — confirm the toast
  background and title/description text meet a reasonable contrast in light AND dark.

## Capabilities

- **theme-mode** — adds one normative requirement that notification toasts adapt to the
  active theme (background/text/border/buttons/shadow follow the resolved light/dark theme via
  the library's theming API + token lock), closing the gap left by the "all application
  surfaces render correctly in dark mode" requirement for this third-party-styled surface.

## Impact

- Affected code (frontend only):
  - `src/components/ui/sonner.tsx` — consume `useTheme()`, pass `theme={resolvedTheme}`, and
    set the token-locked inline CSS variables (`--normal-bg`, `--normal-text`,
    `--normal-border`, button colors). This is the primary change.
  - `src/app/globals.css` — reconcile the `[data-sonner-*]` block: keep only what the inline
    vars don't cover (e.g. the dark-aware shadow, close-button styling) and drop the
    now-superseded, specificity-losing background override to avoid dead/conflicting rules.
- No change to any `toast(...)` call site (~30 call sites stay untouched — none carry styling).
- Other transient overlays (`tooltip`, `popover`, `dropdown-menu`, `dialog`, `sheet`,
  `alert-dialog`) were swept during elaboration and already use semantic tokens with correct
  dark values — **out of scope, no change needed**.
- No database schema change. No new dependency. No i18n strings (no new user-facing text).
- Out of scope: semantic per-type toast colors; restyling non-toast overlays; any change to
  toast position / duration / behavior.
