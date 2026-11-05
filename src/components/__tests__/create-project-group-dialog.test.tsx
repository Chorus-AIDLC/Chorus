// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import * as React from "react";

const locale = vi.hoisted(() => ({ current: "en" }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  locale.current = "en";
});

const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock, push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/hooks/use-progress-router", () => ({
  useRouter: () => ({ refresh: refreshMock, push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("next-intl", async () => {
  const messages: Record<string, unknown> = {
    en: (await import("../../../messages/en.json")).default,
    zh: (await import("../../../messages/zh.json")).default,
    ja: (await import("../../../messages/ja.json")).default,
    ko: (await import("../../../messages/ko.json")).default,
  };
  function resolveKey(ns: string, key: string): string {
    const path = ns ? `${ns}.${key}`.split(".") : key.split(".");
    let node: unknown = messages[locale.current];
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

describe("CreateProjectGroupDialog — creation errors", () => {
  beforeEach(() => {
    refreshMock.mockReset();
    vi.stubGlobal("fetch", vi.fn());
  });

  it.each([
    ["en", "e.g., Mobile Apps", "A project group with this name already exists. Choose a different name."],
    ["zh", "例如：移动应用", "已存在同名项目组，请使用其他名称。"],
    ["ja", "例：モバイルアプリ", "同じ名前のプロジェクトグループが既に存在します。別の名前を入力してください。"],
    ["ko", "예: 모바일 앱", "같은 이름의 프로젝트 그룹이 이미 존재합니다. 다른 이름을 입력하세요."],
  ])("shows a localized conflict in %s and retains the form", async (language, placeholder, message) => {
    locale.current = language;
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      success: false,
      error: { code: "CONFLICT", message: "Internal server detail" },
    }), { status: 409 }));
    const onOpenChange = vi.fn();
    const onCreated = vi.fn();
    render(<CreateProjectGroupDialog open onOpenChange={onOpenChange} onCreated={onCreated} />);
    const input = screen.getByPlaceholderText(placeholder) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Existing Group" } });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 13 });

    expect((await screen.findByRole("alert")).textContent).toBe(message);
    expect(input.value).toBe("Existing Group");
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it.each([400, 403, 500])("preserves the generic API failure for HTTP %s", async (status) => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ success: false }), { status }));
    render(<CreateProjectGroupDialog open onOpenChange={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText("e.g., Mobile Apps"), { target: { value: "Group" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Group" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Failed to create project group");
  });

  it("preserves the generic network failure", async () => {
    const en = (await import("../../../messages/en.json")).default;
    vi.mocked(fetch).mockRejectedValueOnce(new Error("Network unavailable"));
    render(<CreateProjectGroupDialog open onOpenChange={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText("e.g., Mobile Apps"), { target: { value: "Group" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Group" }));
    expect((await screen.findByRole("alert")).textContent).toBe(en.common.genericError);
  });

  it("allows a corrected name to succeed after conflict", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: false }), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 201 }));
    const onOpenChange = vi.fn();
    const onCreated = vi.fn();
    render(<CreateProjectGroupDialog open onOpenChange={onOpenChange} onCreated={onCreated} />);
    const input = screen.getByPlaceholderText("e.g., Mobile Apps") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Existing Group" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Group" }));
    await screen.findByRole("alert");
    fireEvent.change(input, { target: { value: "New Group" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Group" }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(refreshMock).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(input.value).toBe("");
    expect(vi.mocked(fetch).mock.calls[1][1]?.body).toBe(JSON.stringify({ name: "New Group", visibility: "public" }));
  });
});

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

  it("DOES submit on Enter when not composing (plain keystroke)", async () => {
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
    await waitFor(() => expect(refreshMock).toHaveBeenCalledOnce());
  });
});
