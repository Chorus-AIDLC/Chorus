// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import messages from "../../../../messages/en.json";
import zhMessages from "../../../../messages/zh.json";
let localeMessages = messages;

const { push, replace, signinRedirect } = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), signinRedirect: vi.fn() }));
vi.mock("@/hooks/use-progress-router", () => ({ useRouter: () => ({ push, replace }) }));
vi.mock("@/lib/auth-client", () => ({ authFetch: (...args: Parameters<typeof fetch>) => fetch(...args), resyncRefreshTokenFromStore: vi.fn() }));
vi.mock("@/lib/oidc", () => ({ storeOidcConfig: vi.fn(), createUserManager: () => ({ signinRedirect }) }));
vi.mock("next-intl", () => ({ useTranslations: (namespace?: string) => (key: string, values?: Record<string, string>) => {
  let value: unknown = localeMessages;
  for (const part of (namespace ? `${namespace}.${key}` : key).split(".")) value = (value as Record<string, unknown>)[part];
  let text = String(value);
  for (const [key, value] of Object.entries(values ?? {})) text = text.replaceAll(`{${key}}`, value);
  return text;
} }));
import LoginPage from "@/app/login/page";
import AcceptPage from "@/app/login/local/accept/page";

let identify: unknown;
let mutation: { success: boolean; error?: { message: string } };
let requests: Array<{ url: string; body?: Record<string, string> }>;
beforeEach(() => {
  vi.clearAllMocks(); localeMessages = messages; requests = []; mutation = { success: true };
  identify = { type: "local", company: { uuid: "local-1", name: "Local One" } };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const data = url === "/api/auth/check-default" ? { success: true, data: { enabled: false } }
      : url === "/api/auth/identify" ? { success: true, data: identify }
      : url === "/api/auth/local/login" || url === "/api/auth/local/accept" ? mutation
      : url === "/api/agents" ? { success: true, data: [ {} ] }
      : { success: false };
    return { ok: data.success, status: 200, json: async () => data };
  }));
  vi.stubGlobal("localStorage", { getItem: () => "true" });
  window.history.replaceState(null, "", "/login");
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function identifyUser(identifier = "alice") {
  await userEvent.type(await screen.findByLabelText("Username or email"), identifier);
  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
}

