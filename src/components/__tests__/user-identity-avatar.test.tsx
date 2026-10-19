// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "@/contexts/auth-context";
import { UserIdentityAvatar } from "@/components/user-identity-avatar";
import { UserAvatar } from "@/components/ui/user-avatar";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), router: { push: vi.fn() } }));
vi.mock("@/hooks/use-progress-router", () => ({ useRouter: () => mocks.router }));
vi.mock("@/lib/auth-client", () => ({
  authFetch: mocks.fetch, resyncRefreshTokenFromStore: vi.fn(), purgeDeadSession: vi.fn(),
  logout: vi.fn(), clearUserManager: vi.fn(),
}));
vi.mock("@/components/ui/user-avatar", () => ({
  UserAvatar: ({ userUuid, avatarSeed, name }: { userUuid?: string; avatarSeed?: string; name?: string }) => (
    <span data-testid={userUuid || "preview"} data-seed={avatarSeed}>{name}</span>
  ),
}));

function Controls() {
  const auth = useAuth();
  return <>
    <button onClick={() => auth.applySavedAvatar("self", "saved")}>Save self</button>
    <button onClick={() => auth.applySavedName("self", "Renamed")}>Rename self</button>
    <button onClick={() => auth.applySavedAvatar("other", "tamper")}>Other result</button>
    <button onClick={() => auth.refreshSession()}>Refresh</button>
    <UserIdentityAvatar userUuid="self" name="Old name snapshot" avatarSeed="old-snapshot" />
    <UserIdentityAvatar userUuid="self" avatarSeed="older-snapshot" />
    <UserIdentityAvatar userUuid="other" avatarSeed="other-seed" />
    <UserAvatar avatarSeed="unsaved-draft" />
  </>;
}
function session(seed: string) {
  return { status: 200, json: async () => ({ success: true, data: { user: { uuid: "self", name: "Alice", avatarSeed: seed }, company: {} } }) };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetch.mockResolvedValue(session("initial"));
});
afterEach(cleanup);

describe("saved avatar state", () => {
  it("uses the current name instead of stale avatar labels after renaming", async () => {
    render(<AuthProvider><Controls /></AuthProvider>);
    await waitFor(() => expect(screen.getAllByTestId("self").every(element => element.textContent === "Alice")).toBe(true));
    fireEvent.click(screen.getByText("Rename self"));
    expect(screen.getAllByTestId("self").every(element => element.textContent === "Renamed")).toBe(true);
    expect(screen.getByTestId("other").textContent).toBe("");
  });

  it("updates all mounted self avatars, not other identities or a draft preview", async () => {
    render(<AuthProvider><Controls /></AuthProvider>);
    await waitFor(() => expect(screen.getAllByTestId("self").every(element => element.dataset.seed === "initial")).toBe(true));
    fireEvent.click(screen.getByText("Save self"));
    expect(screen.getAllByTestId("self").every(element => element.dataset.seed === "saved")).toBe(true);
    expect(screen.getByTestId("other").dataset.seed).toBe("other-seed");
    expect(screen.getByTestId("preview").dataset.seed).toBe("unsaved-draft");
    fireEvent.click(screen.getByText("Other result"));
    expect(screen.getAllByTestId("self").every(element => element.dataset.seed === "saved")).toBe(true);
  });

  it("refreshes from server truth without redirecting the valid session", async () => {
    render(<AuthProvider><Controls /></AuthProvider>);
    await waitFor(() => expect(screen.getAllByTestId("self")[0].dataset.seed).toBe("initial"));
    mocks.fetch.mockResolvedValue(session("remote-save"));
    await act(async () => fireEvent.click(screen.getByText("Refresh")));
    expect(screen.getAllByTestId("self").every(element => element.dataset.seed === "remote-save")).toBe(true);
    expect(mocks.router.push).not.toHaveBeenCalled();
  });

  it("does not let a delayed pre-save session read revert a later saved avatar", async () => {
    render(<AuthProvider><Controls /></AuthProvider>);
    await waitFor(() => expect(screen.getAllByTestId("self")[0].dataset.seed).toBe("initial"));
    let resolveEarlier: (value: ReturnType<typeof session>) => void = () => {};
    mocks.fetch.mockReturnValueOnce(new Promise(resolve => { resolveEarlier = resolve; }));
    fireEvent.click(screen.getByText("Refresh"));
    fireEvent.click(screen.getByText("Save self"));
    expect(screen.getAllByTestId("self").every(element => element.dataset.seed === "saved")).toBe(true);
    await act(async () => resolveEarlier(session("initial")));
    expect(screen.getAllByTestId("self").every(element => element.dataset.seed === "saved")).toBe(true);
    mocks.fetch.mockResolvedValue(session("new-server-value"));
    await act(async () => fireEvent.click(screen.getByText("Refresh")));
    expect(screen.getAllByTestId("self").every(element => element.dataset.seed === "new-server-value")).toBe(true);
  });

  it("keeps newer refreshed truth when an even older pre-save read resolves last", async () => {
    render(<AuthProvider><Controls /></AuthProvider>);
    await waitFor(() => expect(screen.getAllByTestId("self")[0].dataset.seed).toBe("initial"));
    let resolveEarlier: (value: ReturnType<typeof session>) => void = () => {};
    mocks.fetch.mockReturnValueOnce(new Promise(resolve => { resolveEarlier = resolve; }));
    fireEvent.click(screen.getByText("Refresh"));
    fireEvent.click(screen.getByText("Save self"));
    mocks.fetch.mockResolvedValue(session("latest-server-value"));
    await act(async () => fireEvent.click(screen.getByText("Refresh")));
    await act(async () => resolveEarlier(session("initial")));
    expect(screen.getAllByTestId("self").every(element => element.dataset.seed === "latest-server-value")).toBe(true);
  });

  it("works without authentication context for standalone and missing identities", () => {
    render(<><UserIdentityAvatar userUuid="known" avatarSeed="provided" /><UserIdentityAvatar /></>);
    expect(screen.getByTestId("known").dataset.seed).toBe("provided");
    expect(screen.getByTestId("preview").dataset.seed).toBeUndefined();
  });
});
