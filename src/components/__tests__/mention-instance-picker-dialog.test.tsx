// @vitest-environment jsdom
//
// MentionInstancePickerDialog — the secondary cwd picker shown when an @-mentioned
// agent has 2+ ONLINE instances. This test pins the MOBILE-SAFE LAYOUT contract
// (fix-mention-cwd-picker-mobile-overflow):
//
//   - the DialogContent caps its height with a DYNAMIC small-viewport unit
//     (max-h-[85svh]) — not a static `vh` — and is a flex column, so it can never
//     grow taller than the visible (soft-keyboard-shortened) viewport;
//   - the header and footer (Cancel / Pin instance) are OUTSIDE the scroll region
//     (shrink-0 siblings) so they stay visible and tappable however tall the list;
//   - the InstancePicker instance list lives inside the ONE overflow-y-auto scroll
//     region, so a long list scrolls inside the dialog rather than pushing the Pin
//     button off-screen.
//
// It also re-pins the unchanged behavior that selecting a cwd row enables Pin.
//
// next-intl is mocked to resolve real en.json strings (same harness as the other
// agent-presence component tests); the subtitle's ICU plural is irrelevant here —
// we assert structure, not the subtitle text.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";

vi.mock("next-intl", async () => {
  const en = (await import("../../../messages/en.json")).default as Record<
    string,
    unknown
  >;
  function resolve(namespace: string, key: string): string {
    const fullKey = namespace ? `${namespace}.${key}` : key;
    let node: unknown = en;
    for (const p of fullKey.split(".")) {
      if (node && typeof node === "object" && p in (node as Record<string, unknown>)) {
        node = (node as Record<string, unknown>)[p];
      } else {
        return fullKey;
      }
    }
    return typeof node === "string" ? node : fullKey;
  }
  return {
    useTranslations:
      (namespace = "") =>
      (key: string, params?: Record<string, string | number>) => {
        let s = resolve(namespace, key);
        if (params) {
          for (const [k, v] of Object.entries(params)) {
            s = s.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
          }
        }
        return s;
      },
  };
});

import { MentionInstancePickerDialog } from "@/components/mention-editor";
import type { InstanceCandidate } from "@/components/agent-presence/instance-picker";

function makeInstances(n: number): InstanceCandidate[] {
  return Array.from({ length: n }, (_, i) => ({
    connectionUuid: `conn-${i}`,
    agentInstanceUuid: `inst-${i}`,
    host: "host-1",
    cwd: `/Users/dev/project-${i}`,
    effectiveStatus: "online" as const,
  }));
}

// The Radix DialogContent node carries data-slot="dialog-content".
function dialogContent(): HTMLElement {
  const el = document.querySelector('[data-slot="dialog-content"]');
  if (!el) throw new Error("dialog-content not rendered");
  return el as HTMLElement;
}

describe("MentionInstancePickerDialog — mobile-safe layout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => cleanup());

  it("caps height with a dynamic small-viewport unit and lays out as a flex column", () => {
    render(
      <MentionInstancePickerDialog
        open
        agentName="Test Agent"
        instances={makeInstances(6)}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const content = dialogContent();
    // Dynamic viewport unit (svh/dvh) — NOT a static `vh` (the bug's root cause).
    expect(content.className).toMatch(/max-h-\[\d+(svh|dvh)\]/);
    expect(content.className).not.toMatch(/max-h-\[\d+vh\]/);
    expect(content.className).toContain("flex");
    expect(content.className).toContain("flex-col");
  });

  it("lifts BOTH the content and the overlay above the side panel's z-50 (no paint-order tie)", () => {
    // The picker opens from inside the idea-detail side panel, which is `fixed
    // z-50`. The default Dialog overlay+content are also z-50, so the dialog only
    // sits above the panel by PAINT ORDER — a tie some mobile browsers resolve the
    // other way, leaving the panel's Overview/Elaboration/Activity tab bar painted
    // over the dialog (title occluded, Pin untappable). Both layers must carry an
    // explicit z-index strictly above 50.
    render(
      <MentionInstancePickerDialog
        open
        agentName="Test Agent"
        instances={makeInstances(6)}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const content = dialogContent();
    const overlay = document.querySelector('[data-slot="dialog-overlay"]') as HTMLElement;
    expect(overlay).toBeTruthy();

    const zOf = (el: HTMLElement) => {
      const m = el.className.match(/(?:^|\s)z-\[(\d+)\]/);
      return m ? Number(m[1]) : NaN;
    };
    const contentZ = zOf(content);
    const overlayZ = zOf(overlay);
    expect(contentZ).toBeGreaterThan(50);
    expect(overlayZ).toBeGreaterThan(50);
    // The content must not sit below its own backdrop.
    expect(contentZ).toBeGreaterThanOrEqual(overlayZ);
  });

  it("puts the instance list in the only overflow-y-auto scroll region, with header and footer outside it", () => {
    render(
      <MentionInstancePickerDialog
        open
        agentName="Test Agent"
        instances={makeInstances(6)}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const content = dialogContent();

    // Exactly one scroll region directly under the content.
    const scrollRegions = [...content.querySelectorAll(":scope > .overflow-y-auto")];
    expect(scrollRegions).toHaveLength(1);
    const scroll = scrollRegions[0] as HTMLElement;
    // min-h-0 + flex-1 is what lets the flex child shrink and actually scroll.
    expect(scroll.className).toContain("min-h-0");
    expect(scroll.className).toContain("flex-1");

    // The radiogroup (instance list) lives INSIDE the scroll region.
    const radiogroup = within(scroll).getByRole("radiogroup");
    expect(radiogroup).toBeTruthy();

    // The footer (with Cancel + Pin) is a SIBLING of the scroll region, never inside
    // it — so it can't be scrolled away.
    const footer = content.querySelector('[data-slot="dialog-footer"]') as HTMLElement;
    expect(footer).toBeTruthy();
    expect(scroll.contains(footer)).toBe(false);
    expect(footer.className).toContain("shrink-0");
    // The Pin (confirm) button is in the footer, outside the scroll region.
    const pin = within(footer).getByRole("button", { name: "Pin instance" });
    expect(scroll.contains(pin)).toBe(false);

    // The header is also a shrink-0 sibling outside the scroll region.
    const header = content.querySelector('[data-slot="dialog-header"]') as HTMLElement;
    expect(header.className).toContain("shrink-0");
    expect(scroll.contains(header)).toBe(false);
  });

  it("keeps the Pin button disabled until a cwd row is selected, then enables it", () => {
    render(
      <MentionInstancePickerDialog
        open
        agentName="Test Agent"
        instances={makeInstances(3)}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const pin = screen.getByRole("button", { name: "Pin instance" }) as HTMLButtonElement;
    expect(pin.disabled).toBe(true);

    // Select the second row (multi-instance: no auto-select).
    const radios = screen.getAllByRole("radio");
    fireEvent.click(radios[1]);
    expect(pin.disabled).toBe(false);
  });

  it("fires onConfirm with the chosen instance when Pin is clicked", () => {
    const onConfirm = vi.fn();
    const instances = makeInstances(3);
    render(
      <MentionInstancePickerDialog
        open
        agentName="Test Agent"
        instances={instances}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getAllByRole("radio")[2]);
    fireEvent.click(screen.getByRole("button", { name: "Pin instance" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ connectionUuid: instances[2].connectionUuid }),
    );
  });
});
