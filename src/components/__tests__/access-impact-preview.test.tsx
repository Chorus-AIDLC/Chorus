// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { createTranslator, NextIntlClientProvider } from "next-intl";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../../../messages/en.json";
import zh from "../../../messages/zh.json";
import ja from "../../../messages/ja.json";
import ko from "../../../messages/ko.json";
import { AccessImpactPreview, type AccessImpact, type AccessImpactSummary } from "../access-impact-preview";

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
const zeroSummary: AccessImpactSummary = {
  affectedUserCount: 0, gainedAccessCount: 0, lostAccessCount: 0,
  increasedPermissionsCount: 0, decreasedPermissionsCount: 0, affectedProjectCount: 0,
};
const mixedPreview: AccessImpact = {
  confirmationToken: "unchanged-token",
  companyAccess: "closed",
  changes: changes.slice(0, 2),
  projects: [
    { projectUuid: "child-one", name: "Child Project One", companyAccess: "closed", changes },
    {
      projectUuid: "child-two", name: "Child Project Two", companyAccess: "unchanged",
      changes: [
        ...changes,
        { ...changes[0], beforeRole: "none", afterRole: "viewer" },
        { ...changes[0], beforeRole: "viewer", afterRole: "admin" },
        { ...changes[0], beforeRole: "admin", afterRole: "editor" },
      ],
    },
    { projectUuid: "child-visibility", name: "Visibility Only Child", companyAccess: "closed", changes: [] },
    {
      projectUuid: "child-unchanged", name: "Unchanged Child", companyAccess: "unchanged",
      changes: [{ ...changes[0], beforeRole: "admin", afterRole: "admin" }],
    },
  ],
};

function ok(data: AccessImpact) {
  return new Response(JSON.stringify({ success: true, data }));
}

function renderPreview(preview: AccessImpact, locale = "en", messages = en, kind: "project" | "group" = "project") {
  fetchMock.mockResolvedValue(ok(preview));
  const onLoaded = vi.fn();
  const result = render(<NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC">
    <AccessImpactPreview url="/api/access-preview" onLoaded={onLoaded} kind={kind} />
  </NextIntlClientProvider>);
  return { ...result, onLoaded };
}

