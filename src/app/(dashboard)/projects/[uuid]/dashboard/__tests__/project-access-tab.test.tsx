// @vitest-environment jsdom
//
// Access tab of the project settings modal: visibility switch with confirmation,
// member table (role change / remove), add-member picker, last-admin error, and
// the read-only view for non-admins. Translations resolve against the real
// en.json so missing keys surface as raw key paths.

import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { toastSuccess, toastError } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: toastError } }));

vi.mock("next-intl", async () => {
  const en = (await import("../../../../../../../messages/en.json")).default;
  const { createTranslator } = await vi.importActual<typeof import("next-intl")>("next-intl");
  const cache = new Map<string, (key: string, values?: Record<string, unknown>) => string>();
  return {
    useTranslations: (ns = "") => {
      let fn = cache.get(ns);
      if (!fn) {
        const translate = createTranslator({
          locale: "en", messages: en as import("next-intl").AbstractIntlMessages, namespace: ns,
        }) as (key: string, values?: Record<string, string | number | Date>) => string;
        fn = (key, values) => translate(key, values as Record<string, string | number | Date> | undefined);
        cache.set(ns, fn);
      }
      return fn;
    },
  };
});

// jsdom gaps needed by Radix Select / Popover and cmdk.
class MockPointerEvent extends Event {
  button: number;
  ctrlKey: boolean;
  pointerType: string;
  constructor(type: string, props: PointerEventInit = {}) {
    super(type, props);
    this.button = props.button ?? 0;
    this.ctrlKey = props.ctrlKey ?? false;
    this.pointerType = props.pointerType ?? "mouse";
  }
}
Object.assign(window, { PointerEvent: MockPointerEvent });
Object.assign(window.HTMLElement.prototype, {
  hasPointerCapture: vi.fn(),
  releasePointerCapture: vi.fn(),
  scrollIntoView: vi.fn(),
});
Object.assign(window, {
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
});

import { ProjectAccessTab, accessErrorKey } from "../project-access-tab";

const PROJECT = "project-1";
const MEMBERS = [
  { uuid: "m1", userUuid: "u-alice", name: "Alice", email: "alice@x.com", role: "admin", createdAt: "2026-01-01" },
  { uuid: "m2", userUuid: "u-bob", name: "Bob", email: "bob@x.com", role: "editor", createdAt: "2026-01-02" },
];

type Handler = (init?: RequestInit) => { status?: number; body: unknown };
let routes: Record<string, Handler>;
const fetchMock = vi.fn();

function ok(data: unknown) {
  return { body: { success: true, data } };
}

