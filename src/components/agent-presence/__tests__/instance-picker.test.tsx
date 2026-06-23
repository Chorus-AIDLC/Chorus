// @vitest-environment jsdom
//
// InstancePicker — the SHARED path-first instance picker (cwd-addressable
// instances) wired into the dispatch surfaces (@mention / assign / ad-hoc send).
// This test pins the ONLINE-ONLY contract: every consumer filters its candidate
// list to online instances BEFORE handing it here, so the picker only ever
// renders online rows. Every rendered row is therefore selectable — there is no
// disabled state, no "Offline" tag, and no "will queue" affordance. A single
// instance auto-selects with no extra click.
//
// (An offline instance is not a target on any surface: a fully-offline agent
// receives a plain notification, so its caller shows NO picker. That collapse is
// asserted at the callers, not here — here the picker simply never sees offline
// rows.)
//
// next-intl resolves real en.json strings so a missing key surfaces as its dotted
// path (same harness as the other agent-presence component tests).

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  within,
} from "@testing-library/react";

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

import {
  InstancePicker,
  type InstanceCandidate,
} from "@/components/agent-presence/instance-picker";

const onlineA: InstanceCandidate = {
  connectionUuid: "conn-online-a",
  host: "Laptop-Q3",
  cwd: "/home/u/dev/chorus",
  effectiveStatus: "online",
};
const onlineB: InstanceCandidate = {
  connectionUuid: "conn-online-b",
  host: "ci-runner-02",
  cwd: "/home/u/dev/payments",
  effectiveStatus: "online",
};

// The picker no longer ids its rows (the old `instance-<uuid>` id + label htmlFor
// double-fired and collided across two simultaneously-mounted pickers). Selection
// is driven by a row click, so tests act on the row by its cwd label. `within` a
// container scopes lookups to one picker so two mounted pickers don't clash.
function rowByCwd(scope: HTMLElement, cwdLabelFragment: string): HTMLElement {
  // The path chip renders the abbreviated tail (e.g. "…/dev/chorus"); match on the
  // final segment which is always preserved.
  const chip = within(scope).getByText(
    (t) => t.includes(cwdLabelFragment),
  );
  // Walk up to the clickable row container.
  const row = chip.closest('[role="presentation"]');
  if (!row) throw new Error(`row for ${cwdLabelFragment} not found`);
  return row as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe("InstancePicker — online-only rows (2+ instances)", () => {
  it("renders every (online) row as an enabled radio", () => {
    const { container } = render(
      <InstancePicker
        instances={[onlineA, onlineB]}
        selectedConnectionUuid={null}
        onSelect={vi.fn()}
      />,
    );
    const radios = within(container).getAllByRole("radio");
    expect(radios).toHaveLength(2);
    radios.forEach((r) => expect(r.hasAttribute("disabled")).toBe(false));
  });

  it("fires onSelect with the chosen candidate when a row is clicked", () => {
    const onSelect = vi.fn();
    const { container } = render(
      <InstancePicker
        instances={[onlineA, onlineB]}
        selectedConnectionUuid={onlineA.connectionUuid}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(rowByCwd(container, "payments"));
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ connectionUuid: "conn-online-b" }),
    );
  });

  // REGRESSION (bug A/B root cause): selecting the SECOND (non-default) row must
  // work. The old <label htmlFor> + wrapped RadioGroupItem id double-fired and,
  // worse, collided with a second mounted picker's identical ids, so clicking the
  // 2nd row forwarded activation to a stale control and selection never moved.
  it("selects the SECOND of two rows (the previously-broken case)", () => {
    const onSelect = vi.fn();
    const { container } = render(
      <InstancePicker
        instances={[onlineA, onlineB]}
        selectedConnectionUuid={onlineA.connectionUuid}
        onSelect={onSelect}
      />,
    );
    // Click the second row's container (anywhere on it).
    fireEvent.click(rowByCwd(container, "payments"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenLastCalledWith(
      expect.objectContaining({ connectionUuid: "conn-online-b" }),
    );
  });

  // REGRESSION (bug A repro): two pickers mounted at once (e.g. an open
  // conversation's reply box + the new-conversation composer) must NOT share
  // element ids — the old per-connection `instance-<uuid>` id appeared twice and
  // broke selection. The picker now uses NO such ids; assert none leak, and that
  // each picker selects independently.
  it("two mounted pickers do not collide on ids and select independently", () => {
    const onSelectFirst = vi.fn();
    const onSelectSecond = vi.fn();
    const { container: first } = render(
      <InstancePicker
        instances={[onlineA, onlineB]}
        selectedConnectionUuid={onlineA.connectionUuid}
        onSelect={onSelectFirst}
      />,
    );
    const { container: second } = render(
      <InstancePicker
        instances={[onlineA, onlineB]}
        selectedConnectionUuid={onlineA.connectionUuid}
        onSelect={onSelectSecond}
      />,
    );
    // No element carries the old colliding id pattern.
    expect(document.querySelectorAll('[id^="instance-"]').length).toBe(0);
    // Selecting in the SECOND picker fires only its callback with the right uuid.
    fireEvent.click(rowByCwd(second, "payments"));
    expect(onSelectSecond).toHaveBeenLastCalledWith(
      expect.objectContaining({ connectionUuid: "conn-online-b" }),
    );
    expect(onSelectFirst).not.toHaveBeenCalled();
  });

  it("shows NO 'Offline' tag and NO 'Queue' affordance (those concepts are gone)", () => {
    render(
      <InstancePicker
        instances={[onlineA, onlineB]}
        selectedConnectionUuid={null}
        onSelect={vi.fn()}
      />,
    );
    // The durable-offline-queue UI was removed: neither tag should ever render.
    expect(screen.queryByText("Offline")).toBeNull();
    expect(screen.queryByText("Queue")).toBeNull();
  });
});

describe("InstancePicker — single-instance auto-select", () => {
  it("auto-selects a sole online instance with no extra click", () => {
    const onSelect = vi.fn();
    render(
      <InstancePicker
        instances={[onlineA]}
        selectedConnectionUuid={null}
        onSelect={onSelect}
      />,
    );
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ connectionUuid: "conn-online-a" }),
    );
  });

  it("does not re-fire onSelect once the sole instance is already selected", () => {
    const onSelect = vi.fn();
    render(
      <InstancePicker
        instances={[onlineA]}
        selectedConnectionUuid={onlineA.connectionUuid}
        onSelect={onSelect}
      />,
    );
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe("InstancePicker — empty set", () => {
  it("renders the localized 'no instances' empty state when given no instances", () => {
    render(
      <InstancePicker
        instances={[]}
        selectedConnectionUuid={null}
        onSelect={vi.fn()}
      />,
    );
    // mentionInstance.noInstances = "No live instances".
    expect(screen.getByText("No live instances")).toBeTruthy();
  });
});
