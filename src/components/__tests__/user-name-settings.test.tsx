// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextIntlClientProvider } from "next-intl";
import { AuthProvider, useAuth } from "@/contexts/auth-context";
import { UserNameSettings } from "@/components/user-name-settings";
import { UserIdentityName } from "@/components/user-identity-name";
import en from "../../../messages/en.json";
import zh from "../../../messages/zh.json";
import ja from "../../../messages/ja.json";
import ko from "../../../messages/ko.json";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), router: { push: vi.fn() } }));
vi.mock("@/hooks/use-progress-router", () => ({ useRouter: () => mocks.router }));
vi.mock("@/lib/auth-client", () => ({
  authFetch: mocks.fetch,
  resyncRefreshTokenFromStore: vi.fn(),
  purgeDeadSession: vi.fn(),
  logout: vi.fn(),
  clearUserManager: vi.fn(),
}));

const userUuid = "d1576792-cacc-4d6d-9b3b-9785a1285fbf";
const otherUuid = "ca458eac-eec5-4781-ab63-1c70548f1696";
const locales = { en, zh, ja, ko };
const originalAvatar = "f1b01d10-dfce-4c26-97ce-fbacfd2a0a7e";
const newAvatar = "b43c9256-8690-4f91-aac8-30df067b836b";

function response(name = "Alice", uuid = userUuid, avatarSeed = originalAvatar) {
  return { ok: true, status: 200, json: async () => ({ success: true, data: { user: { uuid, name, avatarSeed }, company: {} } }) };
}

function Identity() {
  const auth = useAuth();
  return <>
    <span data-testid="name">{auth.user?.name}</span>
    <span data-testid="avatar">{auth.user?.avatarSeed}</span>
    <span data-testid="sidebar-name"><UserIdentityName userUuid={userUuid} name="Alice" /></span>
    <span data-testid="other-name"><UserIdentityName userUuid={otherUuid} name="Other" /></span>
    <button onClick={() => void auth.refreshSession()}>Refresh session</button>
    <button onClick={() => auth.applySavedAvatar(userUuid, newAvatar)}>Apply avatar</button>
    <button onClick={() => auth.applySavedName(otherUuid, "Wrong user")}>Apply wrong user</button>
  </>;
}

function mount(locale: keyof typeof locales = "en") {
  return render(<NextIntlClientProvider locale={locale} messages={locales[locale]}>
    <AuthProvider><UserNameSettings /><Identity /></AuthProvider>
  </NextIntlClientProvider>);
}

async function ready() {
  await waitFor(() => expect((screen.getByRole("textbox") as HTMLInputElement).disabled).toBe(false));
}

function edit(value: string) { fireEvent.change(screen.getByRole("textbox"), { target: { value } }); }
function save() { fireEvent.click(screen.getByRole("button", { name: "Save display name" })); }
function writes() { return mocks.fetch.mock.calls.filter(([, options]) => options?.method === "PATCH"); }

beforeEach(() => { vi.clearAllMocks(); mocks.fetch.mockResolvedValue(response()); });
afterEach(cleanup);

