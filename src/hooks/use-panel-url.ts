"use client";

import { useCallback, useRef } from "react";
import { useSearchParams } from "next/navigation";

/**
 * Manages browser URL for side-panel navigation using History API.
 *
 * Uses query params (?panel={id}&tab={tab}) instead of pathname segments
 * because Next.js App Router intercepts pathname changes via pushState/replaceState
 * and triggers soft navigation, which remounts components and resets state.
 * Query param changes do NOT trigger soft navigation.
 *
 * The selected panel/tab is derived from `useSearchParams()` — the App Router's
 * reactive source of truth for the query string. It updates on every navigation
 * kind: soft navigation (router.push / <Link>), browser back/forward, and direct
 * load. This is what makes an external `?panel={id}` link (notifications, search,
 * toast, agent-presence) actually open/switch the panel: those use soft navigation,
 * which changes the URL WITHOUT firing `popstate`, so a popstate-only listener
 * never saw them.
 *
 * - openPanel(id, tab?): replaceState with ?panel={id}&tab={tab}
 * - closePanel(): replaceState removing panel & tab params
 * - switchTab(tab): replaceState updating only ?tab=
 * - Preserves other query params (filters, etc.)
 *
 * `initialSelectedId` is retained for API compatibility but is no longer the
 * source of truth — `useSearchParams()` supersedes it. It seeds ONLY the very
 * first render (server prerender, where `useSearchParams()` is empty), then is
 * dropped: after that, `useSearchParams()` is authoritative. The fallback must
 * not leak past first paint — otherwise closing a deep-linked panel (server
 * seeded `initialSelectedId` from `?panel=`) would resolve `null ?? seed` back
 * to the seed and re-stick the panel open, breaking the close button. A
 * `<Suspense>` boundary above this hook is required by Next.js so the rest of
 * the route can still be statically prerendered.
 *
 * Writes use `window.history.replaceState` (not router.replace): per the Next.js
 * App Router docs, this updates `useSearchParams()` reactively WITHOUT a soft
 * navigation / RSC round-trip, so the subtree is not remounted and transient
 * state (scroll, view mode) survives — preserving the query-param design above.
 */
export function usePanelUrl(basePath: string, initialSelectedId?: string | null) {
  const searchParams = useSearchParams();

  // The server-provided seed applies only to the first render frame (prerender,
  // where useSearchParams() is empty). Once the client has rendered once,
  // useSearchParams() is the sole source of truth — so we never fall back to the
  // seed again. Without this gate the fallback leaks into every render: after a
  // deep-linked `?panel=X` close, `get("panel")` is null and `null ?? "X"` would
  // re-open the panel.
  const hasRenderedRef = useRef(false);
  const useSeed = !hasRenderedRef.current;
  hasRenderedRef.current = true;

  // Derive selection straight from the URL (the tab has no SSR seed and simply
  // starts unselected).
  const selectedId = searchParams.get("panel") ?? (useSeed ? initialSelectedId ?? null : null);
  const selectedTab = searchParams.get("tab");

  /** Build URL with query params, preserving existing non-panel/tab params */
  const buildUrl = useCallback(
    (id: string | null, tab?: string | null) => {
      const params = new URLSearchParams(window.location.search);
      if (id) {
        params.set("panel", id);
      } else {
        params.delete("panel");
      }
      if (tab) {
        params.set("tab", tab);
      } else {
        params.delete("tab");
      }
      const search = params.toString();
      return search ? `${basePath}?${search}` : basePath;
    },
    [basePath]
  );

  const openPanel = useCallback(
    (id: string, tab?: string) => {
      window.history.replaceState(null, "", buildUrl(id, tab));
    },
    [buildUrl]
  );

  const closePanel = useCallback(() => {
    window.history.replaceState(null, "", buildUrl(null));
  }, [buildUrl]);

  const switchTab = useCallback(
    (tab: string) => {
      if (!selectedId) return;
      window.history.replaceState(null, "", buildUrl(selectedId, tab));
    },
    [buildUrl, selectedId]
  );

  return { selectedId, selectedTab, openPanel, closePanel, switchTab };
}
