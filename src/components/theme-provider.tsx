"use client";

// src/components/theme-provider.tsx
// App-wide theme provider (light / dark / system) backed by next-themes.
//
// Mounted once at the root layout so every route — dashboard, admin, login,
// onboarding, static — is themed from a single point. next-themes toggles the
// `.dark` class on <html> (matching the `@custom-variant dark` in globals.css
// and the existing useDarkClass reader in markdown-content.tsx) and injects a
// pre-hydration inline script so the correct theme paints on the first frame
// (no FOUC). The tri-state (light | dark | system) and the localStorage key
// mirror the LocaleProvider's `chorus-*` persistence convention.

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ComponentProps } from "react";

export function ThemeProvider({
  children,
  ...props
}: ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      storageKey="chorus-theme"
      disableTransitionOnChange
      {...props}
    >
      {children}
    </NextThemesProvider>
  );
}
