// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UserAvatarSettings } from "@/components/user-avatar-settings";
import { AuthProvider } from "@/contexts/auth-context";
import { UserIdentityAvatar } from "@/components/user-identity-avatar";
import en from "../../../messages/en.json";
import zh from "../../../messages/zh.json";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), router: { push: vi.fn() } }));
vi.mock("@/hooks/use-progress-router", () => ({ useRouter: () => mocks.router }));
vi.mock("@/lib/auth-client", () => ({
  authFetch: mocks.fetch, resyncRefreshTokenFromStore: vi.fn(), purgeDeadSession: vi.fn(),
  logout: vi.fn(), clearUserManager: vi.fn(),
}));
vi.mock("@/components/ui/user-avatar", () => ({
  UserAvatar: ({ avatarSeed, "aria-label": label }: { avatarSeed?: string; "aria-label"?: string }) => (
    <span role="img" aria-label={label ?? "official"} data-seed={avatarSeed} />
  ),
}));

const userUuid = "d1576792-cacc-4d6d-9b3b-9785a1285fbf";
const original = "29129165-93cd-4f3c-94d8-f90f411d8894";
const firstDraft = "41c075f9-2bb8-4678-a3c0-c0a3a8dfe78b";
const secondDraft = "e873b3fc-050f-427c-86a9-1b9996a8fb94";
const messages = { en, zh };

function response(seed = original) {
  return { ok: true, status: 200, json: async () => ({ success: true, data: { user: { uuid: userUuid, name: "Alice", avatarSeed: seed }, company: {} } }) };
}

function mount(locale: "en" | "zh" = "en", editor = true) {
  return render(
    <NextIntlClientProvider locale={locale} messages={messages[locale]}>
      <AuthProvider>
        {editor && <UserAvatarSettings />}
        <UserIdentityAvatar userUuid={userUuid} avatarSeed={original} />
        <UserIdentityAvatar userUuid={userUuid} avatarSeed={original} />
      </AuthProvider>
    </NextIntlClientProvider>,
  );
}

