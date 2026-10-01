// @vitest-environment jsdom
// Lock indicator on sidebar quick-access rows (pinned + recent).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { QuickAccessProjectRef } from "@/contexts/project-quick-access-context";

const state = vi.hoisted(() => ({
  pinned: [] as QuickAccessProjectRef[],
  recent: [] as QuickAccessProjectRef[],
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock("@/contexts/project-quick-access-context", () => ({
  useProjectQuickAccess: () => ({
    pinned: state.pinned,
    recent: state.recent,
    pin: vi.fn(),
    unpin: vi.fn(),
    remove: vi.fn(),
  }),
}));

import { SidebarProjectQuickAccess } from "@/components/sidebar-project-quick-access";

const ref = (uuid: string, name: string, visibility?: string): QuickAccessProjectRef => ({
  uuid,
  name,
  visibility,
  groupUuid: null,
  groupName: null,
});

beforeEach(() => {
  state.pinned = [];
  state.recent = [];
});

describe("SidebarProjectQuickAccess lock indicator", () => {
  it("shows a lock on private pinned and recent rows, not on public ones", () => {
    state.pinned = [ref("p1", "PinnedPrivate", "private"), ref("p2", "PinnedPublic", "public")];
    state.recent = [ref("p3", "RecentPrivate", "private"), ref("p4", "RecentLegacy")];

    render(<SidebarProjectQuickAccess />);

    const locks = screen.getAllByTestId("project-lock-indicator");
    expect(locks).toHaveLength(2);
    const owners = locks.map((l) => l.parentElement?.textContent);
    expect(owners.some((t) => t?.includes("PinnedPrivate"))).toBe(true);
    expect(owners.some((t) => t?.includes("RecentPrivate"))).toBe(true);
    expect(owners.some((t) => t?.includes("PinnedPublic"))).toBe(false);
    expect(owners.some((t) => t?.includes("RecentLegacy"))).toBe(false);
  });

  it("shows no lock when all rows are public", () => {
    state.recent = [ref("p4", "OnlyPublic", "public")];
    render(<SidebarProjectQuickAccess />);
    expect(screen.getByText("OnlyPublic")).toBeTruthy();
    expect(screen.queryByTestId("project-lock-indicator")).toBeNull();
  });
});
