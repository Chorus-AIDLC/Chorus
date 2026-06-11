// @vitest-environment jsdom
// Integration test for the Super Admin password login page. The key scenario is
// the up-front collision flow (login page Trigger A): the super admin lands on
// /login/admin WITHOUT an ?email= param, because /api/auth/check-default never
// echoes the email. The page must then let them type the email and authenticate
// — otherwise the headline use case (DEFAULT_USER == SUPER_ADMIN_EMAIL) is a
// dead end. We also cover the param case (email shown read-only).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mockRouterPush = vi.hoisted(() => vi.fn());
const mockSearchParamsGet = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockRouterPush }),
  useSearchParams: () => ({ get: mockSearchParamsGet }),
}));

// next/link renders its children; we only need the anchor for the back link.
vi.mock("next/link", () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));

// Use real translations so the test asserts on user-visible copy.
vi.mock("next-intl", async () => {
  const en = (await import("../../../../../messages/en.json")).default as Record<
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

import AdminLoginPage from "@/app/login/admin/page";

function installFetch(adminLogin: unknown) {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = typeof input === "string" ? input : String(input);
    if (u === "/api/admin/login") {
      return { ok: true, json: async () => adminLogin } as Response;
    }
    throw new Error(`Unexpected fetch in test: ${u}`);
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AdminLoginPage — no ?email= param (up-front collision landing)", () => {
  it("prompts for the email and authenticates via /api/admin/login", async () => {
    mockSearchParamsGet.mockReturnValue(null);
    installFetch({ success: true, data: { redirectTo: "/admin" } });

    render(<AdminLoginPage />);

    // An editable email field is shown (it was NOT supplied by the previous screen).
    const emailField = await screen.findByLabelText("Email");
    expect(emailField).toBeTruthy();

    await userEvent.type(emailField, "root@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "hunter2");
    await userEvent.click(
      screen.getByRole("button", { name: "Sign In as Super Admin" })
    );

    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([input]) => String(input) === "/api/admin/login"
      );
      expect(call).toBeTruthy();
      // The typed email — not an empty string — is sent to the endpoint.
      const body = JSON.parse((call![1] as RequestInit).body as string);
      expect(body.email).toBe("root@example.com");
      expect(body.password).toBe("hunter2");
    });

    // On success the page redirects to the admin dashboard.
    await waitFor(() => {
      expect(mockRouterPush).toHaveBeenCalledWith("/admin");
    });
  });
});

describe("AdminLoginPage — with ?email= param", () => {
  it("shows the email read-only and does not render an email input", async () => {
    mockSearchParamsGet.mockReturnValue("boss@acme.com");
    installFetch({ success: true, data: { redirectTo: "/admin" } });

    render(<AdminLoginPage />);

    // Email appears as read-only text; there is no editable Email field.
    await waitFor(() => {
      expect(screen.getByText("boss@acme.com")).toBeTruthy();
    });
    expect(screen.queryByLabelText("Email")).toBeNull();

    // Submitting still sends the param email.
    await userEvent.type(screen.getByLabelText("Password"), "hunter2");
    await userEvent.click(
      screen.getByRole("button", { name: "Sign In as Super Admin" })
    );

    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([input]) => String(input) === "/api/admin/login"
      );
      expect(call).toBeTruthy();
      const body = JSON.parse((call![1] as RequestInit).body as string);
      expect(body.email).toBe("boss@acme.com");
    });
  });
});
