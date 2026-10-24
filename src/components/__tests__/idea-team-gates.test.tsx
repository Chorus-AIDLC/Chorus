// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import en from "../../../messages/en.json";
import zh from "../../../messages/zh.json";
import { IdeaTeamGates } from "../idea-team-gates";

const fetchMock = vi.fn();
const active = { managed: true, state: "active", orchestrator: { agentUuid: "leo", agentName: "Leo" }, yolo: false, proposalGate: "human", taskGate: "lead", reason: null };
function respond(data: unknown) {
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ success: true, data }) });
}
function view(locale = "en") {
  return render(<NextIntlClientProvider locale={locale} messages={locale === "en" ? en : zh}><IdeaTeamGates ideaUuid="idea" /></NextIntlClientProvider>);
}
beforeEach(() => { vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset(); respond(active); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("Idea Team gate summary", () => {
  it("distinguishes the Chinese Idea assignee from the optional Team default", () => {
    expect(zh.common.assignee).toBe("负责人");
    expect(zh.settings.teams.roles.lead.name).toBe("默认负责人（可选）");
  });
  it("shows the human proposal gate and the assignee task gate", async () => {
    view();
    expect(await screen.findByText("Proposal approval: Human")).toBeTruthy();
    expect(screen.getByText("Task verification: Leo")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith("/api/ideas/idea/team-context", expect.objectContaining({ cache: "no-store" }));
  });
  it("shows the assignee as proposal approver under YOLO", async () => {
    respond({ ...active, yolo: true, proposalGate: "lead" });
    view();
    expect(await screen.findByText("Proposal approval: Leo")).toBeTruthy();
  });
  it("renders nothing for unmanaged Ideas", async () => {
    respond({ ...active, managed: false, state: "unmanaged", orchestrator: null });
    const { container } = view();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.innerHTML).toBe("");
  });
  it("renders nothing when the context cannot be loaded", async () => {
    fetchMock.mockRejectedValue(new Error("Unavailable"));
    const { container } = view();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });
  it("displays a pause with its reason in Chinese without exposing private roster fields", async () => {
    respond({ ...active, state: "paused", reason: "team_unbound", private: { candidates: [{ agentName: "Secret developer" }] } });
    view("zh");
    expect(await screen.findByText(/Team 自动化已暂停.*个人项目 Team 已不可用/)).toBeTruthy();
    expect(screen.queryByText(/Secret developer/)).toBeNull();
  });
  it("silently refreshes on focus so an external reassignment or failure removes the stale gate", async () => {
    const component = view();
    await screen.findByText("Task verification: Leo");
    respond({ ...active, orchestrator: { agentUuid: "tom", agentName: "Tom" } });
    fireEvent.focus(window);
    expect(await screen.findByText("Task verification: Tom")).toBeTruthy();
    fetchMock.mockRejectedValue(new Error("Unavailable"));
    fireEvent.focus(window);
    await waitFor(() => expect(screen.queryByText("Task verification: Tom")).toBeNull());
    component.unmount();
    const calls = fetchMock.mock.calls.length;
    fireEvent.focus(window);
    expect(fetchMock.mock.calls.length).toBe(calls);
  });
  it("does not render any assignment-authorization controls", async () => {
    respond({ ...active, canAuthorizeAssignment: true, generation: 3 });
    view();
    await screen.findByText("Proposal approval: Human");
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText(/chorus:assign/)).toBeNull();
  });
  it("silently refreshes every 30 seconds and clears the timer on unmount", async () => {
    vi.useFakeTimers();
    const component = view();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText("Task verification: Leo")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    respond({ ...active, orchestrator: { agentUuid: "tom", agentName: "Tom" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(29999); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Task verification: Leo")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Task verification: Tom")).toBeTruthy();
    expect(screen.queryByText("Task verification: Leo")).toBeNull();
    respond(active);
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(screen.getByText("Task verification: Leo")).toBeTruthy();
    const signal = fetchMock.mock.calls[2][1].signal as AbortSignal;
    component.unmount();
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it("hides the previous gate when a refresh returns success:false", async () => {
    const { container } = view();
    await screen.findByText("Task verification: Leo");
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ success: false, data: active }) });
    fireEvent.focus(window);
    await waitFor(() => expect(container.innerHTML).toBe(""));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it.each(["success", "unsuccessful", "failure"])("ignores an obsolete request's late %s after a newer refresh", async (outcome) => {
    let resolveBody!: (value: unknown) => void;
    let rejectBody!: (reason: Error) => void;
    const body = new Promise<unknown>((resolve, reject) => { resolveBody = resolve; rejectBody = reject; });
    const json = vi.fn(() => body);
    fetchMock.mockResolvedValueOnce({ ok: true, json });
    view();
    await waitFor(() => expect(json).toHaveBeenCalledTimes(1));
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    respond({ ...active, orchestrator: { agentUuid: "tom", agentName: "Tom" } });
    fireEvent.focus(window);
    await screen.findByText("Task verification: Tom");
    expect(signal.aborted).toBe(true);
    await act(async () => {
      if (outcome === "failure") rejectBody(new Error("Unavailable"));
      else resolveBody({ success: outcome === "success", data: active });
    });
    expect(screen.getByText("Task verification: Tom")).toBeTruthy();
    expect(screen.getByText("Proposal approval: Human")).toBeTruthy();
    expect(screen.queryByText("Task verification: Leo")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
