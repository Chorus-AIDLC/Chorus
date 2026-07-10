## Context

Chorus's design system already declares class-based dark mode in `src/app/globals.css`:
`@custom-variant dark (&:is(.dark *))` (line 35) plus a `.dark { … }` token block
(lines 81-101). A `useDarkClass()` MutationObserver in `src/components/markdown-content.tsx`
(lines 29-41) already reads `document.documentElement.classList.contains("dark")`, so the app
*assumes* the `.dark`-on-`<html>` convention — but **nothing ever sets that class**. There is no
theme provider, no toggle, no persistence, and no FOUC guard. Result: dark tokens have never
rendered.

Two gaps beyond "wire up a toggle":
1. The `.dark` block is **incomplete** — it overrides the core tokens but omits every
   `--chart-1..5` and every `--sidebar-*` token that `:root` defines (globals.css lines 64-78).
   Components reading `--color-sidebar-*` / `--color-chart-*` (mapped in the `@theme inline`
   block, lines ~205-217) would fall back to the light `:root` values under `.dark`.
2. A few surfaces use **literal light-only hex** instead of semantic tokens and would stay light:
   - `src/app/page.tsx` lines 66-68 — the root loading screen: `bg-[#FAF8F4]`, `text-[#737373]`.
   - `src/app/(dashboard)/projects/[uuid]/dashboard/idea-card.tsx` lines ~88,93 — `text-[#B26B3D]`,
     `text-[#B4B2A9]`, `text-[#2C2C2A]`.
   Login (`src/app/login/**`) and onboarding (`src/app/onboarding/**`) pages already use semantic
   tokens (and `CopyKeyStep.tsx` already carries `dark:` variants), so they are dark-safe.

## Goals / Non-Goals

**Goals:**
- Three selectable modes — `light` / `dark` / `system` — with `system` following
  `prefers-color-scheme` and reacting live to OS changes.
- Default `system` when no stored preference exists.
- Per-device persistence in `localStorage` (key `chorus-theme`).
- No first-paint flash (FOUC) for either theme.
- A theme toggle at the bottom of the dashboard sidebar (and the admin sidebar footer),
  fully i18n'd (`en` + `zh`).
- Complete `.dark` token parity with `:root` (chart + sidebar groups).
- All page surfaces (dashboard, admin, login, onboarding, static/loading) render correctly in dark.

**Non-Goals:**
- Account-level / cross-device sync (no DB field, no API). Explicitly a future idea.
- A bespoke brand-tuned terracotta dark palette. Per elaboration, V1 **reuses/completes the
  existing generic (shadcn) dark palette**; brand tuning is deferred.
- Any backend, schema, migration, permission, or MCP-tool change.
- Per-route theme overrides or scheduled/auto dark (sunset) behavior.

## Decisions

### D1 — Use `next-themes` for the provider
`next-themes` is a small, pure-JS/TS package with **no native bindings**, satisfying cross-platform
pitfall #9 (linux/darwin/win, x64/arm64). It provides exactly the needed primitives: tri-state
(`light`/`dark`/`system`), `attribute="class"` (toggles `.dark` on `<html>`), `defaultTheme="system"`,
`enableSystem`, `storageKey`, live OS-change subscription, and a **pre-hydration inline script** that
sets the class before first paint — solving FOUC without hand-rolling a blocking script.

Wrapper: new `src/components/theme-provider.tsx` (`"use client"`) re-exporting `next-themes`'
`ThemeProvider` with our config baked in:
`attribute="class" defaultTheme="system" enableSystem storageKey="chorus-theme" disableTransitionOnChange`.
This mirrors the existing `LocaleProvider` pattern (`src/contexts/locale-context.tsx`) which already
uses a `chorus-*` localStorage key and mutates `document.documentElement`.

