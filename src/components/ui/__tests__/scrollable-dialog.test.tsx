// @vitest-environment jsdom
//
// ScrollableDialog — the reusable mobile-safe dialog skeleton. This test pins the
// LAYOUT CONTRACT that prevents the "modal taller than the viewport, footer
// unreachable" bug (fix-assign-modals-mobile-overflow):
//
//   - the DialogContent caps its height with a DYNAMIC small-viewport unit
//     (max-h-[85svh]) — not a static `vh` — and is a flex column with
//     overflow-hidden, so it can never grow taller than the visible
//     (soft-keyboard-shortened) viewport;
//   - the header and footer are shrink-0 siblings OUTSIDE the scroll region, so
//     they stay visible and tappable however tall the body;
//   - the body is the ONE overflow-y-auto scroll region with `min-h-0 flex-1`, so
//     long content scrolls inside the dialog rather than pushing the footer off;
//   - the controlled open contract forwards onOpenChange(false) on close paths.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";

import {
  ScrollableDialog,
  ScrollableDialogTitle,
} from "@/components/ui/scrollable-dialog";

// The Radix DialogContent node carries data-slot="dialog-content".
function dialogContent(): HTMLElement {
  const el = document.querySelector('[data-slot="dialog-content"]');
  if (!el) throw new Error("dialog-content not rendered");
  return el as HTMLElement;
}

function renderDialog(
  props: Partial<React.ComponentProps<typeof ScrollableDialog>> = {},
) {
  const onOpenChange = props.onOpenChange ?? vi.fn();
  render(
    <ScrollableDialog
      open
      onOpenChange={onOpenChange}
      header={<ScrollableDialogTitle>Assign</ScrollableDialogTitle>}
      footer={
        <>
          <button type="button">Cancel</button>
          <button type="button">Assign</button>
        </>
      }
      {...props}
    >
      <div data-testid="body-content">
        {Array.from({ length: 20 }, (_, i) => (
          <p key={i}>row {i}</p>
        ))}
      </div>
    </ScrollableDialog>,
  );
  return { onOpenChange };
}

describe("ScrollableDialog — mobile-safe layout", () => {
  afterEach(() => cleanup());

  it("caps height with a dynamic small-viewport unit and lays out as a flex column with overflow-hidden", () => {
    renderDialog();
    const content = dialogContent();
    // Dynamic viewport unit (svh/dvh) — NOT a static `vh` (the bug's root cause).
    expect(content.className).toMatch(/max-h-\[\d+(svh|dvh)\]/);
    expect(content.className).not.toMatch(/max-h-\[\d+vh\]/);
    expect(content.className).toContain("flex");
    expect(content.className).toContain("flex-col");
    expect(content.className).toContain("overflow-hidden");
  });

  it("puts the body in the only overflow-y-auto scroll region, with header and footer outside it", () => {
    renderDialog();
    const content = dialogContent();

    // Exactly one scroll region directly under the content.
    const scrollRegions = [...content.querySelectorAll(":scope > .overflow-y-auto")];
    expect(scrollRegions).toHaveLength(1);
    const scroll = scrollRegions[0] as HTMLElement;
    // min-h-0 + flex-1 is what lets the flex child shrink and actually scroll.
    expect(scroll.className).toContain("min-h-0");
    expect(scroll.className).toContain("flex-1");

    // The body content lives INSIDE the scroll region.
    expect(within(scroll).getByTestId("body-content")).toBeTruthy();

    // The footer (with Cancel + Assign) is a SIBLING of the scroll region, never
    // inside it — so it can't be scrolled away — and is shrink-0.
    const footer = content.querySelector('[data-slot="dialog-footer"]') as HTMLElement;
    expect(footer).toBeTruthy();
    expect(scroll.contains(footer)).toBe(false);
    expect(footer.className).toContain("shrink-0");
    const assign = within(footer).getByRole("button", { name: "Assign" });
    expect(scroll.contains(assign)).toBe(false);

    // The header is also a shrink-0 sibling outside the scroll region.
    const header = content.querySelector('[data-slot="dialog-header"]') as HTMLElement;
    expect(header.className).toContain("shrink-0");
    expect(scroll.contains(header)).toBe(false);
  });

  it("lifts BOTH the content and the overlay above a z-50 side panel by default", () => {
    renderDialog();
    const content = dialogContent();
    const overlay = document.querySelector('[data-slot="dialog-overlay"]') as HTMLElement;
    expect(overlay).toBeTruthy();

    const zOf = (el: HTMLElement) => {
      const m = el.className.match(/(?:^|\s)z-\[(\d+)\]/);
      return m ? Number(m[1]) : NaN;
    };
    expect(zOf(content)).toBeGreaterThan(50);
    expect(zOf(overlay)).toBeGreaterThan(50);
  });

  it("forwards onOpenChange(false) when the close button is clicked", () => {
    const { onOpenChange } = renderDialog();
    // The shadcn corner close button has the sr-only label "Close".
    const close = screen.getByRole("button", { name: "Close" });
    fireEvent.click(close);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("renders an accessible dialog with the provided title", () => {
    renderDialog();
    // Radix wires the title as the dialog's accessible name.
    expect(screen.getByRole("dialog", { name: "Assign" })).toBeTruthy();
  });
});
