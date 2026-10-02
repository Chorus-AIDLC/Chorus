// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { NextIntlClientProvider } from "next-intl";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../../../messages/en.json";
import zh from "../../../messages/zh.json";
import ja from "../../../messages/ja.json";
import ko from "../../../messages/ko.json";
import { AccessImpactPreview, type AccessImpact } from "../access-impact-preview";

const locales = [{ locale: "en", messages: en }, { locale: "zh", messages: zh }, { locale: "ja", messages: ja }, { locale: "ko", messages: ko }];
const fetchMock = vi.fn();
const changes = [
  { userUuid: "uuid-alex-one", name: "Alex Example", email: "alex.one@example.com", beforeRole: "editor", afterRole: "none" },
  { userUuid: "uuid-alex-two", name: "Alex Example", email: "alex.two@example.com", beforeRole: "viewer", afterRole: "editor" },
  { userUuid: "uuid-email", name: "  ", email: "email.only@example.com", beforeRole: "none", afterRole: "viewer" },
  { userUuid: "uuid-name", name: "Name Only", email: null, beforeRole: "admin", afterRole: "editor" },
  { userUuid: "uuid-null", name: null, email: null, beforeRole: "editor", afterRole: "none" },
  { userUuid: "uuid-legacy", beforeRole: "viewer", afterRole: "admin" },
  { userUuid: "uuid-blank", name: " \t ", email: "  ", beforeRole: "viewer", afterRole: "none" },
];

function ok(data: AccessImpact) {
  return new Response(JSON.stringify({ success: true, data }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.documentElement.classList.remove("dark");
});

describe.each(locales)("$locale access impact identities", ({ locale, messages }) => {
  it.each(["light", "dark"])("identifies users and localizes role changes in the %s theme", async (theme) => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    const preview: AccessImpact = {
      confirmationToken: "unchanged-token", companyAccess: "closed",
      changes: changes.slice(0, 2),
      projects: [{ projectUuid: "child", name: "Child Project", companyAccess: "closed", changes: changes.slice(2) }],
    };
    fetchMock.mockResolvedValue(ok(preview));
    const onLoaded = vi.fn();
    render(<NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC">
      <AccessImpactPreview url="/api/access-preview" onLoaded={onLoaded} kind="group" />
    </NextIntlClientProvider>);

    const impact = await screen.findByTestId("access-impact-preview");
    const rows = within(impact).getAllByRole("listitem");
    const identities = [
      "Alex Example (alex.one@example.com)", "Alex Example (alex.two@example.com)",
      "email.only@example.com", "Name Only", "uuid-null", "uuid-legacy", "uuid-blank",
    ];
    rows.forEach((row, index) => {
      const change = changes[index];
      const roles = messages.accessImpact.roles as Record<string, string>;
      expect(row).toHaveTextContent(`${identities[index]}: ${roles[change.beforeRole]} → ${roles[change.afterRole]}`);
      expect(row).toHaveAttribute("title", change.userUuid);
    });
    expect(impact).toHaveTextContent(messages.accessImpact.title);
    expect(impact).toHaveTextContent(messages.accessImpact.groupCompany.closed);
    expect(impact).toHaveTextContent(messages.accessImpact.company.closed);
    expect(impact).not.toHaveTextContent("uuid-alex-one");
    expect(onLoaded).toHaveBeenNthCalledWith(1, null);
    expect(onLoaded).toHaveBeenLastCalledWith(preview);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("access impact identity safety", () => {
  it("renders display identities as text while preserving the server token", async () => {
    const preview: AccessImpact = {
      confirmationToken: "server-token",
      changes: [{ userUuid: "uuid-safe", name: "<img src=x onerror=alert(1)>", email: "<script>alert(1)</script>", beforeRole: "editor", afterRole: "none" }],
    };
    fetchMock.mockResolvedValue(ok(preview));
    const onLoaded = vi.fn();
    render(<NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <AccessImpactPreview url="/api/access-preview" onLoaded={onLoaded} />
    </NextIntlClientProvider>);
    const impact = await screen.findByTestId("access-impact-preview");
    expect(impact).toHaveTextContent("<img src=x onerror=alert(1)> (<script>alert(1)</script>)");
    expect(impact.querySelector("img, script")).toBeNull();
    expect(onLoaded).toHaveBeenLastCalledWith(preview);
  });

  it("does not render identities or release a token when the authorized preview fails", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      success: false, data: { confirmationToken: "untrusted-token", changes },
    }), { status: 403 }));
    const onLoaded = vi.fn();
    render(<NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <AccessImpactPreview url="/api/access-preview" onLoaded={onLoaded} />
    </NextIntlClientProvider>);
    expect(await screen.findByRole("alert")).toHaveTextContent(en.accessImpact.loadFailed);
    expect(screen.queryByText(/Alex Example/)).not.toBeInTheDocument();
    expect(onLoaded).toHaveBeenCalledExactlyOnceWith(null);
  });
});
