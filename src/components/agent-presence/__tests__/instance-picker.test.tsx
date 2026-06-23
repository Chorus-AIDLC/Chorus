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
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

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

// Find the radio input for a given connectionUuid (the picker ids them
// `instance-<connectionUuid>`).
function radioFor(connectionUuid: string): HTMLInputElement {
  return document.getElementById(
    `instance-${connectionUuid}`,
  ) as HTMLInputElement;
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe("InstancePicker — online-only rows (2+ instances)", () => {
  it("renders every (online) row enabled and selectable", () => {
    render(
      <InstancePicker
        instances={[onlineA, onlineB]}
        selectedConnectionUuid={null}
        onSelect={vi.fn()}
      />,
    );
    expect(radioFor("conn-online-a").disabled).toBe(false);
    expect(radioFor("conn-online-b").disabled).toBe(false);
  });

  it("fires onSelect with the chosen candidate when a row is clicked", () => {
    const onSelect = vi.fn();
    render(
      <InstancePicker
        instances={[onlineA, onlineB]}
        selectedConnectionUuid={onlineA.connectionUuid}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(radioFor("conn-online-b"));
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ connectionUuid: "conn-online-b" }),
    );
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
