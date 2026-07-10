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
//
// `refresh` is special-cased: it is definitionally a SAME-URL operation (it
// re-fetches the current route), so it must never flash the bar — the feature
// spec requires "same-URL navigation MUST NOT show the bar". BProgress guards
// same-URL only for push/replace (its `createHandler`); back/forward/refresh go
// through `createNoHrefHandler`, which has NO same-URL guard and would start the
// bar unconditionally. Since ~50 call sites fire `router.refresh()` after
// mutations (task status change, edits, realtime refresh, …), that would flash
// the bar constantly on the current page. We therefore route `refresh` with
// `{ showProgress: false }` — BProgress honors that per-call and skips the bar
// entirely, while still performing the refresh. push/replace/back/forward keep
// driving the bar (back/forward ARE real cross-URL navigations).

import { useRouter as useBProgressRouter } from "@bprogress/next/app";
import { useMemo } from "react";

/** Show-delay (ms) before the bar appears — mirrors the ProgressProvider. */
const PROGRESS_DELAY_MS = 120;

/**
 * `useRouter` that drives the navigation progress bar for programmatic
 * navigations. Signature-compatible with `next/navigation`'s `useRouter`.
 * `refresh()` is suppressed from the bar (same-URL operation).
 */
export function useRouter() {
  const router = useBProgressRouter({ delay: PROGRESS_DELAY_MS });
  return useMemo(
    () => ({
      ...router,
      // refresh() is same-URL → never flash the bar (BProgress's refresh has no
      // same-URL guard; showProgress:false makes it skip the progress entirely).
      refresh: () => router.refresh({ showProgress: false }),
    }),
    [router],
  );
}