async function ready(locale: "en" | "zh" = "en") {
  await waitFor(() => expect((screen.getByRole("button", { name: messages[locale].settings.avatar.randomize }) as HTMLButtonElement).disabled).toBe(false));
}
function seed(label = "Avatar preview") { return screen.getByRole("img", { name: label }).getAttribute("data-seed"); }
function click(name: string) { fireEvent.click(screen.getByRole("button", { name })); }
function writes() { return mocks.fetch.mock.calls.filter(([, options]) => options?.method === "PATCH"); }

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetch.mockResolvedValue(response());
  vi.spyOn(crypto, "randomUUID").mockReturnValueOnce(firstDraft).mockReturnValue(secondDraft);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("UserAvatarSettings", () => {
  it("previews, cancels and saves a cryptographic UUIDv4 without secure-context randomUUID", async () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      bytes.fill(0xff);
      return bytes;
    });
    vi.stubGlobal("crypto", { getRandomValues });
    mount(); await ready();
    click("Randomize avatar");
    const generated = seed();
    expect(generated).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
    expect(getRandomValues).toHaveBeenCalledOnce();
    expect(writes()).toHaveLength(0);
    expect(screen.getAllByRole("img", { name: "official" }).every(avatar => avatar.getAttribute("data-seed") === original)).toBe(true);
    click("Cancel");
    expect(seed()).toBe(original);
    click("Randomize avatar");
    mocks.fetch.mockResolvedValueOnce(response(generated!));
    click("Save avatar");
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Avatar saved."));
    expect(JSON.parse(writes()[0][1].body)).toEqual({ avatarSeed: generated });
    expect(screen.getAllByRole("img", { name: "official" }).every(avatar => avatar.getAttribute("data-seed") === generated)).toBe(true);
  });

  it("keeps repeated random previews local, cancels and discards on unmount", async () => {
    const view = mount();
    await ready();
    expect(seed()).toBe(original);
    expect((screen.getByRole("button", { name: "Save avatar" }) as HTMLButtonElement).disabled).toBe(true);
    click("Randomize avatar");
    expect(seed()).toBe(firstDraft);
    click("Randomize avatar");
    expect(seed()).toBe(secondDraft);
    expect(screen.getAllByRole("img", { name: "official" }).every(avatar => avatar.getAttribute("data-seed") === original)).toBe(true);
    click("Cancel");
    expect(seed()).toBe(original);
    click("Randomize avatar");
    view.unmount();
    mount();
    await ready();
    expect(seed()).toBe(original);
    expect(writes()).toHaveLength(0);
  });

  it("saves the exact preview once and updates all official avatars from the returned seed", async () => {
    mount(); await ready();
    let resolveSave!: (value: ReturnType<typeof response>) => void;
    mocks.fetch.mockReturnValueOnce(new Promise(resolve => { resolveSave = resolve; }));
    click("Randomize avatar");
    const save = screen.getByRole("button", { name: "Save avatar" });
    act(() => { fireEvent.click(save); fireEvent.click(save); });
    expect(writes()).toHaveLength(1);
    expect(JSON.parse(writes()[0][1].body)).toEqual({ avatarSeed: firstDraft });
    for (const name of ["Randomize avatar", "Saving…", "Cancel"]) {
      expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
    }
    await act(async () => resolveSave(response(secondDraft)));
    expect(screen.getByRole("status").textContent).toBe("Avatar saved.");
    expect(seed()).toBe(secondDraft);
    expect(screen.getAllByRole("img", { name: "official" }).every(avatar => avatar.getAttribute("data-seed") === secondDraft)).toBe(true);
    expect((screen.getByRole("button", { name: "Save avatar" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it.each(["http", "network", "malformed", "wrong-user"])("keeps failed %s saves retryable without changing official state", async (failure) => {
    mount(); await ready();
    if (failure === "network") mocks.fetch.mockRejectedValueOnce(new Error("offline"));
    else if (failure === "http") mocks.fetch.mockResolvedValueOnce({ ok: false, status: 500 });
    else mocks.fetch.mockResolvedValueOnce({ ok: true, json: async () => failure === "malformed" ? {} : { success: true, data: { user: { uuid: secondDraft, avatarSeed: firstDraft } } } });
    click("Randomize avatar"); click("Save avatar");
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(en.settings.avatar.failed));
    expect(seed()).toBe(firstDraft);
    expect(screen.getAllByRole("img", { name: "official" }).every(avatar => avatar.getAttribute("data-seed") === original)).toBe(true);
    mocks.fetch.mockResolvedValueOnce(response(firstDraft));
    click("Save avatar");
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Avatar saved."));
    expect(writes()).toHaveLength(2);
  });

  it("disables loading actions", () => {
    mocks.fetch.mockReturnValue(new Promise(() => {}));
    mount();
    for (const button of screen.getAllByRole("button")) expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toBe(en.settings.avatar.loading);
  });

  it.each(["en", "zh"] as const)("localizes controls and exposes attribution and live feedback in %s", async (locale) => {
    mount(locale); await ready(locale);
    const text = messages[locale].settings.avatar;
    expect(seed(text.preview)).toBe(original);
    click(text.randomize);
    expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite");
    expect(screen.getByRole("status").textContent).toBe(text.unsaved);
    expect(screen.getByRole("link", { name: "Draftbit" }).getAttribute("href")).toBe("https://draftbit.com/");
    expect(screen.getByRole("link", { name: "DiceBear" }).getAttribute("href")).toBe("https://www.dicebear.com/styles/personas/");
    expect(screen.getByRole("link", { name: "CC BY 4.0" }).getAttribute("href")).toBe("https://creativecommons.org/licenses/by/4.0/");
  });
});
