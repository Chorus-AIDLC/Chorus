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
    // Credentials + bundle are now provisioned by installing the CLI globally
    // (pinned to @0.17.0) then `chorus agents add` — no npx. The retired curl bootstrap
    // (dsh-credentials.sh) and the removed server installer stay gone.
    expect(
      screen.getByText(/npm install -g @chorus-aidlc\/chorus@0\.17\.0/),
    ).toBeTruthy();
    expect(
      screen.getByText(/chorus agents add --agents dsh --dsh-profile <name>/),
    ).toBeTruthy();
    expect(screen.queryByText(/npx @chorus-aidlc\/chorus agents add/)).toBeNull();
    expect(screen.queryByText(/dsh-credentials\.sh/)).toBeNull();
    expect(screen.queryByText(/curl -fsSL/)).toBeNull();
    expect(screen.queryByText(/install-dsh\.sh/)).toBeNull();
  });

  it("uses npm install + chorus agents add as the sole Claude Code command (no redundant /plugin flow — chorus agents add already runs it)", () => {
    render(<AgentInstallGuide apiKey="cho_live_test_key" />);

    // claude-code is the default tab — no click needed.
    expect(screen.getByText("Step 2: Run chorus agents add")).toBeTruthy();
    expect(
      screen.getByText(/npm install -g @chorus-aidlc\/chorus@0\.17\.0/),
    ).toBeTruthy();
    expect(screen.getByText(/chorus agents add --agents claude/)).toBeTruthy();
    // The retired `chorus init` command name must not appear anywhere.
    expect(screen.queryByText(/chorus init/)).toBeNull();

    // Claude Code has NO manual export-profile step: chorus agents add writes the
    // connection env into ~/.claude/settings.json. Show what/where instead.
    expect(
      screen.getByText("What chorus agents add writes (no manual export needed)"),
    ).toBeTruthy();
    expect(screen.getByText(/~\/\.claude\/settings\.json env block/)).toBeTruthy();
    expect(
      screen.queryByText("Step 3 (optional): Set the default agent for the Chorus CLI"),
    ).toBeNull();
    expect(screen.queryByText(/export CHORUS_AGENT_PROFILE="<agent-uuid>"/)).toBeNull();

    // The manual `/plugin marketplace add` + `/plugin install` flow is NOT shown:
    // `chorus agents add --agents claude` already runs those `claude plugin` commands
    // under the hood (see installClaude in cli/init/install-methods.mjs), so
    // surfacing them separately would be redundant.
    expect(screen.queryByText("Or, inside Claude Code")).toBeNull();
    expect(
      screen.queryByText(/\/plugin marketplace add Chorus-AIDLC\/chorus/),
    ).toBeNull();
    expect(screen.queryByText(/\/plugin install chorus@chorus-plugins/)).toBeNull();
    expect(screen.queryByText(/npx @chorus-aidlc\/chorus agents add/)).toBeNull();
  });

  it("uses `npm install -g @chorus-aidlc/chorus@0.17.0` + `chorus agents add` (never npx) on every agent init tab", async () => {
    const user = userEvent.setup();
    render(<AgentInstallGuide apiKey={null} />);

    const initTabs = [
      { tab: "Claude Code", init: /chorus agents add --agents claude/ },
      { tab: "Codex", init: /chorus agents add --agents codex/ },
      { tab: "Kiro", init: /chorus agents add --agents kiro/ },
      { tab: "DeepSeek Harness", init: /chorus agents add --agents dsh/ },
      { tab: "OpenCode", init: /chorus agents add --agents opencode/ },
    ];

    for (const { tab, init } of initTabs) {
      await user.click(screen.getByRole("tab", { name: tab }));
      expect(
        screen.getByText(/npm install -g @chorus-aidlc\/chorus@0\.17\.0/),
      ).toBeTruthy();
      expect(screen.getByText(init)).toBeTruthy();
      expect(screen.queryByText(/npx @chorus-aidlc\/chorus agents add/)).toBeNull();
    }
  });

  it("shows the optional 'default agent' Step 3 on every chorus-agents-add tab, and drops the redundant 'Verify connection' step (onboarding has its own connection check)", async () => {
    const user = userEvent.setup();
    render(<AgentInstallGuide apiKey={null} />);

    const PROFILE_TITLE = "Step 3 (optional): Set the default agent for the Chorus CLI";
    // Codex / Kiro / OpenCode still show the manual export-profile step (their
    // settings-file auto-write is a separate, unbuilt sibling idea).
    for (const tab of ["Codex", "Kiro", "OpenCode"]) {
      await user.click(screen.getByRole("tab", { name: tab }));
      expect(screen.getByText(PROFILE_TITLE)).toBeTruthy();
      expect(screen.getByText(/export CHORUS_AGENT_PROFILE="<agent-uuid>"/)).toBeTruthy();
      // The old per-tab "Verify connection" step is gone on every tab.
      expect(screen.queryByText(/Verify connection/)).toBeNull();
    }

    // Claude Code DROPS the export-profile step — chorus agents add writes the env into
    // ~/.claude/settings.json, so it shows a "what gets written where" note instead.
    await user.click(screen.getByRole("tab", { name: "Claude Code" }));
    expect(screen.queryByText(PROFILE_TITLE)).toBeNull();
    expect(
      screen.getByText("What chorus agents add writes (no manual export needed)"),
    ).toBeTruthy();
    expect(screen.queryByText(/Verify connection/)).toBeNull();

    // dsh keeps its own flow and does NOT get the CLI profile step (its profile is
    // seeded into $DSH_HOME/.env, not exported by hand).
    await user.click(screen.getByRole("tab", { name: "DeepSeek Harness" }));
    expect(screen.queryByText(PROFILE_TITLE)).toBeNull();

    // OpenClaw no longer shows a "Verify connection" step either.
    await user.click(screen.getByRole("tab", { name: "OpenClaw" }));
    expect(screen.queryByText(/Verify connection/)).toBeNull();
    expect(screen.queryByText(PROFILE_TITLE)).toBeNull();
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
