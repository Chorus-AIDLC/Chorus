"use client";

// Pixel-activity bridge — a tiny shell-level open-state signal that lets the
// bottom-right daemon-presence entry (mounted at the shell, on the company-wide
// AgentPresenceProvider) open the project-scoped pixel-canvas "activity" view
// (mounted inside the per-<main> RealtimeProvider, which the entry lives above).
//
// WHY a separate context: the pixel view reads the CURRENT project's active
// sessions via `getProjectActiveSessionsAction(projectUuid)` + `useRealtimeEvent`,
// so it can only render inside the project branch of the dashboard layout (there
// is no project context / RealtimeProvider on /projects, /project-groups,
// /settings). The entry, by contrast, is company-wide. This context carries only
// the open-state + an `available` flag across that provider boundary — the pixel
// DATA stays on RealtimeProvider.
//
// `available` is registered by the project-branch pixel widget on mount and
// cleared on unmount. So the entry's "View activity" affordance is present iff a
// project context is currently mounted — ABSENT (not merely disabled) on global
// pages, per the pixel-view availability contract in the Tech Design.

import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export interface PixelActivityValue {
  // Is the pixel-canvas view open?
  open: boolean;
  setOpen: (open: boolean) => void;
  // Is a project-scoped pixel view currently mountable? True only while the
  // project-branch pixel widget is mounted (i.e. a project context is active).
  available: boolean;
  setAvailable: (available: boolean) => void;
}

const PixelActivityContext = createContext<PixelActivityValue | null>(null);

export function PixelActivityProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [available, setAvailable] = useState(false);
  // `setOpen`/`setAvailable` are stable useState setters, so the value only
  // changes when `open`/`available` change.
  const value = useMemo<PixelActivityValue>(
    () => ({ open, setOpen, available, setAvailable }),
    [open, available],
  );
  return (
    <PixelActivityContext.Provider value={value}>
      {children}
    </PixelActivityContext.Provider>
  );
}

/**
 * Read the pixel-activity bridge. Throws outside the provider — the pixel widget
 * is always mounted under it, so a missing provider is a wiring bug.
 */
export function usePixelActivity(): PixelActivityValue {
  const ctx = useContext(PixelActivityContext);
  if (!ctx) {
    throw new Error(
      "usePixelActivity must be used within a PixelActivityProvider",
    );
  }
  return ctx;
}

/**
 * Non-throwing variant for components that can render outside the provider (e.g.
 * the daemon-presence entry in isolated unit tests). An absent provider reads as
 * "no pixel activity view available" (null) rather than a wiring bug — the entry
 * then simply omits the "View activity" affordance.
 */
export function usePixelActivityOptional(): PixelActivityValue | null {
  return useContext(PixelActivityContext);
}