### D2 — Mount in the root layout with `suppressHydrationWarning`
In `src/app/layout.tsx`: add `suppressHydrationWarning` to `<html lang="en">` (required — the
pre-hydration script mutates the class, which would otherwise trip React's hydration diff), and wrap
`children` in `<ThemeProvider>` **outside** `<LocaleProvider>` so every route (dashboard, admin,
login, onboarding, static) is themed — this is how "all pages" coverage is achieved with a single
mount point. Root layout stays a Server Component; only the provider is a client component.

### D3 — Toggle placement: sidebar footer, dropdown control
New `src/components/theme-toggle.tsx` (`"use client"`) using shadcn `DropdownMenu` +
`DropdownMenuRadioGroup`/`DropdownMenuRadioItem` (present in `src/components/ui/dropdown-menu.tsx`)
with three items Light / Dark / System and Sun/Moon/Monitor `lucide-react` icons. It reads/writes
via `useTheme()` from `next-themes`.

- **Hydration-safe render**: `next-themes` requires a `mounted` gate (theme is unknown on the server).
  The component renders a stable placeholder icon until mounted, then the resolved-theme icon — this
  avoids a hydration mismatch on the trigger.
- **Dashboard**: mount `<ThemeToggle>` in the bottom-pinned footer of the inline `SidebarContent`
  in `src/app/(dashboard)/layout.tsx` (the `mt-auto … px-4 pb-4` block, ~lines 456-486), next to the
  existing `LogOut` ghost-icon `Button` so it matches the established affordance. It appears in both
  the desktop `<aside>` and the mobile `<Sheet>` because both render `SidebarContent`.
- **Admin**: mount in the admin sidebar footer in `src/app/admin/layout.tsx` (~lines 114-127).

### D4 — Complete the `.dark` palette (generic, not rebranded)
Add to the `.dark` block in `globals.css` a dark value for every `:root` token missing from it:
`--chart-1..5` and the full `--sidebar-*` group (`--sidebar`, `--sidebar-foreground`,
`--sidebar-primary`, `--sidebar-primary-foreground`, `--sidebar-accent`,
`--sidebar-accent-foreground`, `--sidebar-border`, `--sidebar-ring`). Values follow the standard
shadcn dark defaults (dark sidebar surface, muted foreground, terracotta `--primary` kept as the
accent for brand continuity). `--radius` is theme-invariant — not overridden. No `:root` value changes.

### D5 — Migrate the hardcoded light-only surfaces
- `src/app/page.tsx` loading screen → replace `bg-[#FAF8F4]`/`text-[#737373]` with
  `bg-background`/`text-muted-foreground` (the tokens whose light values equal those hexes, so light
  appearance is unchanged).
- `idea-card.tsx` literal hexes → map to the nearest semantic tokens (`text-primary` for the
  terracotta `#B26B3D`, `text-muted-foreground` / `text-foreground` for the greys) so the card reads
  correctly in both themes. Verify light appearance is visually equivalent.
- Existing app-level `dark:` usages (`notification-popup.tsx`, `onboarding/CopyKeyStep.tsx`,
  `install-guide/AgentInstallGuide.tsx`) already pair light+dark and need no change; spot-check them.

### D6 — i18n keys
Add to **both** `messages/en.json` and `messages/zh.json` a small block, e.g.:
`theme.toggleLabel` ("Theme" / "主题"), `theme.light` ("Light" / "浅色"),
`theme.dark` ("Dark" / "深色"), `theme.system` ("System" / "跟随系统").
Toggle labels and `aria-label`/tooltip route through `useTranslations()`.

## Risks / Trade-offs

- **Hydration mismatch** if `suppressHydrationWarning` or the `mounted` gate is forgotten →
  console errors / flicker. Mitigated by D2 + D3 (both are standard `next-themes` requirements).
- **Generic palette is off-brand.** Accepted per elaboration (Q5=a); brand tuning is a follow-up.
  Keeping terracotta `--primary` in dark preserves some identity.
- **Third-party components not on tokens** (e.g. the pixel-canvas widget, charts) may look off in
  dark until their `--chart-*`/custom colors are validated — completing D4 covers the token path;
  any widget with its own hardcoded colors is caught in the "all pages" coverage audit.
- **`next-themes` + App Router**: it is React-19 / Next-15 compatible and widely used with the
  App Router; the only integration cost is the `suppressHydrationWarning` + `mounted` gate above.
- **design.pen update** (per project convention) needs the Pencil MCP, which is GUI-blocked in a
  headless run; that AC is marked non-required and handed to a human, so it does not block the
  automated pipeline.
