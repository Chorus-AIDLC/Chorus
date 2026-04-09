"use client";

import { useState, useEffect, useCallback, useRef } from "react";

/**
 * Manages browser URL for side-panel navigation using History API.
 *
 * Uses query params (?panel={id}&tab={tab}) instead of pathname segments
 * because Next.js App Router intercepts pathname changes via pushState/replaceState
 * and triggers soft navigation, which remounts components and resets state.
 * Query param changes do NOT trigger soft navigation.
 *
 * - openPanel(id, tab?): replaceState with ?panel={id}&tab={tab}
 * - closePanel(): replaceState removing panel & tab params
 * - popstate: syncs React state from query params
 * - Preserves other query params (filters, etc.)
 */
export function usePanelUrl(basePath: string, initialSelectedId?: string | null) {
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId ?? null);
  const [selectedTab, setSelectedTab] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("tab");
  });

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
      const newUrl = buildUrl(id, tab);
      window.history.replaceState(null, "", newUrl);
      setSelectedId(id);
      setSelectedTab(tab ?? null);
    },
    [buildUrl]
  );

  const closePanel = useCallback(() => {
    const newUrl = buildUrl(null);
    window.history.replaceState(null, "", newUrl);
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
      const params = new URLSearchParams(window.location.search);
      const id = params.get("panel");
      if (id) {
        setSelectedId(id);
        setSelectedTab(params.get("tab"));
      } else {
        setSelectedId(null);
        setSelectedTab(null);
      }
    }

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  return { selectedId, selectedTab, openPanel, closePanel, switchTab };
}