beforeEach(() => {
  vi.clearAllMocks();
  routes = {
    [`GET /api/projects/${PROJECT}/members`]: () => ok({ members: MEMBERS }),
    [`GET /api/projects/${PROJECT}/access-preview`]: () => ok({
      confirmationToken: "preview-token",
      companyAccess: "closed",
      changes: [{ userUuid: "u-outsider", beforeRole: "editor", afterRole: "none" }],
    }),
    [`PATCH /api/projects/${PROJECT}`]: () => ok({ visibility: "private" }),
    [`POST /api/projects/${PROJECT}/members`]: () => ok({ uuid: "m3", userUuid: "u-carol", role: "viewer" }),
    [`PATCH /api/projects/${PROJECT}/members/u-bob`]: () => ok({ uuid: "m2", userUuid: "u-bob", role: "viewer" }),
    [`DELETE /api/projects/${PROJECT}/members/u-bob`]: () => {
      routes[`GET /api/projects/${PROJECT}/members`] = () => ok({ members: MEMBERS.slice(0, 1) });
      return ok({ removed: true });
    },
    "GET /api/mentionables": () => ok([
      { type: "user", uuid: "u-alice", name: "Alice", email: "alice@x.com" },
      { type: "user", uuid: "u-carol", name: "Carol", email: "carol@x.com" },
      { type: "agent", uuid: "a-1", name: "Carol's agent" },
    ]),
  };
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url.split("?")[0]}`;
    const handler = routes[key];
    if (!handler) throw new Error(`Unexpected fetch ${key}`);
    const { status = 200, body } = handler(init);
    return new Response(JSON.stringify(body), { status });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderTab(props: Partial<React.ComponentProps<typeof ProjectAccessTab>> = {}) {
  const onVisibilityChange = vi.fn();
  const utils = render(
    <ProjectAccessTab
      projectUuid={PROJECT}
      visibility="public"
      accessLevel="admin"
      onVisibilityChange={onVisibilityChange}
      {...props}
    />,
  );
  return { ...utils, onVisibilityChange };
}

function callsTo(method: string, url: string) {
  return fetchMock.mock.calls.filter(([u, init]) =>
    (init?.method ?? "GET") === method && String(u).split("?")[0] === url);
}

describe("ProjectAccessTab", () => {
  it("shows admin controls to explicit admins", async () => {
    renderTab();
    expect(await screen.findByText("Alice")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Public/ })).toBeEnabled();
    expect(screen.getByRole("radio", { name: /^Private/ })).toBeEnabled();
    expect(screen.getByRole("combobox", { name: "Role for Bob" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Bob" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Select a user" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    expect(screen.queryByText(/Only project admins can change visibility/)).not.toBeInTheDocument();
  });

  it.each(["viewer", "editor"] as const)("is read-only for a %s, but still lists members", async (accessLevel) => {
    renderTab({ accessLevel, visibility: "private" });
    expect(await screen.findByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
    expect(screen.getByText("Only project admins can change visibility or manage members.")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Public/ })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /^Private/ })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Remove/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add" })).not.toBeInTheDocument();
    // Roles render as read-only labels.
    expect(screen.getByText("Admin")).toBeInTheDocument();
    expect(screen.getByText("Editor")).toBeInTheDocument();
  });

  it("confirms public -> private and PATCHes visibility on confirm", async () => {
    const user = userEvent.setup();
    const { onVisibilityChange } = renderTab();
    await screen.findByText("Alice");
    await user.click(screen.getByRole("radio", { name: /^Private/ }));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Make this project private?")).toBeInTheDocument();
    expect(within(dialog).getByText(/Only the members listed on this project/)).toBeInTheDocument();
    expect(callsTo("PATCH", `/api/projects/${PROJECT}`)).toHaveLength(0);

    await user.click(within(dialog).getByRole("button", { name: "Change visibility" }));
    await waitFor(() => expect(onVisibilityChange).toHaveBeenCalledWith("private"));
    const [[, init]] = callsTo("PATCH", `/api/projects/${PROJECT}`);
    expect(JSON.parse(init.body)).toEqual({ visibility: "private", confirmationToken: "preview-token" });
    expect(callsTo("GET", `/api/projects/${PROJECT}/access-preview`)).toHaveLength(1);
    expect(toastSuccess).toHaveBeenCalledWith("Project visibility updated");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });

  it("explains private -> public and does nothing when cancelled", async () => {
    const user = userEvent.setup();
    const { onVisibilityChange } = renderTab({ visibility: "private" });
    await screen.findByText("Alice");
    await user.click(screen.getByRole("radio", { name: /Public/ }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/Everyone in the company \(and their agents\) will gain access/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(callsTo("PATCH", `/api/projects/${PROJECT}`)).toHaveLength(0);
    expect(onVisibilityChange).not.toHaveBeenCalled();
  });

  it("toasts a localized error when the visibility PATCH is forbidden", async () => {
    routes[`PATCH /api/projects/${PROJECT}`] = () => ({
      status: 403, body: { success: false, error: { code: "FORBIDDEN", message: "nope" } },
    });
    const user = userEvent.setup();
    const { onVisibilityChange } = renderTab();
    await screen.findByText("Alice");
    await user.click(screen.getByRole("radio", { name: /^Private/ }));
    await user.click(await screen.findByRole("button", { name: "Change visibility" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(
      "You don't have permission to manage access for this project.",
    ));
    expect(onVisibilityChange).not.toHaveBeenCalled();
  });

  it("adds a company user who is not yet a member", async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByText("Alice");
    routes[`GET /api/projects/${PROJECT}/members`] = () => ok({
      members: [...MEMBERS, { uuid: "m3", userUuid: "u-carol", name: "Carol", email: "carol@x.com", role: "admin", createdAt: "2026-01-03" }],
    });

    await user.click(screen.getByRole("combobox", { name: "Select a user" }));
    await user.type(screen.getByPlaceholderText("Search by name or email..."), "a");
    const carol = await screen.findByRole("option", { name: /Carol/ });
    // Existing members and agents are excluded from the picker.
    expect(screen.queryByRole("option", { name: /Alice/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /agent/ })).not.toBeInTheDocument();
    await user.click(carol);

    await user.click(screen.getByRole("combobox", { name: "Role for new member" }));
    await user.click(await screen.findByRole("option", { name: "Admin" }));
    await user.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(callsTo("POST", `/api/projects/${PROJECT}/members`)).toHaveLength(1));
    const [[, init]] = callsTo("POST", `/api/projects/${PROJECT}/members`);
    expect(JSON.parse(init.body)).toEqual({ userUuid: "u-carol", role: "admin" });
    expect(await screen.findByText("carol@x.com")).toBeInTheDocument();
    expect(toastSuccess).toHaveBeenCalledWith("Member added");
  });

  it("PATCHes a member's role when changed", async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByText("Bob");
    await user.click(screen.getByRole("combobox", { name: "Role for Bob" }));
    await user.click(await screen.findByRole("option", { name: "Viewer" }));
    await waitFor(() => expect(callsTo("PATCH", `/api/projects/${PROJECT}/members/u-bob`)).toHaveLength(1));
    const [[, init]] = callsTo("PATCH", `/api/projects/${PROJECT}/members/u-bob`);
    expect(JSON.parse(init.body)).toEqual({ role: "viewer" });
    expect(toastSuccess).toHaveBeenCalledWith("Member role updated");
  });

  it("DELETEs a member on remove and asks the parent to re-read access", async () => {
    const user = userEvent.setup();
    const onMembersChanged = vi.fn();
    renderTab({ onMembersChanged });
    await screen.findByText("Bob");
    await user.click(screen.getByRole("button", { name: "Remove Bob" }));
    await waitFor(() => expect(callsTo("DELETE", `/api/projects/${PROJECT}/members/u-bob`)).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText("Bob")).not.toBeInTheDocument());
    // An admin may have changed their own access; the settings modal re-fetches it.
    expect(onMembersChanged).toHaveBeenCalledTimes(1);
  });

  it("shows the localized last-admin error inline", async () => {
    routes[`DELETE /api/projects/${PROJECT}/members/u-bob`] = () => ({
      status: 400,
      body: { success: false, error: { code: "BAD_REQUEST", message: "A project must keep at least one admin" } },
    });
    const user = userEvent.setup();
    renderTab();
    await screen.findByText("Bob");
    await user.click(screen.getByRole("button", { name: "Remove Bob" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A project must keep at least one admin.");
    expect(screen.getByText("Bob")).toBeInTheDocument();
  });

  it("uses semantic tokens / dark variants only (no light-only palette classes)", async () => {
    const { container } = renderTab();
    await screen.findByText("Alice");
    const classes = Array.from(container.querySelectorAll<HTMLElement>("[class]"))
      .flatMap((el) => el.getAttribute("class")!.split(/\s+/));
    const lightOnly = /^(?:hover:|focus:)?(?:bg|text|border|ring)-(?:\[#[0-9a-fA-F]+\]|(?:white|black|gray|slate|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(?:-\d+)?)$/;
    const offenders = classes.filter((c) => lightOnly.test(c));
    expect(offenders).toEqual([]);
  });

  it("publishes a private project only with the loaded confirmation token", async () => {
    const user = userEvent.setup();
    const { onVisibilityChange } = renderTab({ visibility: "private" });
    await screen.findByText("Alice");
    await user.click(screen.getByRole("radio", { name: /Public/ }));
    await screen.findByTestId("access-impact-preview");
    expect(callsTo("PATCH", `/api/projects/${PROJECT}`)).toHaveLength(0);
    expect(fetchMock.mock.calls.some(([url]) => url === `/api/projects/${PROJECT}/access-preview?visibility=public`)).toBe(true);
    await user.click(screen.getByRole("button", { name: "Change visibility" }));
    await waitFor(() => expect(onVisibilityChange).toHaveBeenCalledWith("public"));
    expect(JSON.parse(callsTo("PATCH", `/api/projects/${PROJECT}`)[0][1].body)).toEqual({
      visibility: "public", confirmationToken: "preview-token",
    });
  });

  it("does not offer publication inside a Private group", async () => {
    renderTab({ visibility: "private", publicAllowed: false });
    await screen.findByText("Alice");
    expect(screen.getByRole("radio", { name: /^Public/ })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /^Private/ })).toBeEnabled();
    expect(callsTo("GET", `/api/projects/${PROJECT}/access-preview`)).toHaveLength(0);
  });

  it("keeps confirmation disabled while the preview is pending", async () => {
    const normalFetch = fetchMock.getMockImplementation()!;
    let resolve!: (value: Response) => void;
    const pending = new Promise<Response>((done) => { resolve = done; });
    fetchMock.mockImplementation((url, init) => String(url).includes("access-preview") ? pending : normalFetch(url, init));
    const user = userEvent.setup();
    renderTab();
    await screen.findByText("Alice");
    await user.click(screen.getByRole("radio", { name: /^Private/ }));
    expect(screen.getByRole("button", { name: "Change visibility" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Loading current access changes");
    expect(callsTo("PATCH", `/api/projects/${PROJECT}`)).toHaveLength(0);
    resolve(new Response(JSON.stringify({ success: true, data: { confirmationToken: "fresh" } })));
    await waitFor(() => expect(screen.getByRole("button", { name: "Change visibility" })).toBeEnabled());
  });

  it("shows preview failure and retries before enabling confirmation", async () => {
    routes[`GET /api/projects/${PROJECT}/access-preview`] = () => ({ status: 403, body: { success: false } });
    const user = userEvent.setup();
    renderTab();
    await screen.findByText("Alice");
    await user.click(screen.getByRole("radio", { name: /^Private/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("preview could not be loaded");
    expect(screen.getByRole("button", { name: "Change visibility" })).toBeDisabled();
    routes[`GET /api/projects/${PROJECT}/access-preview`] = () => ok({ confirmationToken: "retry-token" });
    await user.click(screen.getByRole("button", { name: "Retry preview" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Change visibility" })).toBeEnabled());
    expect(callsTo("PATCH", `/api/projects/${PROJECT}`)).toHaveLength(0);
  });

  it("requires a fresh preview and a second explicit confirmation after a conflict", async () => {
    routes[`PATCH /api/projects/${PROJECT}`] = () => {
      routes[`GET /api/projects/${PROJECT}/access-preview`] = () => ok({ confirmationToken: "new-token" });
      return { status: 409, body: { success: false, error: { code: "CONFLICT" } } };
    };
    const user = userEvent.setup();
    const { onVisibilityChange } = renderTab({ visibility: "private" });
    await screen.findByText("Alice");
    await user.click(screen.getByRole("radio", { name: /Public/ }));
    await screen.findByTestId("access-impact-preview");
    await user.click(screen.getByRole("button", { name: "Change visibility" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Access changed");
    await waitFor(() => expect(callsTo("GET", `/api/projects/${PROJECT}/access-preview`)).toHaveLength(2));
    expect(callsTo("PATCH", `/api/projects/${PROJECT}`)).toHaveLength(1);
    expect(onVisibilityChange).not.toHaveBeenCalled();
    routes[`PATCH /api/projects/${PROJECT}`] = () => ok({});
    await waitFor(() => expect(screen.getByRole("button", { name: "Change visibility" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Change visibility" }));
    await waitFor(() => expect(onVisibilityChange).toHaveBeenCalledWith("public"));
    expect(JSON.parse(callsTo("PATCH", `/api/projects/${PROJECT}`)[1][1].body).confirmationToken).toBe("new-token");
  });

  it("labels inherited-only grants and offers neither local downgrade nor removal", async () => {
    routes[`GET /api/projects/${PROJECT}/members`] = () => ok({ members: [
      { ...MEMBERS[0], source: "group", directRole: null, inheritedRole: "admin", effectiveRole: "admin" },
    ] });
    renderTab({ visibility: "private" });
    await screen.findByText("Alice");
    expect(screen.getByText(/Inherited from group/)).toBeInTheDocument();
    expect(screen.getByText("Effective: Admin")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Role for Alice" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove Alice" })).not.toBeInTheDocument();
  });

  it("disables local roles below inheritance and preserves inherited access when removing a direct grant", async () => {
    const row = { ...MEMBERS[1], role: "admin", source: "both", directRole: "admin", inheritedRole: "editor", effectiveRole: "admin" };
    routes[`GET /api/projects/${PROJECT}/members`] = () => ok({ members: [row] });
    routes[`DELETE /api/projects/${PROJECT}/members/u-bob`] = () => {
      routes[`GET /api/projects/${PROJECT}/members`] = () => ok({ members: [{
        ...row, source: "group", role: "editor", directRole: null, effectiveRole: "editor",
      }] });
      return ok({});
    };
    const user = userEvent.setup();
    renderTab({ visibility: "private" });
    await screen.findByText("Bob");
    expect(screen.getByText(/Direct \+ inherited/)).toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: "Role for Bob" }));
    expect(await screen.findByRole("option", { name: "Viewer" })).toHaveAttribute("aria-disabled", "true");
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Remove Bob" }));
    expect(await screen.findByText("Effective: Editor")).toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove Bob" })).not.toBeInTheDocument();
  });

  it("allows adding a higher local grant for an inherited group Viewer", async () => {
    routes[`GET /api/projects/${PROJECT}/members`] = () => ok({ members: [
      { ...MEMBERS[1], role: "viewer", source: "group", directRole: null, inheritedRole: "viewer", effectiveRole: "viewer" },
    ] });
    routes["GET /api/mentionables"] = () => ok([{ type: "user", uuid: "u-bob", name: "Bob" }]);
    const user = userEvent.setup();
    renderTab({ visibility: "private" });
    await screen.findByText("Bob");
    await user.click(screen.getByRole("combobox", { name: "Select a user" }));
    await user.type(screen.getByPlaceholderText("Search by name or email..."), "Bob");
    await user.click(await screen.findByRole("option", { name: "Bob" }));
    await user.click(screen.getByRole("combobox", { name: "Role for new member" }));
    expect(await screen.findByRole("option", { name: "Viewer" })).toHaveAttribute("aria-disabled", "true");
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(callsTo("POST", `/api/projects/${PROJECT}/members`)).toHaveLength(1));
    expect(JSON.parse(callsTo("POST", `/api/projects/${PROJECT}/members`)[0][1].body)).toEqual({
      userUuid: "u-bob", role: "editor",
    });
  });

  it("gives a group Viewer a read-only roster", async () => {
    routes[`GET /api/project-groups/${PROJECT}/members`] = () => ok({ members: MEMBERS });
    renderTab({ resourceType: "project-groups", accessLevel: "viewer" });
    await screen.findByText("Alice");
    expect(screen.getByText("Only group Admins can change visibility or manage members.")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Public/ })).toBeDisabled();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Remove/ })).not.toBeInTheDocument();
  });

  it("never fetches the group roster for a basic visitor", async () => {
    renderTab({ resourceType: "project-groups", accessLevel: "viewer", canReadMembers: false });
    expect(screen.queryByText("Members")).not.toBeInTheDocument();
    expect(callsTo("GET", `/api/project-groups/${PROJECT}/members`)).toHaveLength(0);
  });

  it("confirms a group conversion with impact counts and the current token", async () => {
    routes[`GET /api/project-groups/${PROJECT}/members`] = () => ok({ members: MEMBERS });
    routes[`GET /api/project-groups/${PROJECT}/access-preview`] = () => ok({
      confirmationToken: "group-token", companyAccess: "closed",
      summary: {
        affectedUserCount: 2, lostAccessCount: 2, gainedAccessCount: 0,
        increasedPermissionsCount: 0, decreasedPermissionsCount: 0, affectedProjectCount: 1,
      },
      projects: [{ projectUuid: "child", name: "Public child", companyAccess: "closed", changes: [] }],
    });
    routes[`PATCH /api/project-groups/${PROJECT}`] = () => ok({});
    const user = userEvent.setup();
    renderTab({ resourceType: "project-groups" });
    await screen.findByText("Alice");
    await user.click(screen.getByRole("radio", { name: /^Private/ }));
    const impact = await screen.findByTestId("access-impact-preview");
    expect(impact).toHaveTextContent("2 users affected.");
    expect(impact).toHaveTextContent("2 users lose access to the group or a child project.");
    expect(impact).toHaveTextContent("1 child project affected.");
    expect(within(impact).queryByText("Public child")).not.toBeInTheDocument();
    expect(screen.getByText(/All public projects in this group will become private/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Change visibility" }));
    await waitFor(() => expect(callsTo("PATCH", `/api/project-groups/${PROJECT}`)).toHaveLength(1));
    expect(JSON.parse(callsTo("PATCH", `/api/project-groups/${PROJECT}`)[0][1].body)).toEqual({
      visibility: "private", confirmationToken: "group-token",
    });
  });
});

describe("accessErrorKey", () => {
  it("maps API failures to localized keys", () => {
    expect(accessErrorKey({ status: 400, message: "A project must keep at least one admin" })).toBe("errors.lastAdmin");
    expect(accessErrorKey({ status: 409, code: "CONFLICT" })).toBe("errors.alreadyMember");
    expect(accessErrorKey({ status: 400, message: "User not found in this company" })).toBe("errors.notInCompany");
    expect(accessErrorKey({ status: 403 })).toBe("errors.forbidden");
    expect(accessErrorKey({ status: 422 })).toBe("errors.invalid");
    expect(accessErrorKey({ status: 0 })).toBe("errors.generic");
  });
});
