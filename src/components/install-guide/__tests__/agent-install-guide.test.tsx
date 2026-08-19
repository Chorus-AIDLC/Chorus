// @vitest-environment jsdom

import React from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", async () => {
  const en = (await import("../../../../messages/en.json")).default as Record<
    string,
    unknown
  >;

  return {
    useTranslations:
      (namespace: string) =>
      (key: string, values?: Record<string, unknown>) => {
        let node: unknown = en;
        for (const part of `${namespace}.${key}`.split(".")) {
          node =
            node && typeof node === "object" && part in (node as Record<string, unknown>)
              ? (node as Record<string, unknown>)[part]
              : undefined;
        }
        if (typeof node !== "string") return `${namespace}.${key}`;
        return values
          ? node.replace(/\{(\w+)\}/g, (_m, k: string) =>
              k in values ? String(values[k]) : `{${k}}`,
            )
          : node;
      },
  };
});

vi.mock("../CodeBlock", () => ({
  CodeBlock: ({ code, language }: { code: string; language?: string }) => (
    <pre data-language={language}>{code}</pre>
  ),
}));

import { AgentInstallGuide } from "../AgentInstallGuide";

const TAB_NAMES = [
  "Claude Code",
  "Codex",
  "Kiro",
  "DeepSeek Harness",
  "OpenCode",
  "OpenClaw",
  "Other Agents",
];

describe("AgentInstallGuide dsh onboarding", () => {
  it("renders seven ordered, non-shrinking tabs in a horizontally scrollable row", () => {
    const { container } = render(<AgentInstallGuide apiKey={null} />);
    const tabList = container.querySelector<HTMLElement>('[data-slot="tabs-list"]');

    expect(tabList).toBeTruthy();
    expect(tabList?.className).toContain("overflow-x-auto");
    expect(tabList?.className).toContain("justify-start");

    const tabs = within(tabList!).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(TAB_NAMES);
    for (const tab of tabs) expect(tab.className).toContain("shrink-0");
  });

  it("shows the complete dsh setup flow with a live key", async () => {
    const user = userEvent.setup();
    render(<AgentInstallGuide apiKey="cho_live_test_key" />);

    await user.click(screen.getByRole("tab", { name: "DeepSeek Harness" }));

    expect(screen.getByText("Step 1: Set environment variables")).toBeTruthy();
    expect(screen.getByText("Step 2: Add the Chorus bundle")).toBeTruthy();
    expect(screen.getByText("Step 3: Store credentials")).toBeTruthy();
    expect(screen.getByText("Step 4: Launch and verify")).toBeTruthy();
    expect(screen.getByText(/export CHORUS_API_KEY="cho_live_test_key"/)).toBeTruthy();
    expect(
      screen.getByText("dsh plugin --profile <name> add @chorus-aidlc/chorus-dsh -w"),
    ).toBeTruthy();
    expect(screen.getByText(/dsh --profile <name>.*"check in to chorus"/i)).toBeTruthy();
    expect(screen.getByText(/dsh 0\.1\.0-rc\.7 and pnpm/i)).toBeTruthy();
    // Credential provisioning uses the served script; the removed server installer stays gone.
    expect(screen.getByText(/bash <\(curl -fsSL .*\/dsh-credentials\.sh\)/)).toBeTruthy();
    expect(screen.queryByText(/install-dsh\.sh/)).toBeNull();
  });

  it("uses the API-key placeholder when no live key is available", async () => {
    const user = userEvent.setup();
    render(<AgentInstallGuide apiKey={null} />);

    await user.click(screen.getByRole("tab", { name: "DeepSeek Harness" }));

    expect(screen.getByText(/export CHORUS_API_KEY="<YOUR_API_KEY>"/)).toBeTruthy();
  });

  it("has no raw <tag> in onboarding.install strings across all locales (next-intl treats them as rich-text tags)", async () => {
    const locales = {
      en: (await import("../../../../messages/en.json")).default,
      zh: (await import("../../../../messages/zh.json")).default,
      ja: (await import("../../../../messages/ja.json")).default,
      ko: (await import("../../../../messages/ko.json")).default,
    } as Record<string, Record<string, unknown>>;
    const offenders: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (typeof node === "string") {
        // A raw "<letter" is parsed by next-intl as an (unhandled) rich-text tag
        // in plain t(), which makes the whole string fail to render.
        if (/<[a-zA-Z]/.test(node)) offenders.push(`${path} => ${node}`);
      } else if (node && typeof node === "object") {
        for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
      }
    };
    for (const [loc, msgs] of Object.entries(locales)) {
      const onboarding = msgs.onboarding as Record<string, unknown> | undefined;
      walk(onboarding?.install, `${loc}:onboarding.install`);
    }
    expect(offenders).toEqual([]);
  });
});
