"use client";

// src/components/progress-provider.tsx
// Client wrapper around BProgress's App-Router ProgressProvider.
//
// @bprogress/next/app does NOT ship a "use client" directive, so importing its
// ProgressProvider directly into the Server Component root layout would pull
// React context (createContext) into the server bundle and break the build
// (Failed to collect page data for /_not-found: createContext is not a
// function). Establishing the client boundary here — mirroring the existing
// ThemeProvider wrapper for next-themes — keeps the root layout a Server
// Component while the bar runs client-side.
//
// The bar renders the top-of-page navigation loading indicator. `color` uses
// the `--primary` design token so the bar background (--bprogress-color) and
// the tail glow (--bprogress-box-shadow), both derived from this value in the
// injected CSS, adapt to light/dark with no per-theme JS. `delay` suppresses
// the bar on navigations faster than the threshold (no flash); `disableSameURL`
// keeps same-URL clicks from flashing it; `shallowRouting` ignores shallow
// query (e.g. ?panel=) changes where the pathname is unchanged.

import { ProgressProvider as BProgressProvider } from "@bprogress/next/app";

export function ProgressProvider({ children }: { children: React.ReactNode }) {
  return (
    <BProgressProvider
      height="3px"
      color="hsl(var(--primary))"
      delay={120}
      options={{ showSpinner: false }}
      disableSameURL
      shallowRouting
    >
      {children}
    </BProgressProvider>
  );
}
