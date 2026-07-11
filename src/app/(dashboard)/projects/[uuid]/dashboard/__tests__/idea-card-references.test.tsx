// @vitest-environment jsdom
//
// Component tests for the idea-tracker row's read-only references panel
// (Thread B). Guards the two behaviors the service tests can't reach:
//
//  1. Collapsed shows ONLY the count badge, and the panel is HIDDEN entirely
//     when referenceCount is 0 (owner: the count lives on the outer row).
//  2. Expanding the badge lazy-fetches via listReferencesAction("idea", uuid)
//     and renders the references READ-ONLY (title link + notes, no add/edit/
//     delete affordances).

import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { IdeaCard, type IdeaCardItem } from "../idea-card";

// The read-only panel calls this server action on first expand.
const listReferencesAction = vi.fn();
vi.mock("@/app/(dashboard)/projects/[uuid]/references-actions", () => ({
  listReferencesAction: (...args: unknown[]) => listReferencesAction(...args),
}));

// next-intl → resolve against the real en.json so key names are validated.
vi.mock("next-intl", async () => {
  const en = (await import("../../../../../../../messages/en.json")).default as Record<
    string,
    unknown
  >;
  function resolveKey(ns: string, key: string, values?: Record<string, unknown>): string {
    const path = ns ? `${ns}.${key}`.split(".") : key.split(".");
    let node: unknown = en;
    for (const p of path) {
      if (node && typeof node === "object" && p in (node as Record<string, unknown>)) {
        node = (node as Record<string, unknown>)[p];
      } else {
        return `${ns ? ns + "." : ""}${key}`;
      }
    }
    if (typeof node !== "string") return `${ns ? ns + "." : ""}${key}`;
    if (!values) return node;
    // Minimal ICU support: handle {name, plural, one {..#..} other {..#..}}
    // then simple {name} interpolation, enough to assert the count label.
    let out = node.replace(
      /\{(\w+),\s*plural,\s*one\s*\{([^}]*)\}\s*other\s*\{([^}]*)\}\}/g,
      (_m, name: string, one: string, other: string) => {
        const n = Number(values[name]);
        const chosen = n === 1 ? one : other;
        return chosen.replace(/#/g, String(n));
      },
    );
    out = out.replace(/\{(\w+)\}/g, (_m, name: string) =>
      name in values ? String(values[name]) : _m,
    );
    return out;
  }
  return {
    useTranslations:
      (ns?: string) =>
      (key: string, values?: Record<string, unknown>) =>
        resolveKey(ns ?? "", key, values),
  };
});

function idea(over: Partial<IdeaCardItem> = {}): IdeaCardItem {
  return {
    uuid: "idea-1",
    title: "Ground the plan in evidence",
    status: "todo",
    derivedStatus: "todo",
    badgeHint: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    parentUuid: null,
    childCount: 0,
    isContainer: false,
    referenceCount: 0,
    ...over,
  };
}

beforeEach(() => {
  listReferencesAction.mockReset();
});

describe("IdeaCard references panel — collapsed count", () => {
  it("renders NO references badge when referenceCount is 0", () => {
    render(<IdeaCard idea={idea({ referenceCount: 0 })} />);
    // The link-count badge carries the countLabel aria-label; none should exist.
    expect(screen.queryByLabelText(/reference/i)).toBeNull();
  });

  it("renders NO references badge when referenceCount is absent", () => {
    const it0 = idea();
    delete (it0 as { referenceCount?: number }).referenceCount;
    render(<IdeaCard idea={it0} />);
    expect(screen.queryByLabelText(/reference/i)).toBeNull();
  });

  it("shows a count-only badge when referenceCount > 0 (no fetch until expand)", () => {
    render(<IdeaCard idea={idea({ referenceCount: 3 })} />);
    const trigger = screen.getByLabelText("3 references");
    expect(trigger).toBeTruthy();
    expect(trigger.textContent).toContain("3");
    // Lazy: nothing fetched while collapsed.
    expect(listReferencesAction).not.toHaveBeenCalled();
  });
});

describe("IdeaCard references panel — expand lazy-fetches read-only", () => {
  it("fetches on expand and renders references read-only (title link + notes)", async () => {
    listReferencesAction.mockResolvedValue({
      success: true,
      references: [
        {
          uuid: "ref-1",
          targetType: "idea",
          targetUuid: "idea-1",
          type: "docs",
          url: "https://example.com/spec",
          title: "The spec",
          notes: "Why it matters",
          createdBy: null,
          createdAt: "2026-07-01T00:00:00.000Z",
          updatedAt: "2026-07-01T00:00:00.000Z",
        },
      ],
    });

    render(<IdeaCard idea={idea({ referenceCount: 1 })} />);
    fireEvent.click(screen.getByLabelText("1 reference"));

    await waitFor(() => {
      expect(listReferencesAction).toHaveBeenCalledWith("idea", "idea-1");
    });

    // Title renders as an external link to the ref url.
    const link = await screen.findByRole("link", { name: /The spec/ });
    expect(link.getAttribute("href")).toBe("https://example.com/spec");
    expect(link.getAttribute("target")).toBe("_blank");
    // Notes render.
    expect(screen.getByText("Why it matters")).toBeTruthy();

    // READ-ONLY: no edit / delete / add affordances in the tracker panel.
    expect(screen.queryByLabelText(/edit reference/i)).toBeNull();
    expect(screen.queryByLabelText(/delete reference/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /add reference/i })).toBeNull();
  });

  it("fetches only once across repeated toggles", async () => {
    listReferencesAction.mockResolvedValue({ success: true, references: [] });

    render(<IdeaCard idea={idea({ referenceCount: 2 })} />);
    const trigger = screen.getByLabelText("2 references");

    fireEvent.click(trigger); // open → fetch
    await waitFor(() => expect(listReferencesAction).toHaveBeenCalledTimes(1));
    fireEvent.click(trigger); // close
    fireEvent.click(trigger); // open again → no refetch
    await waitFor(() => expect(listReferencesAction).toHaveBeenCalledTimes(1));
  });
});