describe("UserNameSettings", () => {
  it("renders fallback identity names without an auth provider", () => {
    render(<><UserIdentityName userUuid={userUuid} name="Fallback" /><UserIdentityName /></>);
    expect(screen.getByText("Fallback")).toBeTruthy();
  });

  it.each(["en", "zh", "ja", "ko"] as const)("renders accessible localized controls in %s", async locale => {
    mount(locale); await ready();
    expect(screen.getByRole("textbox", { name: locales[locale].settings.displayName.label })).toBeTruthy();
    expect((screen.getByRole("button", { name: locales[locale].settings.displayName.save }) as HTMLButtonElement).disabled).toBe(true);
    expect(Object.keys(locales[locale].settings.displayName)).toEqual(Object.keys(en.settings.displayName));
  });

  it("trims, preserves internal spaces and updates identity only after a successful save", async () => {
    mount(); await ready();
    edit("  新  名 😀  ");
    expect(screen.getByTestId("name").textContent).toBe("Alice");
    mocks.fetch.mockResolvedValueOnce(response("新  名 😀"));
    save();
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(en.settings.displayName.saved));
    expect(writes()).toHaveLength(1);
    expect(writes()[0]).toEqual(["/api/users/me/name", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ name: "新  名 😀" }) })]);
    expect(screen.getByTestId("name").textContent).toBe("新  名 😀");
    expect(screen.getByTestId("sidebar-name").textContent).toBe("新  名 😀");
    expect(screen.getByTestId("other-name").textContent).toBe("Other");
    expect(screen.getByTestId("avatar").textContent).toBe(originalAvatar);
  });

  it("counts code points, not UTF-16 or graphemes, and blocks invalid input", async () => {
    mount(); await ready();
    for (const value of ["", "   ", "😀".repeat(33), "e\u0301".repeat(17)]) {
      edit(value);
      expect(screen.getByRole("textbox").getAttribute("aria-invalid")).toBe("true");
      save();
    }
    expect(writes()).toHaveLength(0);
    edit("  " + "😀".repeat(32) + "  ");
    expect(screen.getByText("32 / 32 code points")).toBeTruthy();
    expect(screen.getByRole("textbox").getAttribute("maxlength")).toBeNull();
    expect((screen.getByRole("button", { name: "Save display name" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps a legacy long name visible without truncating and allows a replacement", async () => {
    mocks.fetch.mockResolvedValueOnce(response("名".repeat(45)));
    mount(); await ready();
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("名".repeat(45));
    expect(screen.getByText("45 / 32 code points")).toBeTruthy();
    expect(writes()).toHaveLength(0);
    edit("Valid");
    expect(screen.getByRole("textbox").getAttribute("aria-invalid")).toBe("false");
  });

  it.each(["http", "network", "wrong-user", "wrong-name", "malformed"])("preserves the draft and current identity on %s failure, then retries", async failure => {
    mount(); await ready(); edit("Updated");
    if (failure === "http") mocks.fetch.mockResolvedValueOnce({ ok: false, status: 500 });
    if (failure === "network") mocks.fetch.mockRejectedValueOnce(new Error("offline"));
    if (failure === "wrong-user") mocks.fetch.mockResolvedValueOnce(response("Updated", otherUuid));
    if (failure === "wrong-name") mocks.fetch.mockResolvedValueOnce(response("Not requested"));
    if (failure === "malformed") mocks.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) });
    save();
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(en.settings.displayName.failed));
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("Updated");
    expect(screen.getByTestId("name").textContent).toBe("Alice");
    mocks.fetch.mockResolvedValueOnce(response("Updated")); save();
    await waitFor(() => expect(screen.getByTestId("name").textContent).toBe("Updated"));
  });

  it("prevents duplicate saves and ignores Enter during IME composition", async () => {
    mount(); await ready(); edit("Updated");
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", isComposing: true });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", keyCode: 229 });
    expect(writes()).toHaveLength(0);
    let resolveSave!: (value: ReturnType<typeof response>) => void;
    mocks.fetch.mockReturnValueOnce(new Promise(resolve => { resolveSave = resolve; }));
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(screen.getByRole("button", { name: "Saving…" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Saving…" }));
    expect(writes()).toHaveLength(1);
    await act(async () => resolveSave(response("Updated")));
  });

  it("cancels edits without a write", async () => {
    mount(); await ready(); edit("Draft");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("Alice");
    expect(writes()).toHaveLength(0);
  });

  it("preserves saved name and avatar independently against a stale session probe", async () => {
    mount(); await ready();
    let resolveProbe!: (value: ReturnType<typeof response>) => void;
    mocks.fetch.mockReturnValueOnce(new Promise(resolve => { resolveProbe = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh session" }));
    edit("Updated"); mocks.fetch.mockResolvedValueOnce(response("Updated")); save();
    await waitFor(() => expect(screen.getByTestId("name").textContent).toBe("Updated"));
    fireEvent.click(screen.getByRole("button", { name: "Apply avatar" }));
    await act(async () => resolveProbe(response()));
    expect(screen.getByTestId("name").textContent).toBe("Updated");
    expect(screen.getByTestId("avatar").textContent).toBe(newAvatar);
    mocks.fetch.mockResolvedValueOnce(response("External update", userUuid, newAvatar));
    fireEvent.click(screen.getByRole("button", { name: "Refresh session" }));
    await waitFor(() => expect(screen.getByTestId("name").textContent).toBe("External update"));
  });

  it("ignores wrong-user acknowledgements and discards a draft on account change", async () => {
    mount(); await ready(); edit("Draft");
    fireEvent.click(screen.getByRole("button", { name: "Apply wrong user" }));
    expect(screen.getByTestId("name").textContent).toBe("Alice");
    mocks.fetch.mockResolvedValueOnce(response("Bob", otherUuid));
    fireEvent.click(screen.getByRole("button", { name: "Refresh session" }));
    await waitFor(() => expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("Bob"));
  });

  it("does not apply a delayed save to a newly authenticated user", async () => {
    mount(); await ready(); edit("Updated Alice");
    let resolveSave!: (value: ReturnType<typeof response>) => void;
    mocks.fetch.mockReturnValueOnce(new Promise(resolve => { resolveSave = resolve; }));
    save();
    mocks.fetch.mockResolvedValueOnce(response("Bob", otherUuid));
    fireEvent.click(screen.getByRole("button", { name: "Refresh session" }));
    await waitFor(() => expect(screen.getByTestId("name").textContent).toBe("Bob"));
    await act(async () => resolveSave(response("Updated Alice")));
    expect(screen.getByTestId("name").textContent).toBe("Bob");
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("Bob");
  });
});
