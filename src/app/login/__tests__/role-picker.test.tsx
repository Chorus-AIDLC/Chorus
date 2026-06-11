// @vitest-environment jsdom
// Integration test for the login page role-picker (super-admin / default-auth /
// OIDC collision handling). Covers both triggers and all three routing paths:
//
//   Trigger A — GET /api/auth/check-default returns superAdminCollision:true
//     → picker shown up front (super_admin + default_auth), NOT the password form.
//   Trigger B — POST /api/auth/identify returns type:"multi_role"
//     → one button per roles[] entry.
//
// Routing per option:
//   super_admin   → router.push("/login/admin?email=<encoded>"), no default-login POST.
//   default_auth  → clears picker, shows the existing default-auth password form
//                   (which submits to /api/auth/default-login).
//   oidc          → storeOidcConfig + signinRedirect with login_hint=email.
//
// The page's network calls are stubbed at global.fetch (we assert on the calls
// the page makes); next-intl uses the real en.json so we assert on visible copy.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mockStoreOidcConfig = vi.hoisted(() => vi.fn());
const mockSigninRedirect = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined)
);
const mockCreateUserManager = vi.hoisted(() =>
  vi.fn(() => ({ signinRedirect: mockSigninRedirect }))
);
vi.mock("@/lib/oidc", () => ({
  storeOidcConfig: mockStoreOidcConfig,
  createUserManager: mockCreateUserManager,
}));

const mockRouterPush = vi.hoisted(() => vi.fn());
const mockRouterReplace = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockRouterPush, replace: mockRouterReplace }),
}));

