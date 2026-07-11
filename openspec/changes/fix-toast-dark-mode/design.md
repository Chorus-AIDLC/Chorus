# Technical Design: Fix notification toast dark mode

## Overview

Make `sonner` notification toasts adapt to the active theme. The change is small and entirely
frontend, concentrated in the toast wrapper `src/components/ui/sonner.tsx` with a reconciliation
pass over the toast block in `src/app/globals.css`. No behavior, position, duration, or call-site
change.

The design has two coupled parts, both required:

1. **Wire the library's own theming API** (`theme` prop → next-themes `resolvedTheme`).
2. **Lock the toast palette to Chorus tokens via inline CSS variables**, because sonner's
   per-theme defaults (`#fff` for light, `#000` for dark) outrank our stylesheet override.

## Root cause (verified against source + installed package)

- `src/components/ui/sonner.tsx` currently:
  ```tsx
  const Toaster = ({ ...props }: ToasterProps) =>
    <Sonner className="toaster group" {...props} />
  ```
  It passes **no** `theme` and **no** inline styling. It does not import `next-themes`.
- Mount point `src/app/(dashboard)/layout.tsx` passes only `position` and `closeButton` — no
  `theme`, `toastOptions`, `richColors`, or `invert`.
- `sonner@2.0.7` default prop is `theme = 'light'` (`node_modules/sonner/dist/index.mjs`), so
  the toaster root gets `data-sonner-theme='light'`.
- Sonner's runtime stylesheet defines, at specificity **(0,2,0)**:
  - `[data-sonner-toaster][data-sonner-theme='light'] { --normal-bg:#fff; --normal-text:var(--gray12); --normal-border:var(--gray4); … }`
  - `[data-sonner-toaster][data-sonner-theme='dark']  { --normal-bg:#000; --normal-text:var(--gray1); --normal-border:hsl(0 0% 20%); … }`
- Chorus override `src/app/globals.css:196` is only **(0,1,0)**:
  ```css
  [data-sonner-toaster] { --normal-bg: var(--color-card); --normal-text: var(--color-foreground); --normal-border: var(--color-border); }
  ```
  (0,1,0) < (0,2,0) → sonner wins → background never leaves `#fff` in dark mode. Title/description
  use `!important` (`globals.css:207/212`) so they *do* flip → light bg + light text = unreadable.

## Why the `theme` prop alone is insufficient

Passing `theme='dark'` flips sonner to its dark defaults, but those set `--normal-bg:#000` at the
same (0,2,0) specificity — still beating our (0,1,0) override, and cold pure black instead of the
warm `--color-card` (`.dark` `#29231f`) used everywhere else in dark mode. So we additionally pin
the palette with **inline CSS variables** on the Toaster element. Inline `style` has the highest
specificity of all and wins over any selector, so `--normal-bg` etc. resolve to Chorus tokens in
both themes. This mirrors the stock shadcn `sonner.tsx`, which sets `--normal-bg`/`--normal-text`/
`--normal-border` via the `style` prop.

## Implementation

### `src/components/ui/sonner.tsx`

- Add `"use client"` is already implied (it uses hooks after this change); the file already has
  `"use client"`. Import `useTheme` from `next-themes`.
- Read `const { resolvedTheme } = useTheme()`. Pass `theme={(resolvedTheme === "dark" ? "dark" : "light")}`
  — coerce to the two concrete values; never pass `"system"`.
- Set the token-locked inline variables via the `style` prop (sonner forwards unknown style vars to
  the toaster root), e.g.:
  ```tsx
  style={{
    "--normal-bg": "var(--color-card)",
    "--normal-text": "var(--color-foreground)",
    "--normal-border": "var(--color-border)",
    // button colors kept on-brand in both themes
    "--normal-button-bg": "hsl(var(--primary))",           // verify exact var name sonner reads
    "--normal-button-text": "hsl(var(--primary-foreground))",
  } as React.CSSProperties}
  ```
  > **Hallucination-aware:** the exact sonner CSS-variable names for the action/close buttons must
  > be verified against the installed `sonner@2.0.7` stylesheet (`node_modules/sonner/dist/styles.css`)
  > at implementation time rather than assumed — sonner has renamed these between minor versions.
  > The title/description/close-button rules currently in `globals.css` (which already use
  > `var(--color-*)` with `!important`) can remain as the source of truth for those parts if the
  > inline-var route does not cover them cleanly.

### `src/app/globals.css` (lines ~195–224)

- Remove the now-superseded `[data-sonner-toaster] { --normal-bg/…-text/…-border }` block — it
  loses on specificity and is dead once the inline vars are in place; leaving it invites confusion.
- Replace the fixed light shadow `box-shadow: 0 4px 12px rgba(0,0,0,0.08) !important;` with a
  dark-aware value: keep the current shadow in light, and use a stronger/darker shadow (or a subtle
  light ring) under `.dark` so the toast still reads as elevated. Because `[data-sonner-toast]` is a
  library selector, scope the dark variant with the app's `.dark` root class
  (`.dark [data-sonner-toast] { box-shadow: … }`), which is available since next-themes sets `.dark`
  on `<html>`.
- Keep the title / description / close-button / action-button rules that already reference
  `var(--color-*)` — they are correct and (with `!important`) unaffected by sonner's per-theme
  defaults.

## Risks & Mitigations

- **Sonner CSS-var names drift between versions.** Mitigation: verify names against the installed
  `styles.css` before finalizing; fall back to the existing `!important` `globals.css` rules for any
  sub-part not cleanly covered by inline vars. Both routes are token-driven, so either is correct.
- **`useTheme()` returns `undefined` on first render (pre-hydration).** Mitigation: coercing
  `resolvedTheme === "dark" ? "dark" : "light"` defaults to light before hydration, matching the
  no-flash contract already in `theme-mode`; the toaster is client-only and mounts post-hydration,
  and toasts are user-triggered, so a first-frame default is not user-visible.
- **Regressing light mode.** Mitigation: light values are unchanged (`--color-card` = `#fff` in
  `:root`); verify pixel-equality of a light-mode toast before/after.

## Verification

- Drive the running app, trigger a toast in each theme, and read back pixels
  (`getComputedStyle` / canvas `getImageData` on the toast element) — confirm dark toast uses the
  warm card background (not `#fff`, not `#000`) and that title/description text contrast is legible.
  Screenshots alone are insufficient (they miss low-contrast text), per CLAUDE.md theme rules.
- Confirm light mode is visually unchanged.
- Type-check (`npx tsc --noEmit`) and lint pass.
