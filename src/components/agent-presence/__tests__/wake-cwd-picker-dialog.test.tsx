// @vitest-environment jsdom
//
// WakeCwdPickerDialog — the stage-advance / proposal-approval cwd picker shown on
// the `pick` outcome of the wake-target preview (pin-cwd-before-wake, task 1d).
// It reuses the mobile-safe shell (max-h-[85svh] flex column, z-[110] over the
// side panel, single overflow-y-auto scroll region) + the shared InstancePicker
// body, so this test pins the same layout contract as
// MentionInstancePickerDialog plus the confirm / cancel / Enter (IME-guarded)
// behavior specific to the wake-cwd copy.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";

vi.mock("next-intl", async () => {
  const en = (await import("../../../../messages/en.json")).default as Record<
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

import { WakeCwdPickerDialog } from "@/components/agent-presence/wake-cwd-picker-dialog";
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

function dialogContent(): HTMLElement {
  const el = document.querySelector('[data-slot="dialog-content"]');
  if (!el) throw new Error("dialog-content not rendered");
  return el as HTMLElement;
}

describe("WakeCwdPickerDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => cleanup());

  it("caps height with a dynamic viewport unit, lays out as a flex column, and clears the side panel z-index", () => {
    render(
      <WakeCwdPickerDialog
        open
        agentName="Test Agent"
        instances={makeInstances(2)}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const content = dialogContent();
    expect(content.className).toMatch(/max-h-\[\d+(svh|dvh)\]/);
    expect(content.className).not.toMatch(/max-h-\[\d+vh\]/);
    expect(content.className).toContain("flex");
    expect(content.className).toContain("flex-col");

    const overlay = document.querySelector('[data-slot="dialog-overlay"]') as HTMLElement;
    const zOf = (el: HTMLElement) => {
      const m = el.className.match(/(?:^|\s)z-\[(\d+)\]/);
      return m ? Number(m[1]) : NaN;
    };
    expect(zOf(content)).toBeGreaterThan(50);
    expect(zOf(overlay)).toBeGreaterThan(50);
  });

  it("puts the instance list in the only scroll region with header and footer outside it", () => {
    render(
      <WakeCwdPickerDialog
        open
        agentName="Test Agent"
        instances={makeInstances(4)}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const content = dialogContent();
    const scrollRegions = [...content.querySelectorAll(":scope > .overflow-y-auto")];
    expect(scrollRegions).toHaveLength(1);
    const scroll = scrollRegions[0] as HTMLElement;
    expect(scroll.className).toContain("min-h-0");
    expect(scroll.className).toContain("flex-1");
    expect(within(scroll).getByRole("radiogroup")).toBeTruthy();

    const footer = content.querySelector('[data-slot="dialog-footer"]') as HTMLElement;
    expect(scroll.contains(footer)).toBe(false);
    expect(footer.className).toContain("shrink-0");
  });

  it("default-selects the first row so the confirm button is enabled with no click", () => {
    render(
      <WakeCwdPickerDialog
        open
        agentName="Test Agent"
        instances={makeInstances(3)}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const confirm = screen.getByRole("button", { name: "Pin & continue" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    const radios = screen.getAllByRole("radio") as HTMLElement[];
    expect(radios[0].getAttribute("aria-checked")).toBe("true");
  });

  it("fires onConfirm with the chosen instance when the confirm button is clicked", () => {
    const onConfirm = vi.fn();
    const instances = makeInstances(3);
    render(
      <WakeCwdPickerDialog
        open
        agentName="Test Agent"
        instances={instances}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getAllByRole("radio")[2]);
    fireEvent.click(screen.getByRole("button", { name: "Pin & continue" }));
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ connectionUuid: instances[2].connectionUuid }),
    );
  });

  it("fires onCancel when the Cancel button is clicked", () => {
    const onCancel = vi.fn();
    render(
      <WakeCwdPickerDialog
        open
        agentName="Test Agent"
        instances={makeInstances(2)}
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("confirms the current selection on Enter, but NOT while an IME candidate is composing", () => {
    const onConfirm = vi.fn();
    const instances = makeInstances(3);
    render(
      <WakeCwdPickerDialog
        open
        agentName="Test Agent"
        instances={instances}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    // IME composing → suppressed.
    fireEvent.keyDown(screen.getAllByRole("radio")[0], { key: "Enter", isComposing: true });
    expect(onConfirm).not.toHaveBeenCalled();
    // Plain Enter → confirms the pre-selected first row.
    fireEvent.keyDown(screen.getAllByRole("radio")[0], { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ connectionUuid: instances[0].connectionUuid }),
    );
  });

  it("uses a freshly validated temporary cwd without confirming a registered instance", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onConfirm = vi.fn();
    const onTemporaryConfirm = vi.fn();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { operation: string; cwd?: string };
      const result = body.operation === "roots"
        ? { roots: ["/workspace"] }
        : body.operation === "list"
          ? { items: [{ name: "repo", path: "/workspace/repo" }] }
          : { normalizedPath: body.cwd };
      return {
        ok: true,
        json: async () => ({
          success: true,
          data: {
            request: {
              uuid: `request-${body.operation}`,
              status: "success",
              result,
            },
          },
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <WakeCwdPickerDialog
        open
        agentName="Test Agent"
        instances={makeInstances(2)}
        agentUuid="agent-1"
        onConfirm={onConfirm}
        onTemporaryConfirm={onTemporaryConfirm}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Browse another directory" }));
    await waitFor(() => {
      expect((screen.getByRole("combobox", { name: "Directory path prefix" }) as HTMLInputElement).value)
        .toBe("/workspace/");
    });
    const input = screen.getByRole("combobox", { name: "Directory path prefix" });
    fireEvent.change(input, { target: { value: "/workspace/r" } });
    await act(() => vi.advanceTimersByTimeAsync(250));
    fireEvent.click(await screen.findByRole("option"));
    fireEvent.click(screen.getByRole("button", { name: "Use for this operation" }));

    await waitFor(() => {
      expect(onTemporaryConfirm).toHaveBeenCalledWith({
        agentUuid: "agent-1",
        validationRequestUuid: "request-validate",
      });
    });
    expect(onConfirm).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
