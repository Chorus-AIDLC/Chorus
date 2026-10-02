// @vitest-environment jsdom

import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { locales, type Locale } from "@/i18n/config";
import type { WakeError } from "@/lib/daemon-wake-error";
import type { TurnWithMessagesView } from "@/services/daemon-session.service";
import en from "../../../../../messages/en.json";
import zh from "../../../../../messages/zh.json";
import ja from "../../../../../messages/ja.json";
import ko from "../../../../../messages/ko.json";
import { TurnBand } from "../turn-band";

// The transcript renderer has its own Markdown tests. Diagnostics must never use it.
vi.mock("@/components/markdown-content", () => ({
  MarkdownContent: ({ children }: { children: ReactNode }) => (
    <div data-testid="transcript-markdown">{children}</div>
  ),
}));

const messages = { en, zh, ja, ko };
const wakeError: WakeError = {
  kind: "execution",
  source: "codex",
  message: "<b>Provider failed</b> **summary**",
  details: "<script>alert('error')</script>\n**not bold** [link](https://example.com)",
  exitCode: 0,
  signal: "SIGTERM",
};
const partialReply = {
  uuid: "message-1",
  turnUuid: "turn-1",
  role: "assistant",
  text: "Partial assistant reply",
  seq: 1,
  createdAt: "2026-10-02T12:00:00.000Z",
};

function turn(overrides: Partial<TurnWithMessagesView> = {}): TurnWithMessagesView {
  return {
    uuid: "turn-1",
    sessionUuid: "session-1",
    backendSessionId: null,
    seq: 1,
    trigger: "human_instruction",
    promptText: "Please continue",
    status: "interrupted",
    interruptedReason: "crash",
    relayError: null,
    wakeError,
    usage: null,
    executionUuid: null,
    startedAt: "2026-10-02T12:00:00.000Z",
    endedAt: "2026-10-02T12:01:00.000Z",
    createdAt: "2026-10-02T11:59:00.000Z",
    messages: [],
    ...overrides,
  };
}

function provider(locale: Locale, children: ReactNode) {
  return (
    <NextIntlClientProvider
      locale={locale}
      messages={messages[locale]}
      timeZone="UTC"
      onError={(error) => { throw error; }}
    >
      {children}
    </NextIntlClientProvider>
  );
}

function band(value: TurnWithMessagesView) {
  return <TurnBand turn={value} agentName="Alpha" linkedExecution={null} />;
}

function renderBand(overrides: Partial<TurnWithMessagesView> = {}, locale: Locale = "en") {
  return render(provider(locale, band(turn(overrides))));
}

afterEach(cleanup);

