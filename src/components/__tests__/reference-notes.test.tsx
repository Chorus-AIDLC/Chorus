// @vitest-environment jsdom
//
// UI tests for the shared ReferenceNotes renderer (clamp-reference-notes).
// Covers:
//  - collapsed default clamps to 2 lines (line-clamp-2 class present),
//  - empty / null / whitespace notes render nothing and expose no control,
//  - click toggles expanded (clamp removed) and collapses back,
//  - the collapsed state wires a tooltip trigger (full text reachable on hover).

import React from "react";
import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

// The shared Tooltip is a shadcn (Radix) primitive whose Popper uses
// ResizeObserver + pointer-capture — absent from jsdom. Stub them so mounting
// the collapsed (tooltip-wrapped) state doesn't throw.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
if (typeof Element !== "undefined" && !Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
}

// Resolve real i18n strings from en.json, mirroring the yolo-button test setup.
vi.mock("next-intl", async () => {
  const en = (await import("../../../messages/en.json")).default as Record<string, unknown>;
  return {
    useTranslations: (ns?: string) => (key: string) => {
      const full = ns ? `${ns}.${key}` : key;
      let node: unknown = en;
      for (const p of full.split(".")) {
        node =
          node && typeof node === "object" && p in (node as Record<string, unknown>)
            ? (node as Record<string, unknown>)[p]
            : undefined;
      }
      return typeof node === "string" ? node : full;
    },
  };
});

import { ReferenceNotes } from "@/components/reference-notes";

beforeEach(() => {
  cleanup();
});

describe("ReferenceNotes", () => {
  it("clamps to 2 lines when collapsed (default)", () => {
    render(<ReferenceNotes notes="A fairly long note that would wrap over many lines in the card." />);
    const btn = screen.getByRole("button");
    expect(btn.className).toContain("line-clamp-2");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
  });

  it("collapsed variant does NOT carry `block` (it would override line-clamp's display)", () => {
    // Regression guard: `line-clamp-2` needs `display:-webkit-box`; Tailwind
    // emits `.block` after `.line-clamp-2`, so a co-present `block` wins the
    // cascade and the height clamp silently stops working (only the tooltip
    // would remain). jsdom applies no CSS, so we assert the class list instead:
    // collapsed must have line-clamp-2 and must NOT have a `block` token.
    render(<ReferenceNotes notes="Long note text that must actually clamp in height." />);
    const btn = screen.getByRole("button");
    const tokens = btn.className.split(/\s+/);
    expect(tokens).toContain("line-clamp-2");
    expect(tokens).not.toContain("block");
  });

  it("renders nothing for null / empty / whitespace notes", () => {
    const { container: c1 } = render(<ReferenceNotes notes={null} />);
    expect(c1.querySelector("button")).toBeNull();
    cleanup();
    const { container: c2 } = render(<ReferenceNotes notes="" />);
    expect(c2.querySelector("button")).toBeNull();
    cleanup();
    const { container: c3 } = render(<ReferenceNotes notes="   " />);
    expect(c3.querySelector("button")).toBeNull();
  });

  it("click expands (removes clamp, uses block) and clicking again collapses", () => {
    render(<ReferenceNotes notes="Some note text." />);
    const btn = screen.getByRole("button");
    // collapsed → clamped, no block
    expect(btn.className.split(/\s+/)).toContain("line-clamp-2");
    expect(btn.className.split(/\s+/)).not.toContain("block");

    fireEvent.click(btn);
    const expanded = screen.getByRole("button");
    // expanded → no clamp; `block` is safe here (nothing to clamp) and lets the
    // full text fill the width.
    expect(expanded.className).not.toContain("line-clamp-2");
    expect(expanded.className.split(/\s+/)).toContain("block");
    expect(expanded.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(expanded);
    const recollapsed = screen.getByRole("button");
    expect(recollapsed.className.split(/\s+/)).toContain("line-clamp-2");
    expect(recollapsed.className.split(/\s+/)).not.toContain("block");
    expect(recollapsed.getAttribute("aria-expanded")).toBe("false");
  });

  it("wires a tooltip trigger while collapsed (full text reachable on hover)", () => {
    render(<ReferenceNotes notes="Full note body." />);
    const btn = screen.getByRole("button");
    // Radix TooltipTrigger tags the trigger element with this data-slot.
    expect(btn.getAttribute("data-slot")).toBe("tooltip-trigger");
    // The visible text is present in the DOM (clamp is display-only).
    expect(btn.textContent).toContain("Full note body.");
  });
});
