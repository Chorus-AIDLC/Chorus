// @vitest-environment jsdom
//
// AssigneeInstanceLine — the compact (host, cwd) line rendered UNDER an
// agent_instance assignee's name across the kanban card / detail panels / dashboard
// assignee section. Asserts it renders the path-first cwd, the conditional host,
// and the localized "unknown path / host" sentinels via the shared
// daemon-instance-format helpers. next-intl resolves real en.json strings so a
// missing key surfaces as its dotted path (same harness as the other
// agent-presence component tests).

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

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
      (key: string) =>
        resolve(namespace, key),
  };
});

import { AssigneeInstanceLine } from "@/components/agent-presence/assignee-instance-line";

afterEach(() => cleanup());
beforeEach(() => vi.clearAllMocks());

describe("AssigneeInstanceLine", () => {
  it("renders the path-first cwd (abbreviated tail) and the host suffix", () => {
    render(<AssigneeInstanceLine cwd="/home/u/dev/chorus" host="ci-runner" />);
    // The cwd chip shows the preserved final segment.
    expect(screen.getByText((t) => t.includes("chorus"))).toBeTruthy();
    // The host suffix is shown by default.
    expect(screen.getByText("ci-runner")).toBeTruthy();
  });

  it("hides the host when showHost is false (the compact kanban variant)", () => {
    render(<AssigneeInstanceLine cwd="/srv/app" host="prod-box" showHost={false} />);
    expect(screen.getByText((t) => t.includes("app"))).toBeTruthy();
    expect(screen.queryByText("prod-box")).toBeNull();
  });

  it("renders the localized 'unknown path' sentinel for a null cwd", () => {
    render(<AssigneeInstanceLine cwd={null} host="some-host" />);
    // agentPresence.unknownPath = "unknown path"
    expect(screen.getByText("unknown path")).toBeTruthy();
  });

  it("renders the localized 'unknown host' sentinel for an empty host", () => {
    render(<AssigneeInstanceLine cwd="/x/y" host="" />);
    // agentPresence.unknownHost = "unknown host"
    expect(screen.getByText("unknown host")).toBeTruthy();
  });
});
