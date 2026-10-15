// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authFetch, t } = vi.hoisted(() => ({ authFetch: vi.fn(), t: (key: string) => key }));
vi.mock("@/lib/auth-client", () => ({ authFetch }));
vi.mock("next-intl", () => ({ useTranslations: () => t }));
import { canManageWorkspaceUsers, WorkspaceUsersNavigation } from "../workspace-users-navigation";

const identity = { user: { authType: "local", workspaceAdmin: true }, company: { localAuthEnabled: true } };
function response(data: unknown, status = 200) { return new Response(JSON.stringify({ success: true, data }), { status }); }
beforeEach(() => { authFetch.mockReset(); });
afterEach(cleanup);

describe("workspace users sidebar navigation", () => {
  it.each([false, true])("shows the active semantic entry for an eligible admin (mobile=%s)", async (mobile) => {
    authFetch.mockResolvedValue(response(identity));
    render(<WorkspaceUsersNavigation pathname="/settings/users" mobile={mobile} />);
    const link = await screen.findByRole("link", { name: "title" });
    expect(link).toHaveAttribute("href", "/settings/users");
    expect(link).toHaveAttribute("aria-current", "page");
    expect(link).toHaveClass("bg-secondary", "text-foreground");
    expect(authFetch).toHaveBeenCalledWith("/api/auth/me", { cache: "no-store" });
  });
  it.each([
    null,
    { user: { authType: "local", workspaceAdmin: false }, company: { localAuthEnabled: true } },
    { user: { authType: "oidc", workspaceAdmin: true }, company: { localAuthEnabled: true } },
    { user: { authType: "local", workspaceAdmin: true }, company: { localAuthEnabled: false } },
    { user: { workspaceAdmin: true }, company: { localAuthEnabled: true } },
  ])("fails closed for an ineligible or incomplete projection %j", async (data) => {
    expect(canManageWorkspaceUsers(data)).toBe(false);
    authFetch.mockResolvedValue(response(data));
    const { container } = render(<WorkspaceUsersNavigation pathname="/projects" />);
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));
    expect(container).toBeEmptyDOMElement();
  });
  it("does not briefly display an admin entry while auth is pending or failed", async () => {
    let reject!: (error: Error) => void;
    authFetch.mockImplementation(() => new Promise((_resolve, done) => { reject = done; }));
    const { container } = render(<WorkspaceUsersNavigation pathname="/projects" />);
    expect(container).toBeEmptyDOMElement();
    reject(new Error("offline"));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
