// @vitest-environment jsdom

import React from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UserMention, UserMentionProvider } from "@/components/user-mention";

const mocks = vi.hoisted(() => ({ auth: { user: { uuid: "00000000-0000-0000-0000-000000000001", name: "Self", email: "self@test" }, company: { uuid: "company" } }, fetch: vi.fn() }));
vi.mock("@/contexts/auth-context", () => ({ useOptionalAuth: () => mocks.auth }));
vi.mock("@/components/markdown-content", () => ({ MarkdownContent: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

const other = "00000000-0000-0000-0000-000000000002";
const target = "00000000-0000-0000-0000-000000000003";
const original = `@[Old email](user:${other})`;
const comments = [{ content: `${original} ${original} @[Agent](agent:${target}?cwd=%2Ftmp&host=test)` }];
const response = (users: { uuid: string; name: string }[]) => ({ ok: true, json: async () => ({ success: true, data: { users } }) });
function Fixture({ entity = target, entries = comments, uuid = other }: { entity?: string; entries?: { content: string }[]; uuid?: string }) {
  return <UserMentionProvider targetType="idea" targetUuid={entity} comments={entries}><UserMention uuid={uuid} fallback="Old email" /></UserMentionProvider>;
}

beforeEach(() => {
  mocks.auth.user = { uuid: "00000000-0000-0000-0000-000000000001", name: "Self", email: "self@test" };
  mocks.fetch.mockReset();
  vi.stubGlobal("fetch", mocks.fetch);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("current user mention labels", () => {
  it("batches duplicate user refs, excludes agents, and leaves stored content untouched", async () => {
    mocks.fetch.mockResolvedValue(response([{ uuid: other, name: "Felix Chan🚀" }]));
    render(<Fixture />);
    expect(await screen.findByText("@Felix Chan🚀")).toBeTruthy();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = mocks.fetch.mock.calls[0];
    expect(url).toBe("/api/mentionables/resolve");
    expect(JSON.parse(options.body)).toEqual({ userUuids: [other], entityType: "idea", entityUuid: target });
    expect(options.cache).toBe("no-store");
    expect(comments[0].content).toContain(original);
  });

  it.each([response([]), { ok: false }, { ok: true, json: async () => ({ success: true, data: {} }) }])("keeps the stored label when resolution fails or user is unavailable", async result => {
    mocks.fetch.mockResolvedValue(result);
    render(<Fixture />);
    await act(async () => {});
    expect(screen.getByText("@Old email")).toBeTruthy();
  });

  it("falls back on network failure", async () => {
    mocks.fetch.mockRejectedValue(new Error("offline"));
    render(<Fixture />);
    await act(async () => {});
    expect(screen.getByText("@Old email")).toBeTruthy();
  });

  it("renders email fallback and markup-like names as text, not HTML", async () => {
    mocks.fetch.mockResolvedValue(response([{ uuid: other, name: "<img src=x onerror=alert(1)>" }]));
    const { container, rerender } = render(<Fixture />);
    expect(await screen.findByText("@<img src=x onerror=alert(1)>")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
    mocks.fetch.mockResolvedValue(response([{ uuid: other, name: "member@example.com" }]));
    rerender(<Fixture entries={[...comments]} />);
    expect(await screen.findByText("@member@example.com")).toBeTruthy();
  });

  it("clears labels on entity/account switch and ignores late responses", async () => {
    mocks.fetch.mockResolvedValueOnce(response([{ uuid: other, name: "Visible" }]));
    const { rerender } = render(<Fixture />);
    expect(await screen.findByText("@Visible")).toBeTruthy();
    let complete!: (result: ReturnType<typeof response>) => void;
    mocks.fetch.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    rerender(<Fixture entity={other} />);
    expect(screen.getByText("@Old email")).toBeTruthy();
    mocks.auth.user = { ...mocks.auth.user, uuid: target };
    mocks.fetch.mockResolvedValue(response([]));
    rerender(<Fixture entity={other} />);
    await act(async () => { complete(response([{ uuid: other, name: "Wrong context" }])); });
    expect(screen.queryByText("@Wrong context")).toBeNull();
    expect(screen.getByText("@Old email")).toBeTruthy();
    expect(mocks.fetch.mock.calls[1][1].signal.aborted).toBe(true);
  });

  it("reflects a saved self-name immediately without another request", async () => {
    const self = mocks.auth.user.uuid;
    const entries = [{ content: `@[old](user:${self})` }];
    mocks.fetch.mockResolvedValue(response([{ uuid: self, name: "Self" }]));
    const { rerender } = render(<Fixture entries={entries} uuid={self} />);
    expect(await screen.findByText("@Self")).toBeTruthy();
    mocks.auth.user = { ...mocks.auth.user, name: "Renamed🚀" };
    rerender(<Fixture entries={entries} uuid={self} />);
    expect(screen.getByText("@Renamed🚀")).toBeTruthy();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("prefers freshly resolved self-name over stale session data", async () => {
    const self = mocks.auth.user.uuid;
    mocks.fetch.mockResolvedValue(response([{ uuid: self, name: "Changed elsewhere" }]));
    render(<Fixture entries={[{ content: `@[old](user:${self})` }]} uuid={self} />);
    expect(await screen.findByText("@Changed elsewhere")).toBeTruthy();
    expect(screen.queryByText("@Self")).toBeNull();
  });

  it("does not let an old lookup undo a local self-name save", async () => {
    const self = mocks.auth.user.uuid;
    const entries = [{ content: `@[old](user:${self})` }];
    let complete!: (result: ReturnType<typeof response>) => void;
    mocks.fetch.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const { rerender } = render(<Fixture entries={entries} uuid={self} />);
    mocks.auth.user = { ...mocks.auth.user, name: "Just saved" };
    rerender(<Fixture entries={entries} uuid={self} />);
    await act(async () => { complete(response([{ uuid: self, name: "Self" }])); });
    expect(screen.getByText("@Just saved")).toBeTruthy();
  });

  it("limits batches to 100 UUIDs and skips comment lists with no user mentions", async () => {
    mocks.fetch.mockResolvedValue(response([]));
    const { rerender } = render(<Fixture entries={[]} />);
    expect(mocks.fetch).not.toHaveBeenCalled();
    const entries = Array.from({ length: 101 }, (_, index) => ({ content: `@[old](user:00000000-0000-0000-0000-${String(index).padStart(12, "0")})` }));
    rerender(<Fixture entries={entries} />);
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2));
    expect(mocks.fetch.mock.calls.map(([, options]) => JSON.parse(options.body).userUuids.length)).toEqual([100, 1]);
  });
});
