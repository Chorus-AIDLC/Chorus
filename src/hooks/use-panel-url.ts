"use client";

import { useState, useEffect, useCallback, useRef } from "react";

/**
 * Manages browser URL for side-panel navigation using History API.
 *
 * - openPanel(id, tab?): pushState on first open, replaceState when switching items
 * - closePanel(): pushState back to base URL
 * - switchTab(tab): replaceState updating only the tab query param (no history entry)
 * - popstate: syncs React state from pathname + query params
 * - Preserves non-tab query params (filters, etc.)
 */
export function usePanelUrl(basePath: string, initialSelectedId?: string | null) {
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId ?? null);
  const [selectedTab, setSelectedTab] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("tab");
  });
  const isPanelOpenRef = useRef(!!initialSelectedId);

  /** Build URL preserving existing query params, optionally setting/removing tab */
  const buildUrl = useCallback(
    (id: string | null, tab?: string | null) => {
      const params = new URLSearchParams(window.location.search);
      if (tab) {
        params.set("tab", tab);
      } else {
        params.delete("tab");
      }
      const search = params.toString();
      const path = id ? `${basePath}/${id}` : basePath;
      return search ? `${path}?${search}` : path;
    },
    [basePath]
  );

  const openPanel = useCallback(
    (id: string, tab?: string) => {
      const newUrl = buildUrl(id, tab);

      if (isPanelOpenRef.current) {
        window.history.replaceState(null, "", newUrl);
      } else {
        window.history.pushState(null, "", newUrl);
      }

      isPanelOpenRef.current = true;
      setSelectedId(id);
      setSelectedTab(tab ?? null);
    },
    [buildUrl]
  );

  const closePanel = useCallback(() => {
    const newUrl = buildUrl(null);
    window.history.pushState(null, "", newUrl);
    isPanelOpenRef.current = false;
    setSelectedId(null);
    setSelectedTab(null);
  }, [buildUrl]);

  const switchTab = useCallback(
    (tab: string) => {
      if (!selectedId) return;
      const newUrl = buildUrl(selectedId, tab);
      window.history.replaceState(null, "", newUrl);
      setSelectedTab(tab);
    },
    [buildUrl, selectedId]
  );

  // Listen for popstate (browser back/forward)
  useEffect(() => {
    function handlePopState() {
      const pathname = window.location.pathname;
      const params = new URLSearchParams(window.location.search);

      // Check if pathname matches basePath/{id}
      if (pathname.startsWith(basePath + "/")) {
        const id = pathname.slice(basePath.length + 1);
        if (id && !id.includes("/")) {
          isPanelOpenRef.current = true;
          setSelectedId(id);
          setSelectedTab(params.get("tab"));
          return;
        }
      }
      // No ID in URL — panel closed
      isPanelOpenRef.current = false;
      setSelectedId(null);
      setSelectedTab(null);
    }

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [basePath]);

  return { selectedId, selectedTab, openPanel, closePanel, switchTab };
}
