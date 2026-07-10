"use client";

// src/hooks/use-progress-router.ts
//
// Drop-in replacement for `useRouter` from `next/navigation` that also drives
// the top-of-page navigation loading bar (BProgress). The App Router exposes no
// public navigation-start event, so BProgress's `ProgressProvider` (mounted in
// the root layout) covers <Link>/anchor clicks and browser back/forward, but
// NOT programmatic navigations. This wrapper routes programmatic
// `router.push/replace/back/forward/refresh/prefetch` through BProgress so they
// surface the bar too — giving "all in-app navigations" coverage.
//
// The returned router has the SAME method surface as next/navigation's
// useRouter, so call sites need no change beyond this import path. Keep
// importing `usePathname` / `useSearchParams` / `useParams` from
// `next/navigation` directly — only `useRouter` moves here.
//
// `delay` is baked to match the ProgressProvider's show-delay so a fast
// programmatic navigation doesn't flash the bar either.

import { useRouter as useBProgressRouter } from "@bprogress/next/app";

/** Show-delay (ms) before the bar appears — mirrors the ProgressProvider. */
const PROGRESS_DELAY_MS = 120;

/**
 * `useRouter` that drives the navigation progress bar for programmatic
 * navigations. Signature-compatible with `next/navigation`'s `useRouter`.
 */
export function useRouter() {
  return useBProgressRouter({ delay: PROGRESS_DELAY_MS });
}
