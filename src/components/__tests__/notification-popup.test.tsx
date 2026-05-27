// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";

// Radix ScrollArea (used inside the popup) calls ResizeObserver during layout
// effects; jsdom doesn't ship one, so polyfill it before the component imports.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;

import { NotificationPopup } from "@/components/notification-popup";

// next-intl: resolve real strings from the locale JSON so we catch missing keys.
let currentLocale: "en" | "zh" = "en";
vi.mock("next-intl", async () => {
  const en = (await import("../../../messages/en.json")).default as Record<
    string,
    unknown
  >;
  const zh = (await import("../../../messages/zh.json")).default as Record<
    string,
    unknown
  >;
  function resolve(messages: Record<string, unknown>, namespace: string, key: string): string {
    const fullKey = namespace ? `${namespace}.${key}` : key;
    const parts = fullKey.split(".");
    let node: unknown = messages;
    for (const p of parts) {
      if (node && typeof node === "object" && p in (node as Record<string, unknown>)) {
        node = (node as Record<string, unknown>)[p];
      } else {
        return fullKey;
      }
    }
    return typeof node === "string" ? node : fullKey;
  }
  return {
    useTranslations: (namespace = "") => (key: string) =>
      resolve(currentLocale === "en" ? en : zh, namespace, key),
  };
});

// next/navigation: capture router.push calls.
const pushSpy = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushSpy, replace: vi.fn(), back: vi.fn() }),
}));

// framer-motion: jsdom-safe pass-through; the popup only uses motion.div.
vi.mock("framer-motion", async () => {
  const ReactMod = await import("react");
  type DivProps = React.PropsWithChildren<React.HTMLAttributes<HTMLDivElement>> & {
    initial?: unknown;
    animate?: unknown;
    exit?: unknown;
    transition?: unknown;
    variants?: unknown;
    whileHover?: unknown;
    whileTap?: unknown;
  };
  const passthroughDiv = ReactMod.forwardRef<HTMLDivElement, DivProps>(
    ({ children, ...rest }, ref) => {
      // Strip motion-only props so React doesn't warn about unknown DOM attrs.
      const {
        initial: _initial,
        animate: _animate,
        exit: _exit,
        transition: _transition,
        variants: _variants,
        whileHover: _wh,
        whileTap: _wt,
        ...domProps
      } = rest;
      return ReactMod.createElement("div", { ref, ...domProps }, children);
    },
  );
  passthroughDiv.displayName = "MotionDiv";
  return { motion: { div: passthroughDiv } };
});

// auth-client: stub authFetch with an in-memory notification fixture queue.
const fixtureQueue: unknown[] = [];
vi.mock("@/lib/auth-client", () => ({
  authFetch: vi.fn(async (_url: string, _opts?: unknown) => {
    const next = fixtureQueue.shift() ?? { notifications: [], unreadCount: 0 };
    return {
      ok: true,
      json: async () => ({ success: true, data: next }),
    };
  }),
}));

// notification-context: only refreshNotifications is consumed by the popup.
vi.mock("@/contexts/notification-context", () => ({
  useNotification: () => ({ refreshNotifications: vi.fn() }),
}));

const PROJECT_UUID = "11111111-1111-1111-1111-111111111111";
const IDEA_UUID = "22222222-2222-2222-2222-222222222222";

function reportNotification() {
  return {
    uuid: "n-1",
    projectUuid: PROJECT_UUID,
    projectName: "Test Project",
    entityType: "idea",
    entityUuid: IDEA_UUID,
    entityTitle: "Idea: build the thing",
    action: "report_created",
    message: "A new report was created",
    actorType: "agent",
    actorUuid: "actor-1",
    actorName: "Admin Claude",
    readAt: null,
    createdAt: new Date().toISOString(),
  };
}

function primeFixtures() {
  // The popup makes two parallel fetches on mount: all + unread.
  // Both should return the same single report fixture so the row shows
  // up in the default ("unread") tab.
  fixtureQueue.push({ notifications: [reportNotification()], unreadCount: 1 });
  fixtureQueue.push({ notifications: [reportNotification()], unreadCount: 1 });
}

describe("NotificationPopup — report_created deep link", () => {
  beforeEach(() => {
    pushSpy.mockReset();
    fixtureQueue.length = 0;
    currentLocale = "en";
  });

  it("renders the English report_created label and navigates to the dashboard URL with panel=<ideaUuid>&tab=overview", async () => {
    primeFixtures();
    render(<NotificationPopup onClose={vi.fn()} />);

    // i18n label resolves through t('notifications.types.report_created')
    const label = await screen.findByText("New report");
    expect(label).toBeTruthy();

    // Click the row — the button wraps the entire notification content.
    const row = label.closest("button");
    expect(row).not.toBeNull();
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(row!);

    await waitFor(() => expect(pushSpy).toHaveBeenCalledTimes(1));
    // Exact URL — dashboard contract is panel=<ideaUuid>&tab=overview.
    expect(pushSpy).toHaveBeenCalledWith(
      `/projects/${PROJECT_UUID}/dashboard?panel=${IDEA_UUID}&tab=overview`,
    );
  });

  it("renders the Chinese report_created label under the zh locale", async () => {
    currentLocale = "zh";
    primeFixtures();
    render(<NotificationPopup onClose={vi.fn()} />);

    const label = await screen.findByText("新报告");
    expect(label).toBeTruthy();
  });
});
