# Tasks: Add Dark Mode

## 1. Theme provider + FOUC-safe root wiring
- [ ] 1.1 Add `next-themes` dependency (pure JS, no native bindings)
- [ ] 1.2 Create `src/components/theme-provider.tsx` (`attribute="class"`, `defaultTheme="system"`, `enableSystem`, `storageKey="chorus-theme"`, `disableTransitionOnChange`)
- [ ] 1.3 In `src/app/layout.tsx`: add `suppressHydrationWarning` to `<html>`, wrap children in `<ThemeProvider>` outside `<LocaleProvider>`
- [ ] 1.4 Verify no FOUC and no hydration warning for a dark-resolved user

## 2. Complete the `.dark` palette
- [ ] 2.1 In `src/app/globals.css`, add dark values for all `--chart-1..5` and all `--sidebar-*` tokens (parity with `:root`)
- [ ] 2.2 Confirm no `:root` values changed; light appearance unchanged

## 3. Theme toggle control + sidebar mounts + i18n
- [ ] 3.1 Create `src/components/theme-toggle.tsx` (shadcn DropdownMenu + RadioGroup, Sun/Moon/Monitor icons, `mounted` gate, `useTheme()`)
- [ ] 3.2 Mount `<ThemeToggle>` in the dashboard sidebar footer in `src/app/(dashboard)/layout.tsx` (desktop + mobile via `SidebarContent`)
- [ ] 3.3 Mount `<ThemeToggle>` in the admin sidebar footer in `src/app/admin/layout.tsx`
- [ ] 3.4 Add `theme.*` keys to `messages/en.json` and `messages/zh.json`; route labels/aria via `useTranslations()`

## 4. All-pages coverage: migrate hardcoded light-only surfaces
- [ ] 4.1 `src/app/page.tsx` loading screen → `bg-background` / `text-muted-foreground`
- [ ] 4.2 `idea-card.tsx` literal hexes → semantic tokens; verify light equivalence
- [ ] 4.3 Spot-check existing `dark:` users (notification-popup, CopyKeyStep, AgentInstallGuide) and login/onboarding under dark
- [ ] 4.4 Manual e2e: verify dashboard, admin, login, onboarding render correctly in light + dark

## 5. Docs / design
- [ ] 5.1 Update `docs/design.pen` with the sidebar theme toggle + a dark-mode screen (Pencil MCP; hand GUI-blocked steps to a human if headless)
