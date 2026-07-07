// @vitest-environment jsdom
//
// NewIdeaDialog mode gating (add-conversational-idea-entry). The dialog keeps
// the static form as the default and adds a "Describe to an agent" tab whose
// availability follows the presence spine:
//   - ≥1 online daemon → tab enabled; switching shows the ConversationalEntry
//     pane; a successful dispatch closes the dialog + calls openChatForSession
//     and NEVER onCreated (no Idea exists at dispatch time),
//   - 0 online → tab visible but disabled, with the startup CTA hint inline,
//   - derive-child mode (parentUuid) → no tabs at all (form only).
//
// The presence spine + ConversationalEntry are mocked at their module seams —
// the entry's own behavior is covered by conversational-entry.test.tsx; here we
// test the DIALOG's gating, template threading, and handoff wiring.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("next-intl", async () => {
  const en = (await import("../../../../../../../messages/en.json")).default as Record<
    string,
    unknown
  >;
  function resolve(namespace: string, key: string): string {
    const fullKey = namespace ? `${namespace}.${key}` : key;
    let node: unknown = en;
    for (const p of fullKey.split(".")) {
      if (node && typeof node === "object" && p in (node as Record<string, unknown>)) {
        node = (node as Record<string, unknown>)[p];
      } else {
        return fullKey;
      }
    }
    return typeof node === "string" ? node : fullKey;
  }
  return {
    useTranslations:
      (namespace = "") =>
      (key: string, params?: Record<string, string | number>) => {
        let s = resolve(namespace, key);
        if (params) {
          for (const [k, v] of Object.entries(params)) {
            s = s.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
          }
        }
        return s;
      },
  };
});

const mockPresence = vi.fn();
vi.mock("@/contexts/agent-presence-context", () => ({
  useAgentPresenceOptional: () => mockPresence(),
}));

// ConversationalEntry is mocked at the barrel seam the dialog imports from; the
// mock exposes its props so the test can assert the dispatch contract and drive
// onStarted. The REAL ConversationalDispatchError class is re-exported (the
// dialog's dispatch throws it; asserting instanceof against the same class the
// dialog uses keeps the seam honest). DaemonConnectCta renders its marker so
// the offline hint is assertable without pulling the real CTA tree.
const entryProps = vi.fn();
vi.mock("@/components/agent-presence", async () => {
  const { ConversationalDispatchError } = await import(
    "@/components/agent-presence/conversational-entry"
  );
  return {
    ConversationalEntry: (props: {
      dispatch: (args: unknown) => Promise<unknown>;
      onStarted: (s: unknown) => void;
    }) => {
      entryProps(props);
      return <div>conversational-entry-pane</div>;
    },
    ConversationalDispatchError,
    DaemonConnectCta: () => <div>daemon-connect-cta</div>,
  };
});

const mockAuthFetch = vi.fn();
vi.mock("@/lib/auth-client", () => ({
  authFetch: (...args: unknown[]) => mockAuthFetch(...args),
}));

import { NewIdeaDialog } from "../new-idea-dialog";

const onlineConn = {
  uuid: "c1",
  agentUuid: "agent-1",
  effectiveStatus: "online" as const,
};
const mockOpenChatForSession = vi.fn();

function setPresence(online: boolean) {
  mockPresence.mockReturnValue({
    connections: online ? [onlineConn] : [{ ...onlineConn, effectiveStatus: "offline" }],
    openChatForSession: mockOpenChatForSession,
  });
}

