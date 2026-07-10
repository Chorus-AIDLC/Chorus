# Proposal: Dark Mode (light / dark / system theme)

## Why

Chorus ships only a single warm light theme. The design system already defines a `.dark`
CSS-variable block and a `@custom-variant dark` in `src/app/globals.css`, but **nothing ever
applies the `.dark` class to `<html>`** — there is no theme provider, no toggle, no
persistence, and no first-paint (FOUC) guard. So the dark tokens have never actually rendered.
Users working at night or on OLED screens have no way to reduce glare, and "does Chorus support
dark mode?" is a recurring ask. This change makes theme a first-class, user-controllable choice.

## What Changes

- **Three theme modes: `light` / `dark` / `system`.** `system` follows the OS
  `prefers-color-scheme` media query and updates live when the OS preference flips.
- **Default = `system`** for new users / first visit (no stored preference).
- **Per-device persistence via `localStorage`** (key `chorus-theme`). No account-level sync, no
  DB schema change, no new user-preference field — account sync is explicitly a future idea.
- **A `ThemeProvider`** (backed by `next-themes`, a pure-JS dependency — no native bindings, so
  it satisfies the cross-platform npm-publish constraint) mounted in the root layout. It owns the
  `light|dark|system` tri-state and toggles the `.dark` class on `<html>`.
- **FOUC guard**: `<html>` gets `suppressHydrationWarning`, and `next-themes` injects its
  pre-hydration inline script so the correct theme paints on the very first frame with no flash.
- **A theme-mode toggle control at the bottom of the dashboard sidebar** (a shadcn dropdown /
  segmented control), fully i18n'd in `en` + `zh`.
- **Completed dark palette**: the `.dark` block in `globals.css` is filled out so it reaches
  full parity with `:root` — every token that exists in `:root` (including the `--sidebar-*` and
  `--chart-*` groups, which are currently missing from `.dark`) gets a dark value. Per the
  elaboration decision, this **reuses / completes the existing generic (shadcn) dark palette**;
  a fully brand-tuned terracotta dark theme is deferred to a follow-up idea.
- **Coverage = all pages**: dashboard, admin panel, login, onboarding, and skill/static pages
  must all render correctly in dark mode. Hardcoded light-only colors (`bg-white`,
  `text-gray-900`, etc.) found on those surfaces are migrated to semantic tokens or given
  `dark:` variants so nothing stays stuck light.

**Non-breaking**: light remains a first-class mode; users who never touch the toggle and whose
OS is light see exactly today's appearance.

## Capabilities

### New Capabilities

- `theme-mode`: The user-facing theme system — the set of selectable modes, the default,
  how the selection persists, how it is applied to the document without a flash, where the
  toggle lives, and the requirement that all page surfaces render correctly in dark mode.

### Modified Capabilities

<!-- none — no existing capability's requirements change -->

## Impact

- **Dependencies**: add `next-themes` (pure JS/TS, no native bindings — satisfies pitfall #9).
- **Frontend code**:
  - `src/app/layout.tsx` — add `suppressHydrationWarning` to `<html>`, wrap children in the new
    `ThemeProvider` (alongside the existing `LocaleProvider`).
  - New `src/components/theme-provider.tsx` (client `next-themes` wrapper) and
    `src/components/theme-toggle.tsx` (the tri-state sidebar control).
  - Dashboard sidebar component — mount `<ThemeToggle>` at the bottom.
  - `src/app/globals.css` — complete the `.dark` token set (sidebar/chart parity with `:root`).
  - Audit + fix hardcoded light-only colors on login / onboarding / static / any `dark:`-using
    components so "all pages" holds.
- **i18n**: new keys (e.g. `theme.light` / `theme.dark` / `theme.system` / `theme.toggleLabel`)
  added to **both** `messages/en.json` and `messages/zh.json`.
- **Docs / design**: `docs/design.pen` updated with the sidebar theme toggle and a dark-mode
  screen (Pencil MCP; GUI-blocked steps handed to a human if headless).
- **No backend / API / schema / permission / migration changes.** Persistence is client-side
  `localStorage` only.
- **Backward compat**: fully additive; light mode is unchanged for users who don't opt in.