function expectPrivateDataAbsent(container: HTMLElement, preview: AccessImpact) {
  expect(container.innerHTML).not.toContain(preview.confirmationToken);
  for (const subject of [preview, ...(preview.projects ?? [])]) {
    if ("projectUuid" in subject) expect(container.innerHTML).not.toContain(subject.projectUuid);
    if ("name" in subject) expect(container.innerHTML).not.toContain(subject.name);
    for (const change of subject.changes ?? []) {
      for (const value of [change.userUuid, change.name?.trim(), change.email?.trim()]) {
        if (value) expect(container.innerHTML).not.toContain(value);
      }
    }
  }
  expect(container.querySelector("[title], table, img, script")).toBeNull();
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

describe.each(locales)("$locale aggregate access impact", ({ locale, messages }) => {
  const t = createTranslator({ locale, messages, namespace: "accessImpact" });
  const expectCounts = (impact: HTMLElement, summary: AccessImpactSummary, kind: "project" | "group") => {
    expect(impact).toHaveTextContent(summary.affectedUserCount === 0
      ? t("noAffectedUsers") : t("affectedUsers", { count: summary.affectedUserCount }));
    const types = [
      ["gainedAccess", summary.gainedAccessCount],
      ["lostAccess", summary.lostAccessCount],
      ["increasedPermissions", summary.increasedPermissionsCount],
      ["decreasedPermissions", summary.decreasedPermissionsCount],
    ] as const;
    for (const [type, count] of types) {
      const text = t(`${kind}.${type}`, { count });
      if (count > 0) expect(impact).toHaveTextContent(text);
      else expect(impact).not.toHaveTextContent(text);
    }
    expect(impact).toHaveTextContent(t(`${kind}.affectedProjects`, { count: summary.affectedProjectCount }));
  };

  describe.each(["light", "dark"])("%s theme", (theme) => {
    beforeEach(() => document.documentElement.classList.toggle("dark", theme === "dark"));

    it("deduplicates users within each impact type and across projects in older payloads", async () => {
      const { container, onLoaded } = renderPreview(mixedPreview, locale, messages, "group");
      const impact = await screen.findByTestId("access-impact-preview");
      expectCounts(impact, {
        affectedUserCount: 7, gainedAccessCount: 2, lostAccessCount: 3,
        increasedPermissionsCount: 3, decreasedPermissionsCount: 2, affectedProjectCount: 3,
      }, "group");
      expect(impact).toHaveTextContent(messages.accessImpact.title);
      expect(impact).toHaveTextContent(messages.accessImpact.groupCompany.closed);
      expect(impact).toHaveTextContent(messages.accessImpact.overlapHint);
      expect(impact).not.toHaveTextContent(messages.accessImpact.company.closed);
      expectPrivateDataAbsent(container, mixedPreview);
      expect(onLoaded).toHaveBeenNthCalledWith(1, null);
      expect(onLoaded).toHaveBeenLastCalledWith(mixedPreview);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("prefers the server summary over the compatibility changes and projects", async () => {
      const preview: AccessImpact = {
        ...mixedPreview,
        summary: {
          affectedUserCount: 9, gainedAccessCount: 4, lostAccessCount: 6,
          increasedPermissionsCount: 1, decreasedPermissionsCount: 2, affectedProjectCount: 7,
        },
      };
      const { container, onLoaded } = renderPreview(preview, locale, messages, "group");
      const impact = await screen.findByTestId("access-impact-preview");
      expectCounts(impact, preview.summary!, "group");
      expect(impact).toHaveTextContent(messages.accessImpact.overlapHint);
      expectPrivateDataAbsent(container, preview);
      expect(onLoaded).toHaveBeenLastCalledWith(preview);
    });

    it("shows a clear zero-user message while retaining the company headline and changed project count", async () => {
      const preview: AccessImpact = {
        ...mixedPreview, summary: { ...zeroSummary, affectedProjectCount: 2 },
      };
      const { container } = renderPreview(preview, locale, messages, "group");
      const impact = await screen.findByTestId("access-impact-preview");
      expectCounts(impact, preview.summary!, "group");
      expect(impact).toHaveTextContent(messages.accessImpact.groupCompany.closed);
      expect(impact).not.toHaveTextContent(messages.accessImpact.overlapHint);
      expectPrivateDataAbsent(container, preview);
    });

    it("counts users losing group discovery even when the group has no children", async () => {
      const preview: AccessImpact = {
        confirmationToken: "empty-group-token", companyAccess: "closed", projects: [],
        summary: { ...zeroSummary, affectedUserCount: 2, lostAccessCount: 2 },
      };
      renderPreview(preview, locale, messages, "group");
      const impact = await screen.findByTestId("access-impact-preview");
      expectCounts(impact, preview.summary!, "group");
      expect(impact).toHaveTextContent(messages.accessImpact.groupCompany.closed);
      expect(impact).not.toHaveTextContent(messages.accessImpact.noAffectedUsers);
      expect(impact).not.toHaveTextContent(messages.accessImpact.overlapHint);
    });

    it("uses project wording and singular counts for a project role change", async () => {
      const preview: AccessImpact = {
        confirmationToken: "project-token", companyAccess: "unchanged", changes: [changes[0], changes[0]],
      };
      const { container } = renderPreview(preview, locale, messages);
      const impact = await screen.findByTestId("access-impact-preview");
      expectCounts(impact, { ...zeroSummary, affectedUserCount: 1, lostAccessCount: 1, affectedProjectCount: 1 }, "project");
      expect(impact).toHaveTextContent(messages.accessImpact.company.unchanged);
      expect(impact).not.toHaveTextContent(messages.accessImpact.overlapHint);
      expectPrivateDataAbsent(container, preview);
    });
  });
});

describe("preview loading and confirmation contracts", () => {
  it.each(["project", "group"] as const)("handles an unchanged legacy %s payload without invented impacts", async (kind) => {
    const preview: AccessImpact = {
      confirmationToken: "unchanged-token", companyAccess: "unchanged",
      changes: [{ ...changes[0], beforeRole: "admin", afterRole: "admin" }],
      projects: [{ projectUuid: "unchanged-child", name: "Unchanged Project", companyAccess: "unchanged", changes: [] }],
    };
    const { container } = renderPreview(preview, "en", en, kind);
    const impact = await screen.findByTestId("access-impact-preview");
    expect(impact).toHaveTextContent("No users are affected.");
    expect(impact).toHaveTextContent(kind === "group" ? "0 child projects affected." : "0 projects affected.");
    expectPrivateDataAbsent(container, preview);
  });

  it.each(["project", "group"] as const)("counts a visibility-only legacy %s change without affecting users", async (kind) => {
    const visibilityChange = { fromVisibility: "public", visibility: "private", changes: [] };
    const preview: AccessImpact = {
      confirmationToken: "visibility-only",
      ...(kind === "project" ? visibilityChange : {
        projects: [{ ...visibilityChange, projectUuid: "visibility-child", name: "Hidden Project" }],
      }),
    };
    renderPreview(preview, "en", en, kind);
    const impact = await screen.findByTestId("access-impact-preview");
    expect(impact).toHaveTextContent("No users are affected.");
    expect(impact).toHaveTextContent(kind === "group" ? "1 child project affected." : "1 project affected.");
  });

  it("preserves the exact original payload object and token without adding a derived summary", async () => {
    const preview = {
      ...mixedPreview, projectUuid: "root-project-uuid", name: "Root Project", extraField: "compatibility-data",
      changes: [{ ...changes[0], name: "<img src=x onerror=alert(1)>", email: "<script>alert(1)</script>" }],
    };
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ success: true, data: preview }) });
    const onLoaded = vi.fn();
    render(<NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <AccessImpactPreview url="/api/access-preview" onLoaded={onLoaded} />
    </NextIntlClientProvider>);
    const impact = await screen.findByTestId("access-impact-preview");
    expect(onLoaded.mock.calls.at(-1)?.[0]).toBe(preview);
    expect(preview).not.toHaveProperty("summary");
    expectPrivateDataAbsent(impact, preview);
  });

  it.each([
    { status: 403, success: false, data: mixedPreview },
    { status: 200, success: false, data: mixedPreview },
    { status: 200, success: true, data: { ...mixedPreview, confirmationToken: "" } },
  ])("withholds the preview and token for an invalid response ($status/$success)", async (body) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status: body.status }));
    const onLoaded = vi.fn();
    const { container } = render(<NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <AccessImpactPreview url="/api/access-preview" onLoaded={onLoaded} />
    </NextIntlClientProvider>);
    expect(await screen.findByRole("alert")).toHaveTextContent(en.accessImpact.loadFailed);
    expect(screen.queryByTestId("access-impact-preview")).not.toBeInTheDocument();
    expectPrivateDataAbsent(container, mixedPreview);
    expect(onLoaded).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("keeps the token unavailable during loading and retries a failed preview", async () => {
    let resolveResponse!: (response: Response) => void;
    fetchMock.mockRejectedValueOnce(new Error("offline")).mockImplementationOnce(() =>
      new Promise<Response>((resolve) => { resolveResponse = resolve; }));
    const onLoaded = vi.fn();
    render(<NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <AccessImpactPreview url="/api/access-preview" onLoaded={onLoaded} />
    </NextIntlClientProvider>);
    expect(await screen.findByRole("alert")).toHaveTextContent(en.accessImpact.loadFailed);
    fireEvent.click(screen.getByRole("button", { name: en.accessImpact.retry }));
    expect(screen.getByRole("status")).toHaveTextContent(en.accessImpact.loading);
    expect(onLoaded.mock.calls).toEqual([[null], [null]]);
    resolveResponse(ok(mixedPreview));
    await screen.findByTestId("access-impact-preview");
    expect(onLoaded).toHaveBeenLastCalledWith(mixedPreview);
    expect(fetchMock.mock.calls).toEqual([["/api/access-preview"], ["/api/access-preview"]]);
  });

  it("discards a stale URL response and releases only the current preview token", async () => {
    let resolveOld!: (response: Response) => void;
    let resolveCurrent!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveOld = resolve; }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveCurrent = resolve; }));
    const onLoaded = vi.fn();
    const element = (url: string) => <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <AccessImpactPreview url={url} onLoaded={onLoaded} />
    </NextIntlClientProvider>;
    const { rerender } = render(element("/api/old-preview"));
    expect(screen.getByRole("status")).toBeInTheDocument();
    rerender(element("/api/current-preview"));
    resolveCurrent(ok({ confirmationToken: "current-token", summary: zeroSummary }));
    await screen.findByTestId("access-impact-preview");
    await act(async () => { resolveOld(ok(mixedPreview)); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onLoaded.mock.calls).toEqual([[null], [null], [{ confirmationToken: "current-token", summary: zeroSummary }]]);
    expect(screen.getByTestId("access-impact-preview")).toHaveTextContent(en.accessImpact.noAffectedUsers);
  });
});