vi.mock("@/lib/logger-client", () => ({
  clientLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

// Use real translations so the test asserts on user-visible copy.
vi.mock("next-intl", async () => {
  const en = (await import("../../../../messages/en.json")).default as Record<
    string,
    unknown
  >;
  function resolve(key: string): string {
    const parts = key.split(".");
    let node: unknown = en;
    for (const p of parts) {
      if (
        node &&
        typeof node === "object" &&
        p in (node as Record<string, unknown>)
      ) {
        node = (node as Record<string, unknown>)[p];
      } else {
        return key;
      }
    }
    return typeof node === "string" ? node : key;
  }
  const t = (key: string, values?: Record<string, unknown>) => {
    let out = resolve(key);
    if (values) {
      for (const [k, v] of Object.entries(values)) {
        out = out.replaceAll(`{${k}}`, String(v));
      }
    }
    return out;
  };
  return { useTranslations: () => t };
});

import LoginPage from "@/app/login/page";

const COMPANY_A = {
  uuid: "company-aaaa-0000-0000-000000000001",
  name: "Acme Inc",
  oidcIssuer: "https://auth.acme.com",
  oidcClientId: "client-acme-SECRET",
};

type FetchHandler = (
  url: string,
  init?: RequestInit
) => { ok: boolean; json: unknown };

// Install a fetch stub. `checkDefault` controls the page-load check-default
// response; `identify` (optional) controls the identify POST response.
function installFetch(handlers: {
  checkDefault: unknown;
  identify?: unknown;
  defaultLogin?: unknown;
}) {
  const impl: FetchHandler = (url) => {
    if (url === "/api/auth/check-default") {
      return { ok: true, json: handlers.checkDefault };
    }
    if (url === "/api/auth/identify") {
      return { ok: true, json: handlers.identify };
    }
    if (url === "/api/auth/default-login") {
      return {
        ok: true,
        json: handlers.defaultLogin ?? { success: true, data: {} },
      };
    }
    if (url === "/api/agents") {
      return { ok: true, json: { success: true, data: [] } };
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  };
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = typeof input === "string" ? input : String(input);
    const { json } = impl(u, init);
    return {
      ok: true,
      json: async () => json,
    } as Response;
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom has no localStorage default in some setups; guard it.
  const store: Record<string, string> = {};
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    clear: () => {
      for (const k of Object.keys(store)) delete store[k];
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("LoginPage role picker — Trigger A (check-default collision)", () => {
  it("renders the picker up front and does NOT show the default-auth password form", async () => {
    installFetch({
      checkDefault: {
        success: true,
        data: { enabled: true, superAdminCollision: true },
      },
    });

    render(<LoginPage />);

    // Picker title and both fixed options are visible.
    await waitFor(() => {
      expect(
        screen.getByText(
          "This email can sign in more than one way. Choose how to continue."
        )
      ).toBeTruthy();
    });
    expect(screen.getByText("Sign in as Super Admin")).toBeTruthy();
    expect(screen.getByText("Sign in with password")).toBeTruthy();

    // The default-auth password form must NOT be present (no password field).
    expect(screen.queryByLabelText("Password")).toBeNull();
  });

  it("super_admin option routes to /login/admin and never POSTs default-login", async () => {
    installFetch({
      checkDefault: {
        success: true,
        data: { enabled: true, superAdminCollision: true },
      },
    });

    render(<LoginPage />);

    await waitFor(() => {
      expect(screen.getByText("Sign in as Super Admin")).toBeTruthy();
    });

    await userEvent.click(
      screen.getByText("Sign in as Super Admin").closest("button")!
    );

    // In the up-front collision flow the page never learns the email
    // (check-default does not echo it), so it routes to /login/admin with an
    // empty email. The admin page then prompts for the email when no ?email=
    // param is present — see admin/page.test.tsx for the recovery path.
    expect(mockRouterPush).toHaveBeenCalledWith("/login/admin?email=");

    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(
      fetchMock.mock.calls.some(
        ([input]) => String(input) === "/api/auth/default-login"
      )
    ).toBe(false);
  });

  it("default_auth option reveals the existing password form that POSTs default-login", async () => {
    installFetch({
      checkDefault: {
        success: true,
        data: { enabled: true, superAdminCollision: true },
      },
      defaultLogin: { success: true, data: {} },
    });

    render(<LoginPage />);

    await waitFor(() => {
      expect(screen.getByText("Sign in with password")).toBeTruthy();
    });

    await userEvent.click(
      screen.getByText("Sign in with password").closest("button")!
    );

    // Now the default-auth password form is shown.
    const passwordField = await screen.findByLabelText("Password");
    expect(passwordField).toBeTruthy();
    expect(mockRouterPush).not.toHaveBeenCalled();

    // Submitting the form POSTs to /api/auth/default-login.
    await userEvent.type(screen.getByLabelText("Email"), "root@example.com");
    await userEvent.type(passwordField, "hunter2");
    await userEvent.click(screen.getByRole("button", { name: "Sign In" }));

    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            String(input) === "/api/auth/default-login" &&
            (init as RequestInit | undefined)?.method === "POST"
        )
      ).toBe(true);
    });
  });
});

describe("LoginPage role picker — Trigger B (identify multi_role)", () => {
  it("renders one button per roles[] entry after email submit", async () => {
    installFetch({
      // No default auth → page starts on the OIDC email form.
      checkDefault: { success: true, data: { enabled: false } },
      identify: {
        success: true,
        data: {
          type: "multi_role",
          roles: [{ kind: "super_admin" }, { kind: "oidc", company: COMPANY_A }],
        },
      },
    });

    render(<LoginPage />);

    // Email form is shown first (no default auth).
    const emailInput = await screen.findByPlaceholderText("you@company.com");
    await userEvent.type(emailInput, "boss@acme.com");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));

    // Picker now lists the super_admin option and the OIDC company option.
    await waitFor(() => {
      expect(screen.getByText("Sign in as Super Admin")).toBeTruthy();
    });
    expect(screen.getByText("Sign in with Acme Inc")).toBeTruthy();
  });

  it("oidc option starts signinRedirect for that company with login_hint=email", async () => {
    installFetch({
      checkDefault: { success: true, data: { enabled: false } },
      identify: {
        success: true,
        data: {
          type: "multi_role",
          roles: [{ kind: "super_admin" }, { kind: "oidc", company: COMPANY_A }],
        },
      },
    });

    render(<LoginPage />);

    const emailInput = await screen.findByPlaceholderText("you@company.com");
    await userEvent.type(emailInput, "boss@acme.com");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => {
      expect(screen.getByText("Sign in with Acme Inc")).toBeTruthy();
    });

    await userEvent.click(
      screen.getByText("Sign in with Acme Inc").closest("button")!
    );

    await waitFor(() => {
      expect(mockStoreOidcConfig).toHaveBeenCalledTimes(1);
    });
    expect(mockStoreOidcConfig).toHaveBeenCalledWith({
      issuer: COMPANY_A.oidcIssuer,
      clientId: COMPANY_A.oidcClientId,
      companyUuid: COMPANY_A.uuid,
      companyName: COMPANY_A.name,
    });
    expect(mockCreateUserManager).toHaveBeenCalledTimes(1);
    expect(mockSigninRedirect).toHaveBeenCalledWith({
      extraQueryParams: { login_hint: "boss@acme.com" },
    });
  });

  it("super_admin option routes to /login/admin with the typed email", async () => {
    installFetch({
      checkDefault: { success: true, data: { enabled: false } },
      identify: {
        success: true,
        data: {
          type: "multi_role",
          roles: [{ kind: "super_admin" }, { kind: "oidc", company: COMPANY_A }],
        },
      },
    });

    render(<LoginPage />);

    const emailInput = await screen.findByPlaceholderText("you@company.com");
    await userEvent.type(emailInput, "boss@acme.com");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => {
      expect(screen.getByText("Sign in as Super Admin")).toBeTruthy();
    });

    await userEvent.click(
      screen.getByText("Sign in as Super Admin").closest("button")!
    );

    expect(mockRouterPush).toHaveBeenCalledWith(
      `/login/admin?email=${encodeURIComponent("boss@acme.com")}`
    );
  });

  it("back affordance leaves the picker and restores the entry form", async () => {
    installFetch({
      checkDefault: { success: true, data: { enabled: false } },
      identify: {
        success: true,
        data: {
          type: "multi_role",
          roles: [{ kind: "super_admin" }, { kind: "oidc", company: COMPANY_A }],
        },
      },
    });

    render(<LoginPage />);

    const emailInput = await screen.findByPlaceholderText("you@company.com");
    await userEvent.type(emailInput, "boss@acme.com");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => {
      expect(screen.getByText("Sign in as Super Admin")).toBeTruthy();
    });

    // Click the picker's back link.
    await userEvent.click(screen.getByText("Use a different email"));

    // Picker gone, email entry form back.
    await waitFor(() => {
      expect(screen.queryByText("Sign in as Super Admin")).toBeNull();
    });
    expect(screen.getByPlaceholderText("you@company.com")).toBeTruthy();
  });
});
