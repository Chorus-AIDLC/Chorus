// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import en from "../../../messages/en.json";
import zh from "../../../messages/zh.json";
import { IdeaTeamGates } from "../idea-team-gates";

const fetchMock = vi.fn();
const active = { managed: true, state: "active", lead: { agentUuid: "lead", agentName: "Clay" }, yolo: false, proposalGate: "human", taskGate: "lead", reason: null };
function respond(data: unknown) {
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ success: true, data }) });
}
function view(locale = "en") {
  return render(<NextIntlClientProvider locale={locale} messages={locale === "en" ? en : zh}><IdeaTeamGates ideaUuid="idea" /></NextIntlClientProvider>);
}
beforeEach(() => { vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset(); respond(active); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Idea Team gate summary", () => {
  it("shows the human proposal gate and lead task gate", async () => {
    view();
    expect(await screen.findByText("Proposal approval: Human")).toBeTruthy();
    expect(screen.getByText("Task verification: Clay")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith("/api/ideas/idea/team-context", expect.objectContaining({ cache: "no-store" }));
  });
  it("shows Idea-scoped YOLO and the lead approval gate", async () => {
    respond({ ...active, yolo: true, proposalGate: "lead" });
    view();
    expect(await screen.findByText("Proposal approval: Clay")).toBeTruthy();
    expect(screen.getByText(/YOLO is authorized for this Idea only/)).toBeTruthy();
  });
  it("does not treat unassigned/unmanaged Ideas as Team work", async () => {
    respond({ ...active, managed: false, state: "unmanaged", lead: null });
    view();
    expect(await screen.findByText(/No owner is assigned automatically/)).toBeTruthy();
    expect(screen.queryByText("Task verification: Clay")).toBeNull();
  });
  it("displays a pause in Chinese without exposing private roster fields", async () => {
    respond({ ...active, state: "paused", private: { candidates: [{ agentName: "Secret developer" }] } });
    view("zh");
    expect(await screen.findByText(/Team 自动化已暂停/)).toBeTruthy();
    expect(screen.queryByText(/Secret developer/)).toBeNull();
  });
  it("refreshes on focus and hides stale state after errors", async () => {
    view();
    await screen.findByText("Proposal approval: Human");
    fetchMock.mockRejectedValue(new Error("Unavailable"));
    fireEvent.focus(window);
    expect(await screen.findByText(/Gate state is unavailable/)).toBeTruthy();
    expect(screen.queryByText("Proposal approval: Human")).toBeNull();
  });
  it("cleans up refresh listeners on unmount", async () => {
    const component = view();
    await screen.findByText("Proposal approval: Human");
    component.unmount();
    fireEvent.focus(window);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });
});