function renderDialog(over: Partial<Parameters<typeof NewIdeaDialog>[0]> = {}) {
  const onOpenChange = vi.fn();
  const onCreated = vi.fn();
  const utils = render(
    <NewIdeaDialog
      open
      onOpenChange={onOpenChange}
      projectUuid="proj-1"
      projectName="Chorus"
      onCreated={onCreated}
      {...over}
    />,
  );
  return { onOpenChange, onCreated, ...utils };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("NewIdeaDialog — mode gating", () => {
  it("defaults to the static form with an enabled conversational tab when a daemon is online", () => {
    setPresence(true);
    renderDialog();
    // Form pane is the default render.
    expect(screen.getByLabelText("Title")).toBeTruthy();
    const tab = screen.getByRole("tab", { name: "Describe to an agent" });
    expect((tab as HTMLButtonElement).disabled).toBe(false);
    // No offline hint when online.
    expect(screen.queryByText("daemon-connect-cta")).toBeNull();
  });

  it("switching to the conversational tab swaps the pane and supplies the conversational-idea dispatch (raw text, no client template)", async () => {
    setPresence(true);
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("tab", { name: "Describe to an agent" }));
    expect(screen.getByText("conversational-entry-pane")).toBeTruthy();
    expect(screen.queryByLabelText("Title")).toBeNull();

    // The dialog supplies a dispatch (no buildInstruction — the server composes
    // the template around the pre-created ideaUuid). Driving it POSTs the RAW
    // description to the conversational-idea endpoint and returns the session.
    const props = entryProps.mock.calls[0][0];
    expect(props.buildInstruction).toBeUndefined();
    const session = { uuid: "s-1", sessionId: "idea-1", directIdeaUuid: "idea-1" };
    mockAuthFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { session } }),
    });
    const returned = await props.dispatch({
      agentUuid: "agent-1",
      connectionUuid: "c1",
      userText: "my idea",
    });
    expect(returned).toEqual(session);
    expect(mockAuthFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockAuthFetch.mock.calls[0];
    expect(url).toBe("/api/ideas/conversational");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      projectUuid: "proj-1",
      agentUuid: "agent-1",
      connectionUuid: "c1",
      descriptionText: "my idea",
    });
  });

  it("the dispatch maps failures to ConversationalDispatchError carrying status + server reason", async () => {
    setPresence(true);
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("tab", { name: "Describe to an agent" }));
    const props = entryProps.mock.calls[0][0];

    // Failure with a server reason.
    mockAuthFetch.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ success: false, error: "Connection is offline" }),
    });
    await expect(
      props.dispatch({ agentUuid: "a", connectionUuid: "c", userText: "x" }),
    ).rejects.toMatchObject({
      name: "ConversationalDispatchError",
      status: 409,
      serverMessage: "Connection is offline",
    });

    // 2xx without a session payload — a failed dispatch, never a silent close.
    mockAuthFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: {} }),
    });
    await expect(
      props.dispatch({ agentUuid: "a", connectionUuid: "c", userText: "x" }),
    ).rejects.toMatchObject({ name: "ConversationalDispatchError" });
  });

  it("successful dispatch closes the dialog and opens the chat on the session — never onCreated", async () => {
    setPresence(true);
    const user = userEvent.setup();
    const { onOpenChange, onCreated } = renderDialog();
    await user.click(screen.getByRole("tab", { name: "Describe to an agent" }));
    const session = { uuid: "s-1", agentUuid: "agent-1" };
    entryProps.mock.calls[0][0].onStarted(session);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mockOpenChatForSession).toHaveBeenCalledWith(session);
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("offline: the tab stays visible but disabled, with the startup CTA hint", () => {
    setPresence(false);
    renderDialog();
    const tab = screen.getByRole("tab", { name: "Describe to an agent" });
    expect((tab as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByText("Describing to an agent needs an online daemon."),
    ).toBeTruthy();
    expect(screen.getByText("daemon-connect-cta")).toBeTruthy();
    // Form still fully usable.
    expect(screen.getByLabelText("Title")).toBeTruthy();
  });

  it("derive-child mode renders no tabs at all (form only)", () => {
    setPresence(true);
    renderDialog({ parentUuid: "parent-1", parentTitle: "Parent idea" });
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.getByLabelText("Title")).toBeTruthy();
  });

  it("treats an absent presence provider as offline (dialog mountable outside the shell)", () => {
    mockPresence.mockReturnValue(null);
    renderDialog();
    const tab = screen.getByRole("tab", { name: "Describe to an agent" });
    expect((tab as HTMLButtonElement).disabled).toBe(true);
  });
});