describe.each(locales)("failed turn presentation in %s", (locale) => {
  const copy = messages[locale].daemonChat;

  it.each([
    ["crash", false],
    ["crash", true],
    ["invalid_path", false],
    ["invalid_path", true],
  ] as const)("shows the summary before the transcript (%s, partial reply=%s)", (reason, partial) => {
    renderBand({ interruptedReason: reason, messages: partial ? [partialReply] : [] }, locale);
    const failure = screen.getByRole("region", { name: copy.turnFailureTitle });
    expect(within(failure).getByText(wakeError.message)).toBeTruthy();
    expect(screen.getByText("Please continue")).toBeTruthy();
    expect(screen.queryByText(wakeError.details!)).toBeNull();
    if (partial) {
      const reply = screen.getByText(partialReply.text);
      expect(failure.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it("expands and collapses with the keyboard, exposing plain text and matching ICU values", async () => {
    const user = userEvent.setup();
    const { container } = renderBand({}, locale);
    const toggle = screen.getByRole("button", { name: copy.turnFailureShowDetails });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("data-slot")).toBe("button");

    await user.tab();
    expect(document.activeElement).toBe(toggle);
    await user.keyboard("{Enter}");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent).toBe(copy.turnFailureHideDetails);
    const detailRegion = screen.getByRole("region", { name: copy.turnFailureHideDetails });
    expect(detailRegion.id).toBe(toggle.getAttribute("aria-controls"));
    expect(detailRegion.getAttribute("tabindex")).toBe("0");
    expect(within(detailRegion).getByText(copy.turnFailureExitCode.replace("{code}", "0"))).toBeTruthy();
    expect(within(detailRegion).getByText(copy.turnFailureSignal.replace("{signal}", "SIGTERM"))).toBeTruthy();
    expect(detailRegion.querySelector("pre")?.textContent).toBe(wakeError.details);
    expect(container.querySelector("script, b, strong, a")).toBeNull();
    expect(screen.queryByTestId("transcript-markdown")).toBeNull();

    await user.keyboard(" ");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("region", { name: copy.turnFailureHideDetails })).toBeNull();
    expect(screen.getByText(wakeError.message)).toBeTruthy();
  });

  it.each(["crash", "invalid_path"] as const)("shows a generic %s reason for historical turns without a details control", (reason) => {
    for (const diagnostic of [undefined, null]) {
      const { unmount } = renderBand({ interruptedReason: reason, wakeError: diagnostic }, locale);
      const fallback = reason === "crash" ? copy.turnFailureCrash : copy.turnFailureInvalidPath;
      expect(screen.getByText(fallback)).toBeTruthy();
      expect(screen.queryByRole("button")).toBeNull();
      unmount();
    }
  });

  it.each([null, " \n\t "])("keeps a summary-only diagnostic visible without an empty disclosure (%s)", (details) => {
    renderBand({ wakeError: { ...wakeError, details, exitCode: null, signal: null } }, locale);
    expect(screen.getByText(wakeError.message)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("failure eligibility and independent transcript states", () => {
  it.each([
    ["ended", "crash"],
    ["pending", "crash"],
    ["running", "crash"],
    ["merged", "crash"],
    ["interrupted", "user"],
    ["interrupted", "shutdown"],
    ["interrupted", "offline"],
    ["interrupted", null],
  ])("does not show a diagnostic on %s/%s even with a stray wakeError", (status, reason) => {
    renderBand({ status, interruptedReason: reason });
    expect(screen.queryByText(en.daemonChat.turnFailureTitle)).toBeNull();
    expect(screen.queryByText(wakeError.message)).toBeNull();
  });

  it("shows wake failure and transcript upload failure separately", () => {
    renderBand({ relayError: "transcript upload returned 502" });
    expect(screen.getByText(wakeError.message)).toBeTruthy();
    expect(screen.getByText(en.daemonChat.turnRelayFailed)).toBeTruthy();
    expect(screen.getByText("transcript upload returned 502")).toBeTruthy();
    expect(screen.queryByText(en.daemonChat.turnEndedNoReply)).toBeNull();
  });

  it("consumes a refreshed failed-turn projection and keeps its summary after remount", () => {
    const view = renderBand({ status: "running", interruptedReason: null, wakeError: undefined });
    expect(screen.queryByText(wakeError.message)).toBeNull();
    view.rerender(provider("en", band(turn({ messages: [partialReply] }))));
    expect(screen.getByText(wakeError.message)).toBeTruthy();
    expect(screen.getByText(partialReply.text)).toBeTruthy();
    view.unmount();
    renderBand({ messages: [partialReply] });
    expect(screen.getByText(wakeError.message)).toBeTruthy();
    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe("false");
  });
});

describe("diagnostic detail availability", () => {
  it.each([
    { details: "stderr tail", exitCode: null, signal: null, text: "stderr tail" },
    { details: null, exitCode: 0, signal: null, text: "Exit code: 0" },
    { details: null, exitCode: 17, signal: null, text: "Exit code: 17" },
    { details: null, exitCode: null, signal: "SIGKILL", text: "Signal: SIGKILL" },
  ])("offers expansion for available detail $text", async ({ text, ...diagnostic }) => {
    const user = userEvent.setup();
    renderBand({ wakeError: { ...wakeError, ...diagnostic } });
    await user.click(screen.getByRole("button", { name: en.daemonChat.turnFailureShowDetails }));
    const region = screen.getByRole("region", { name: en.daemonChat.turnFailureHideDetails });
    expect(within(region).getByText(text)).toBeTruthy();
    expect(region.textContent).not.toMatch(/null|undefined/);
  });

  it("uses the historical fallback when no usable summary is present", () => {
    renderBand({ wakeError: { ...wakeError, message: " " } });
    expect(screen.getByText(en.daemonChat.turnFailureCrash)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("keeps expansion and accessible detail IDs independent for multiple failed turns", async () => {
    const user = userEvent.setup();
    render(provider("en", <>
      {band(turn())}
      {band(turn({ uuid: "turn-2", seq: 2 }))}
    </>));
    const toggles = screen.getAllByRole("button", { name: en.daemonChat.turnFailureShowDetails });
    expect(toggles[0].getAttribute("aria-controls")).not.toBe(toggles[1].getAttribute("aria-controls"));
    await user.click(toggles[0]);
    expect(toggles[0].getAttribute("aria-expanded")).toBe("true");
    expect(toggles[1].getAttribute("aria-expanded")).toBe("false");
    expect(screen.getAllByRole("region", { name: en.daemonChat.turnFailureHideDetails })).toHaveLength(1);
  });

  it.each(["light", "dark"])("uses theme tokens and bounds long diagnostic lines in the %s theme", async (theme) => {
    const user = userEvent.setup();
    const longText = "x".repeat(8000);
    render(<div className={theme === "dark" ? "dark" : ""}>
      {provider("en", band(turn({ wakeError: { ...wakeError, message: "x".repeat(500), details: longText } })))}
    </div>);
    const failure = screen.getByRole("region", { name: en.daemonChat.turnFailureTitle });
    expect(failure.className).toContain("bg-destructive/5");
    expect(failure.className).toContain("min-w-0");
    expect(failure.querySelector("p")?.className).toContain("[overflow-wrap:anywhere]");
    await user.click(screen.getByRole("button"));
    const detailRegion = screen.getByRole("region", { name: en.daemonChat.turnFailureHideDetails });
    expect(detailRegion.className).toContain("bg-muted");
    expect(detailRegion.className).toContain("max-h-64");
    expect(detailRegion.className).toContain("overflow-y-auto");
    const pre = detailRegion.querySelector("pre");
    expect(pre?.className).toContain("whitespace-pre-wrap");
    expect(pre?.className).toContain("[overflow-wrap:anywhere]");
    expect(pre?.textContent).toBe(longText);
  });
});