describe("local unified login", () => {
  it("discovers a username, freezes workspace/identifier and posts tenant-bound credentials", async () => {
    render(<LoginPage />); await identifyUser();
    expect(await screen.findByText("Sign in to Local One")).toBeTruthy();
    expect(screen.getByLabelText("Username or email").getAttribute("readonly")).not.toBeNull();
    await userEvent.type(screen.getByLabelText("Password"), "longpassword123");
    await userEvent.click(screen.getByRole("button", { name: "Sign In" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/projects"));
    expect(requests.find((r) => r.url === "/api/auth/identify")?.body).toEqual({ identifier: "alice" });
    expect(requests.find((r) => r.url === "/api/auth/local/login")?.body).toEqual({ companyUuid: "local-1", identifier: "alice", password: "longpassword123" });
  });
  it("chooses among local workspaces and clears password on back", async () => {
    identify = { type: "multi_role", roles: [ { kind: "local", company: { uuid: "local-1", name: "Local One" } }, { kind: "local", company: { uuid: "local-2", name: "Local Two" } } ] };
    render(<LoginPage />); await identifyUser("alice@example.com");
    await userEvent.click(await screen.findByRole("button", { name: "Sign in to Local Two" }));
    await userEvent.type(screen.getByLabelText("Password"), "secret");
    await userEvent.click(screen.getByRole("button", { name: "Use a different email" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(await screen.findByRole("button", { name: "Sign in to Local One" }));
    expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("");
  });
  it("waits for a mixed local/SSO workspace choice before showing credentials or redirecting", async () => {
    identify = { type: "multi_role", roles: [
      { kind: "local", company: { uuid: "local-1", name: "Local One" } },
      { kind: "oidc", company: { uuid: "sso-1", name: "SSO One", oidcIssuer: "https://sso.example.com", oidcClientId: "client" } },
    ] };
    render(<LoginPage />); await identifyUser("alice@example.com");
    expect(await screen.findByRole("button", { name: "Sign in to Local One" })).toBeTruthy();
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(signinRedirect).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Sign in with SSO One" }));
    await waitFor(() => expect(signinRedirect).toHaveBeenCalledWith({ extraQueryParams: { login_hint: "alice@example.com" } }));
    expect(requests.some((r) => r.url === "/api/auth/local/login")).toBe(false);
  });
  it("routes SSO-only multiple matches to workspace selection before redirecting", async () => {
    identify = { type: "oidc_multi_match", candidates: [{ uuid: "sso-1", name: "SSO One" }, { uuid: "sso-2", name: "SSO Two" }] };
    render(<LoginPage />); await identifyUser("alice@example.com");
    expect(push).toHaveBeenCalledWith("/login/pick-workspace?email=alice%40example.com");
    expect(signinRedirect).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Password")).toBeNull();
  });
  it("shows rejected local credentials without navigating", async () => {
    mutation = { success: false, error: { message: "Invalid credentials" } };
    render(<LoginPage />); await identifyUser();
    await userEvent.type(screen.getByLabelText("Password"), "wrong-password");
    await userEvent.click(screen.getByRole("button", { name: "Sign In" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Invalid username or password.");
    expect(push).not.toHaveBeenCalled();
  });
  it("localizes rejected credentials in Chinese rather than rendering the server message", async () => {
    localeMessages = zhMessages;
    mutation = { success: false, error: { message: "Invalid credentials" } };
    render(<LoginPage />);
    await userEvent.type(await screen.findByLabelText(zhMessages.login.email), "alice");
    await userEvent.click(screen.getByRole("button", { name: zhMessages.login.continue }));
    await userEvent.type(await screen.findByLabelText(zhMessages.login.defaultAuth.password), "wrong-password");
    await userEvent.click(screen.getByRole("button", { name: zhMessages.login.defaultAuth.submit }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", zhMessages.login.local.invalidCredentials);
  });
  it("localizes unknown username discovery in Chinese", async () => {
    localeMessages = zhMessages;
    identify = { type: "not_found", message: "No organization found for this identifier" };
    render(<LoginPage />);
    await userEvent.type(await screen.findByLabelText(zhMessages.login.email), "unknown-user");
    await userEvent.click(screen.getByRole("button", { name: zhMessages.login.continue }));
    expect(await screen.findByText(zhMessages.login.noOrganizationFound)).toBeTruthy();
    expect(screen.queryByText("No organization found for this identifier")).toBeNull();
  });
  it("prevents an IME Enter from submitting discovery", async () => {
    render(<LoginPage />);
    const input = await screen.findByLabelText("Username or email");
    expect(fireEvent.keyDown(input, { key: "Enter", isComposing: true })).toBe(false);
    expect(requests.some((r) => r.url === "/api/auth/identify")).toBe(false);
  });
});

describe("credential acceptance", () => {
  async function fill(password = "longpassword123", confirmation = password) {
    await userEvent.type(screen.getByLabelText("New password"), password);
    await userEvent.type(screen.getByLabelText("Confirm password"), confirmation);
    await userEvent.click(screen.getByRole("button", { name: "Save password and sign in" }));
  }
  it("removes token from URL, posts only to acceptance and returns to login", async () => {
    window.history.replaceState(null, "", "/login/local/accept?token=opaque-token");
    render(<StrictMode><AcceptPage /></StrictMode>); await fill();
    await waitFor(() => expect(push).toHaveBeenCalledWith("/login"));
    expect(window.location.search).toBe("");
    expect(requests).toEqual([{ url: "/api/auth/local/accept", body: { token: "opaque-token", password: "longpassword123" } }]);
  });
  it("rejects mismatched and too-short passwords locally", async () => {
    window.history.replaceState(null, "", "/login/local/accept?token=t");
    render(<AcceptPage />); await fill("short", "different");
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Passwords do not match.");
    await userEvent.clear(screen.getByLabelText("Confirm password"));
    await userEvent.type(screen.getByLabelText("Confirm password"), "short");
    await userEvent.click(screen.getByRole("button", { name: "Save password and sign in" }));
    expect(screen.getByRole("alert").textContent).toContain("12 characters");
    expect(requests).toHaveLength(0);
  });
  it("surfaces expired or reused link errors and stays on page", async () => {
    window.history.replaceState(null, "", "/login/local/accept?token=expired");
    mutation = { success: false, error: { message: "Invalid credential link" } };
    render(<AcceptPage />); await fill();
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", messages.login.local.invalidLink);
    expect(push).not.toHaveBeenCalled();
  });
  it("localizes invalid-link recovery guidance in Chinese", async () => {
    localeMessages = zhMessages;
    window.history.replaceState(null, "", "/login/local/accept?token=expired");
    mutation = { success: false, error: { message: "Invalid or expired credential link" } };
    render(<AcceptPage />);
    await userEvent.type(screen.getByLabelText(zhMessages.login.local.password), "longpassword123");
    await userEvent.type(screen.getByLabelText(zhMessages.login.local.confirmation), "longpassword123");
    await userEvent.click(screen.getByRole("button", { name: zhMessages.login.local.acceptSubmit }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", zhMessages.login.local.invalidLink);
  });
  it("rejects missing tokens without a request", async () => {
    render(<AcceptPage />); await fill();
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", messages.login.local.invalidLink);
    expect(requests).toHaveLength(0);
  });
});
