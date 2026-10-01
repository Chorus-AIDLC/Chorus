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
  const en = (await import("../../../../../../../messages/en.json")).default as Record<string, unknown>;
  const resolve = (ns: string, key: string) => {
    let node: unknown = en;
    for (const p of (ns ? `${ns}.${key}` : key).split(".")) {
      node = node && typeof node === "object" ? (node as Record<string, unknown>)[p] : undefined;
    }
    return typeof node === "string" ? node : `${ns ? `${ns}.` : ""}${key}`;
  };
  const cache = new Map<string, (key: string, values?: Record<string, unknown>) => string>();
  return {
    useTranslations: (ns = "") => {
      let fn = cache.get(ns);
      if (!fn) {
        fn = (key, values) => resolve(ns, key).replace(/\{(\w+)\}/g, (_, n) =>
          values && n in values ? String(values[n]) : `{${n}}`);
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
    [`PATCH /api/projects/${PROJECT}`]: () => ok({ visibility: "private" }),
    [`POST /api/projects/${PROJECT}/members`]: () => ok({ uuid: "m3", userUuid: "u-carol", role: "viewer" }),
    [`PATCH /api/projects/${PROJECT}/members/u-bob`]: () => ok({ uuid: "m2", userUuid: "u-bob", role: "viewer" }),
    [`DELETE /api/projects/${PROJECT}/members/u-bob`]: () => ok({ removed: true }),
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
    expect(screen.getByRole("radio", { name: /Private/ })).toBeEnabled();
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
    expect(screen.getByRole("radio", { name: /Private/ })).toBeDisabled();
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
    await user.click(screen.getByRole("radio", { name: /Private/ }));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Make this project private?")).toBeInTheDocument();
    expect(within(dialog).getByText(/Only the members listed on this project/)).toBeInTheDocument();
    expect(callsTo("PATCH", `/api/projects/${PROJECT}`)).toHaveLength(0);

    await user.click(within(dialog).getByRole("button", { name: "Change visibility" }));
    await waitFor(() => expect(onVisibilityChange).toHaveBeenCalledWith("private"));
    const [[, init]] = callsTo("PATCH", `/api/projects/${PROJECT}`);
    expect(JSON.parse(init.body)).toEqual({ visibility: "private" });
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
    await user.click(screen.getByRole("radio", { name: /Private/ }));
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
