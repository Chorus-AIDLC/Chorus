// @vitest-environment jsdom
//
// ConversationReplyBox — the chat footer composer (子3) + the T12 (corrects T11)
// origin-offline ESCAPE HATCH. Covers:
//   - origin ONLINE → a live composer (no read-only banner, no escape hatch),
//   - origin OFFLINE + agent has another ONLINE cwd → the read-only banner stays
//     AND a "Continue on an online directory" action appears; clicking it opens
//     the RepointForm on the online instances, and a successful re-point POSTs to
//     the CURRENT session's /repoint endpoint (NOT /ad-hoc — no new session) and
//     hands the SAME (re-pointed) session back to onSessionStarted so the chat
//     keeps it selected,
//   - origin OFFLINE + NO other online cwd → plain read-only, no escape hatch.
//
// next-intl resolves real en.json strings (a missing key surfaces as its dotted
// path and would fail a text assertion). authFetch + sonner are mocked.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from "@testing-library/react";

vi.mock("next-intl", async () => {
  const en = (await import("../../../../messages/en.json")).default as Record<
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

const mockAuthFetch = vi.fn();
vi.mock("@/lib/auth-client", () => ({
  authFetch: (...args: unknown[]) => mockAuthFetch(...args),
}));

vi.mock("@/lib/logger-client", () => ({
  clientLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const mockToast = { success: vi.fn(), error: vi.fn() };
vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mockToast.success(...args),
    error: (...args: unknown[]) => mockToast.error(...args),
  },
}));

import { ConversationReplyBox } from "@/components/agent-presence/send-instruction-box";
import type { ConnectionView } from "@/components/agent-presence/types";

const NOW = "2026-06-23T12:00:00.000Z";

function conn(o: Partial<ConnectionView> & { uuid: string }): ConnectionView {
  return {
    agentUuid: "agent-1",
    agentName: "Alpha",
    clientType: "claude_code",
    clientVersion: "0.11.0",
    host: "host-1",
    cwd: "/home/u/dev/chorus",
    startedAt: NOW,
    status: "online",
    effectiveStatus: "online",
    connectedAt: NOW,
    lastSeenAt: NOW,
    disconnectedAt: null,
    ...o,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // A successful re-point returns the SAME session (its uuid is unchanged — re-point keeps
  // the conversation's identity), now pointing at the chosen online connection.
  mockAuthFetch.mockResolvedValue({
    ok: true,
    json: async () => ({
      success: true,
      data: {
        session: {
          uuid: "sess-1",
          agentUuid: "agent-1",
          originConnectionUuid: "online-elsewhere",
        },
      },
    }),
  });
});
afterEach(() => cleanup());

describe("ConversationReplyBox — origin online", () => {
  it("renders a live composer (no read-only banner, no escape hatch)", () => {
    render(
      <ConversationReplyBox
        sessionUuid="sess-1"
        originOnline
        agentUuid="agent-1"
        onlineConnections={[conn({ uuid: "c1" })]}
      />,
    );
    // No read-only banner; the escape-hatch action is absent.
    expect(
      screen.queryByText(/this conversation's origin daemon is offline/i),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Continue on an online directory" }),
    ).toBeNull();
  });
});

describe("ConversationReplyBox — origin offline escape hatch (qr3)", () => {
  it("offers 'Continue on an online directory' when the agent has another online cwd", () => {
    render(
      <ConversationReplyBox
        sessionUuid="sess-1"
        originOnline={false}
        agentUuid="agent-1"
        onlineConnections={[conn({ uuid: "online-elsewhere", cwd: "/home/u/dev/live" })]}
      />,
    );
    // The read-only banner stays (origin is offline)…
    expect(
      screen.getByText(/this conversation's origin daemon is offline/i),
    ).toBeTruthy();
    // …AND the escape-hatch action is offered.
    expect(
      screen.getByRole("button", { name: "Continue on an online directory" }),
    ).toBeTruthy();
  });

  it("opening the escape hatch reveals the re-point composer on the online instance", async () => {
    render(
      <ConversationReplyBox
        sessionUuid="sess-1"
        originOnline={false}
        agentUuid="agent-1"
        onlineConnections={[conn({ uuid: "online-elsewhere", cwd: "/home/u/dev/live" })]}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Continue on an online directory" }),
    );
    // The re-point composer surfaces the working-directory picker confirmation
    // ("Sending to …") and its own "Send" affordance (a second Send button — the
    // read-only banner's composer also has one, so we assert ≥1 appears).
    await waitFor(() => expect(screen.getByText(/sending to/i)).toBeTruthy());
    expect(
      screen.getAllByRole("button", { name: "Send" }).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("a successful re-point POSTs the CURRENT session's /repoint (NOT /ad-hoc, NOT a new session) and hands the SAME session back to onSessionStarted", async () => {
    const onSessionStarted = vi.fn();
    render(
      <ConversationReplyBox
        sessionUuid="sess-1"
        originOnline={false}
        agentUuid="agent-1"
        onlineConnections={[conn({ uuid: "online-elsewhere", cwd: "/home/u/dev/live" })]}
        onSessionStarted={onSessionStarted}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Continue on an online directory" }),
    );
    const textarea = (await screen.findByPlaceholderText(
      "Type an instruction for this session…",
    )) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "pick up where we left off" } });
    // Two "Send" buttons exist (the read-only banner's, always disabled; the re-point
    // composer's, enabled once text is typed). Click the ENABLED one — the re-point Send.
    const sendButton = screen
      .getAllByRole("button", { name: "Send" })
      .find((b) => !(b as HTMLButtonElement).disabled);
    expect(sendButton).toBeTruthy();
    fireEvent.click(sendButton!);

    await waitFor(() => expect(onSessionStarted).toHaveBeenCalled());
    // The POST went to the CURRENT session's /repoint endpoint with the chosen ONLINE
    // connection + instruction text — re-pointing the SAME conversation, keeping its id.
    const repointCall = mockAuthFetch.mock.calls.find(
      (c) => c[0] === "/api/daemon-sessions/sess-1/repoint",
    );
    expect(repointCall).toBeTruthy();
    const body = JSON.parse((repointCall![1] as RequestInit).body as string);
    expect(body).toMatchObject({
      connectionUuid: "online-elsewhere",
      instructionText: "pick up where we left off",
    });
    // NO new ad-hoc session was minted — the /ad-hoc endpoint was NOT hit.
    expect(
      mockAuthFetch.mock.calls.some((c) => c[0] === "/api/daemon-sessions/ad-hoc"),
    ).toBe(false);
    // The SAME session (same uuid) is handed back so the chat keeps it selected.
    expect(onSessionStarted.mock.calls[0][0]).toMatchObject({ uuid: "sess-1" });
  });

  it("keeps plain read-only (NO escape hatch) when the agent has no online cwd", () => {
    render(
      <ConversationReplyBox
        sessionUuid="sess-1"
        originOnline={false}
        agentUuid="agent-1"
        onlineConnections={[]}
      />,
    );
    expect(
      screen.getByText(/this conversation's origin daemon is offline/i),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Continue on an online directory" }),
    ).toBeNull();
  });
});
