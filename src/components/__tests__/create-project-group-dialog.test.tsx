// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import * as React from "react";

const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock, push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("next-intl", async () => {
  const en = (await import("../../../messages/en.json")).default as Record<
    string,
    unknown
  >;
  function resolveKey(ns: string, key: string): string {
    const path = ns ? `${ns}.${key}`.split(".") : key.split(".");
    let node: unknown = en;
    for (const p of path) {
      if (node && typeof node === "object" && p in (node as Record<string, unknown>)) {
        node = (node as Record<string, unknown>)[p];
      } else {
        return `${ns ? ns + "." : ""}${key}`;
      }
    }
    return typeof node === "string" ? node : `${ns ? ns + "." : ""}${key}`;
  }
  return {
    useTranslations: (ns?: string) => (key: string) => resolveKey(ns ?? "", key),
  };
});

import { CreateProjectGroupDialog } from "@/components/create-project-group-dialog";

describe("CreateProjectGroupDialog — Enter + IME composition", () => {
  beforeEach(() => {
    refreshMock.mockReset();
    // Spy on fetch — submission goes through POST /api/project-groups.
    // We watch whether it was called to determine if the form attempted to submit.
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          json: async () => ({ success: true }),
        } as Response)
      )
    );
  });

  it("does NOT submit on Enter while IME is composing (nativeEvent.isComposing=true)", () => {
    render(
      <CreateProjectGroupDialog open={true} onOpenChange={() => {}} />
    );

    const input = screen.getByPlaceholderText(
      "e.g., Mobile Apps"
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "测试" } });

    // Simulate the keystroke that fires while a Chinese IME candidate is being
    // chosen — the native event carries isComposing=true, and React forwards it.
    fireEvent.keyDown(input, {
      key: "Enter",
      // React's `keyCode` field on the synthetic event mirrors the native one
      // for legacy compatibility; isImeComposing checks both nativeEvent.isComposing
      // and keyCode === 229. Set keyCode to 229 to exercise the legacy fallback,
      // which is the strongest IME signal.
      keyCode: 229,
    });

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("DOES submit on Enter when not composing (plain keystroke)", () => {
    render(
      <CreateProjectGroupDialog open={true} onOpenChange={() => {}} />
    );

    const input = screen.getByPlaceholderText(
      "e.g., Mobile Apps"
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "My Group" } });

    fireEvent.keyDown(input, {
      key: "Enter",
      keyCode: 13,
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/project-groups",
      expect.objectContaining({ method: "POST" })
    );
  });
});
