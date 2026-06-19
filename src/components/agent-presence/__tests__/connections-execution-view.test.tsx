// @vitest-environment jsdom
//
// Execution-view integration test for the relocated Agent Connections detail
// pane (now inside the "View all" modal, sourced from AgentPresenceProvider).
//
// Covers the spec requirement that the detail pane shows the selected
// connection's running/queued/interrupted executions, PARTITIONED to the correct
// connection, on FIRST PAINT — equivalent to the former per-connection
// execution-state fetch, now sourced from the aggregate provider
// (GET /api/daemon/executions) before any SSE event. Also covers:
//   - running rows show a live elapsed indicator + root-idea session + entity link,
//   - queued rows show no timer (a "Waiting" hint),
//   - a localized empty state when there is neither,
//   - live updates via an `execution` SSE event through the REAL provider's
//     EventSource (a task starting, and offline → empty active set), and
//   - the interrupt (子3) + resume controls retained at parity with the former
//     page: a running row's Interrupt confirm-then-POST, a user-interrupted row's
//     Resume POST, a crash-interrupted row's no-resume hint, and that an
//     interrupted row keeps showing (not the empty state).
//
// The view is rendered directly inside a real AgentPresenceProvider (the modal's
// Dialog host is covered separately in connections-modal.test.tsx). authFetch is
// mocked + routed by URL; SSE is a mock EventSource the test drives via onmessage,
// exactly like the realtime-context / former page test. No production seam added.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";

// next-intl: resolve real en strings so a missing key surfaces as its dotted path.
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

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

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

import { AgentPresenceProvider } from "@/contexts/agent-presence-context";
import { AgentConnectionsView } from "@/components/agent-presence";

// ===== EventSource stub (drives SSE) =====
interface CapturedEventSource {
  url: string;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: (() => void) | null;
  readyState: number;
  close: () => void;
}
let lastEventSource: CapturedEventSource | null = null;
class MockEventSource implements CapturedEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  url: string;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = MockEventSource.OPEN;
  constructor(url: string) {
    this.url = url;
    lastEventSource = this;
  }
  close() {
    this.readyState = MockEventSource.CLOSED;
  }
}

// ===== Fixtures =====
const NOW = "2026-06-16T12:00:00.000Z";
const CONN_UUID = "conn-1";

const connection = {
  uuid: CONN_UUID,
  agentUuid: "agent-1",
  agentName: "Alpha",
  clientType: "claude_code",
  clientVersion: "0.11.0",
  host: "host-1",
  startedAt: NOW,
  status: "online",
  effectiveStatus: "online",
  connectedAt: NOW,
  lastSeenAt: NOW,
  disconnectedAt: null,
};

function execView(overrides: Record<string, unknown> & { uuid: string }) {
  return {
    agentUuid: "agent-1",
    connectionUuid: CONN_UUID,
    entityType: "task",
    entityUuid: "task-" + overrides.uuid,
    rootIdeaUuid: null,
    status: "running",
    startedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    entityTitle: "Task " + overrides.uuid,
    projectUuid: "proj-1",
    rootIdeaTitle: null,
    ...overrides,
  };
}

// Route authFetch by URL: connection list vs. aggregate executions read. The
// provider fetches GET /api/daemon/executions once on mount for first-paint
// state (the aggregate equivalent of the former per-connection fetch).
function routeFetch(executions: unknown[], connections = [connection]) {
  mockAuthFetch.mockImplementation((url: string) => {
    if (typeof url === "string" && url.startsWith("/api/daemon/executions")) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ success: true, data: { executions } }),
      });
    }
    if (typeof url === "string" && url.startsWith("/api/daemon/control")) {
      return Promise.resolve({ ok: true, json: async () => ({ success: true }) });
    }
    if (typeof url === "string" && url.startsWith("/api/daemon/resume")) {
      return Promise.resolve({ ok: true, json: async () => ({ success: true }) });
    }
    // Default: the connection list.
    return Promise.resolve({
      ok: true,
      json: async () => ({ success: true, data: { connections } }),
    });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  lastEventSource = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).EventSource = MockEventSource;
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-06-16T12:05:00.000Z")); // 5 min after startedAt
});

afterEach(() => {
  vi.useRealTimers();
});

// Render the view inside a real provider — the provider does the
// /api/agent-connections poll + /api/daemon/executions aggregate fetch + opens
// the SSE stream, exactly as the shell does in production.
async function renderView() {
  const utils = render(
    <AgentPresenceProvider>
      <AgentConnectionsView />
    </AgentPresenceProvider>,
  );
  await waitFor(() => expect(mockAuthFetch).toHaveBeenCalled());
  await act(async () => {
    await Promise.resolve();
  });
  return utils;
}

// Push an execution SSE event through the live provider's EventSource.
function pushExecutionEvent(executions: unknown[], connectionUuid = CONN_UUID) {
  act(() => {
    lastEventSource?.onmessage?.({
      data: JSON.stringify({
        type: "execution",
        companyUuid: "company-1",
        connectionUuid,
        executions,
      }),
    } as MessageEvent);
  });
}

describe("Agent Connections modal — execution view (first-paint partition)", () => {
  it("first paint renders running + queued from the aggregate provider, partitioned to the connection (before any SSE event)", async () => {
    routeFetch([
      execView({
        uuid: "run",
        status: "running",
        startedAt: NOW, // 5 min ago → 00:05:00
        rootIdeaTitle: "Ship the daemon",
        rootIdeaUuid: "idea-1",
      }),
      execView({ uuid: "q1", status: "queued", startedAt: null }),
    ]);
    await renderView();

    // Running task title + its root-idea session + a live elapsed indicator,
    // present on first paint (no SSE event pushed yet).
    await waitFor(() => expect(screen.getAllByText("Task run").length).toBeGreaterThan(0));
    expect(screen.getAllByText(/Ship the daemon/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("00:05:00").length).toBeGreaterThan(0);

    // Queued task is listed without an elapsed timer; the "Waiting" hint shows.
    expect(screen.getAllByText("Task q1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Waiting").length).toBeGreaterThan(0);

    // The running row links to the task detail page.
    const link = screen
      .getAllByRole("link")
      .find((a) => a.getAttribute("href") === "/projects/proj-1/tasks/task-run");
    expect(link).toBeTruthy();
  });

  it("partitions executions to the correct connection — another connection's rows do not leak into this detail", async () => {
    // Two connections; the aggregate carries one execution for each. The detail
    // pane defaults to the first connection (online-first ordering preserved),
    // so it must show only conn-1's row, never conn-2's.
    const connection2 = { ...connection, uuid: "conn-2", agentName: "Bravo" };
    routeFetch(
      [
        execView({ uuid: "mine", status: "running", startedAt: NOW }),
        execView({
          uuid: "theirs",
          status: "running",
          startedAt: NOW,
          connectionUuid: "conn-2",
          entityUuid: "task-theirs",
          entityTitle: "Task theirs",
        }),
      ],
      [connection, connection2],
    );
    await renderView();

    await waitFor(() => expect(screen.getAllByText("Task mine").length).toBeGreaterThan(0));
    // conn-2's execution must NOT appear in conn-1's detail pane.
    expect(screen.queryByText("Task theirs")).toBeNull();
  });

  it("the elapsed indicator ticks every second for a running row", async () => {
    routeFetch([execView({ uuid: "run", status: "running", startedAt: NOW })]);
    await renderView();
    await waitFor(() => expect(screen.getAllByText("00:05:00").length).toBeGreaterThan(0));
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    await waitFor(() => expect(screen.getAllByText("00:05:01").length).toBeGreaterThan(0));
  });

  it("renders a localized empty state when there is no running or queued task", async () => {
    routeFetch([]);
    await renderView();
    await waitFor(() => expect(screen.getAllByText("Nothing running").length).toBeGreaterThan(0));
  });

  it("shows a loading state (not the empty 'Nothing running') while connections settled but executions are still pending", async () => {
    // Connections resolve immediately; the executions aggregate HANGS — this is
    // the first-paint window where a busy connection would otherwise flash a
    // false "Nothing running". The pane must show the loading state instead.
    let resolveExec: ((v: unknown) => void) | null = null;
    mockAuthFetch.mockImplementation((url: string) => {
      if (typeof url === "string" && url.startsWith("/api/daemon/executions")) {
        return new Promise((resolve) => {
          resolveExec = resolve;
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ success: true, data: { connections: [connection] } }),
      });
    });

    await renderView();
    await waitFor(() =>
      expect(screen.getAllByText("Loading execution state...").length).toBeGreaterThan(0),
    );
    expect(screen.queryByText("Nothing running")).toBeNull();

    // Once the aggregate settles empty, it flips to the real empty state.
    await act(async () => {
      resolveExec?.({ ok: true, json: async () => ({ success: true, data: { executions: [] } }) });
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getAllByText("Nothing running").length).toBeGreaterThan(0));
  });

  it("updates live when an execution SSE event arrives (task starts)", async () => {
    routeFetch([]); // first paint: empty
    await renderView();
    await waitFor(() => expect(screen.getAllByText("Nothing running").length).toBeGreaterThan(0));

    // A task starts → execution event → the running row appears without a refetch.
    pushExecutionEvent([execView({ uuid: "live", status: "running", startedAt: NOW })]);
    await waitFor(() => expect(screen.getAllByText("Task live").length).toBeGreaterThan(0));
    expect(screen.queryByText("Nothing running")).toBeNull();
  });

  it("clears the active view when the connection goes offline (empty execution event)", async () => {
    routeFetch([execView({ uuid: "run", status: "running", startedAt: NOW })]);
    await renderView();
    await waitFor(() => expect(screen.getAllByText("Task run").length).toBeGreaterThan(0));

    // Offline reconcile publishes an empty active set → the pane clears to empty.
    pushExecutionEvent([]);
    await waitFor(() => expect(screen.getAllByText("Nothing running").length).toBeGreaterThan(0));
    expect(screen.queryByText("Task run")).toBeNull();
  });
});

describe("Agent Connections modal — error vs empty (no silent error)", () => {
  it("renders a DISTINCT error state (not the 'no connections' empty) when the first connections fetch fails", async () => {
    // Both endpoints fail on the first (and only) load — status flips to "error"
    // with no cached connections. The modal MUST show the load-error card, never
    // the "No agent connections yet" empty card.
    mockAuthFetch.mockImplementation((url: string) => {
      if (typeof url === "string" && url.startsWith("/api/daemon/executions")) {
        return Promise.resolve({ ok: false, json: async () => ({ success: false }) });
      }
      // Connection list fails.
      return Promise.resolve({ ok: false, json: async () => ({ success: false }) });
    });

    await renderView();
    await waitFor(() =>
      expect(screen.getAllByText("Couldn't load connections").length).toBeGreaterThan(0),
    );
    // The empty state must NOT be shown — a fetch failure is not "zero connections".
    expect(screen.queryByText("No agent connections yet")).toBeNull();
  });
});

// =====================================================================
// Interrupt control (子3 — daemon-interrupt-resume)
// =====================================================================
describe("Agent Connections modal — interrupt control", () => {
  it("running rows show an Interrupt control; queued rows do not", async () => {
    routeFetch([
      execView({ uuid: "run", status: "running", startedAt: NOW }),
      execView({ uuid: "q1", status: "queued", startedAt: null }),
    ]);
    await renderView();
    await waitFor(() => expect(screen.getAllByText("Task run").length).toBeGreaterThan(0));

    const interruptButtons = screen.getAllByRole("button", {
      name: "Interrupt this running execution",
    });
    expect(interruptButtons.length).toBeGreaterThan(0);
    // Exactly one running execution → button count equals running-row count.
    const runningRowCount = screen.getAllByText("Task run").length;
    expect(interruptButtons.length).toBe(runningRowCount);
  });

  it("confirming Interrupt POSTs the control command with the right connection + entity", async () => {
    routeFetch([
      execView({ uuid: "run", status: "running", startedAt: NOW, entityType: "task" }),
    ]);
    await renderView();
    await waitFor(() => expect(screen.getAllByText("Task run").length).toBeGreaterThan(0));

    fireEvent.click(
      screen.getAllByRole("button", { name: "Interrupt this running execution" })[0],
    );
    await waitFor(() =>
      expect(screen.getByText("Interrupt this execution?")).toBeTruthy(),
    );

    const confirm = screen
      .getAllByRole("button")
      .find((b) => b.textContent === "Interrupt" && !b.getAttribute("aria-label"));
    expect(confirm).toBeTruthy();
    fireEvent.click(confirm!);

    await waitFor(() => {
      const controlCall = mockAuthFetch.mock.calls.find(
        (c) => c[0] === "/api/daemon/control",
      );
      expect(controlCall).toBeTruthy();
      const body = JSON.parse((controlCall![1] as RequestInit).body as string);
      expect(body).toEqual({
        command: "interrupt",
        targetConnectionUuid: CONN_UUID,
        entityType: "task",
        entityUuid: "task-run",
      });
    });
    await waitFor(() => expect(mockToast.success).toHaveBeenCalled());
  });

  it("surfaces an error toast when the control POST fails", async () => {
    mockAuthFetch.mockImplementation((url: string) => {
      if (typeof url === "string" && url.startsWith("/api/daemon/control")) {
        return Promise.resolve({
          ok: false,
          json: async () => ({ success: false, error: "Not authorized to control this connection" }),
        });
      }
      if (typeof url === "string" && url.startsWith("/api/daemon/executions")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            data: { executions: [execView({ uuid: "run", status: "running", startedAt: NOW })] },
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ success: true, data: { connections: [connection] } }),
      });
    });
    await renderView();
    await waitFor(() => expect(screen.getAllByText("Task run").length).toBeGreaterThan(0));

    fireEvent.click(
      screen.getAllByRole("button", { name: "Interrupt this running execution" })[0],
    );
    await waitFor(() =>
      expect(screen.getByText("Interrupt this execution?")).toBeTruthy(),
    );
    const confirm = screen
      .getAllByRole("button")
      .find((b) => b.textContent === "Interrupt" && !b.getAttribute("aria-label"));
    fireEvent.click(confirm!);

    // Server's precise error message is preferred over the generic fallback.
    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith(
        "Not authorized to control this connection",
      ),
    );
  });
});

// =====================================================================
// Resume control + interrupted rows (子3 — daemon-interrupt-resume)
// =====================================================================
describe("Agent Connections modal — interrupted rows + resume control", () => {
  it("a user-interrupted row shows a Resume control; clicking it POSTs /api/daemon/resume", async () => {
    routeFetch([
      execView({
        uuid: "int",
        status: "interrupted",
        interruptedReason: "user",
        startedAt: null,
        entityType: "task",
      }),
    ]);
    await renderView();
    await waitFor(() => expect(screen.getAllByText("Task int").length).toBeGreaterThan(0));

    // A Resume control is offered (not an Interrupt control — the row is stopped).
    const resumeButtons = screen.getAllByRole("button", {
      name: "Resume this interrupted execution",
    });
    expect(resumeButtons.length).toBeGreaterThan(0);
    expect(
      screen.queryAllByRole("button", { name: "Interrupt this running execution" }).length,
    ).toBe(0);

    // Clicking it (no confirm dialog — resume is non-destructive) POSTs to the
    // daemon resume endpoint with the connection + entity.
    fireEvent.click(resumeButtons[0]);
    await waitFor(() => {
      const resumeCall = mockAuthFetch.mock.calls.find((c) => c[0] === "/api/daemon/resume");
      expect(resumeCall).toBeTruthy();
      const body = JSON.parse((resumeCall![1] as RequestInit).body as string);
      expect(body).toEqual({
        connectionUuid: CONN_UUID,
        entityType: "task",
        entityUuid: "task-int",
      });
    });
    await waitFor(() => expect(mockToast.success).toHaveBeenCalled());
  });

  it("a crash-interrupted row shows NO Resume control (it auto-recovers)", async () => {
    routeFetch([
      execView({
        uuid: "crash",
        status: "interrupted",
        interruptedReason: "crash",
        startedAt: null,
      }),
    ]);
    await renderView();
    await waitFor(() => expect(screen.getAllByText("Task crash").length).toBeGreaterThan(0));

    expect(
      screen.queryAllByRole("button", { name: "Resume this interrupted execution" }).length,
    ).toBe(0);
    expect(screen.getAllByText("Auto-recovers").length).toBeGreaterThan(0);
  });

  it("an interrupted row keeps showing (not the empty state)", async () => {
    routeFetch([
      execView({ uuid: "int", status: "interrupted", interruptedReason: "user", startedAt: null }),
    ]);
    await renderView();
    await waitFor(() => expect(screen.getAllByText("Task int").length).toBeGreaterThan(0));
    expect(screen.queryByText("Nothing running")).toBeNull();
  });
});

// =====================================================================
// Responsive row layout (continuation of b5bdcfa — the popover fix).
//
// b5bdcfa added a `stacked` ExecutionRow variant but wired it only into the
// sidebar popover. The detail view now forwards its own `variant` to the rows:
// the wide desktop master-detail pane stays "inline" (room to spare); the narrow
// mobile drill-down uses "stacked" so a running row's title is no longer squeezed
// by the elapsed timer + Interrupt/Resume controls.
//
// jsdom doesn't evaluate the `lg:` media queries, so the desktop master-detail
// pane is always in the DOM and the mobile drill-down renders only after a card
// tap. We therefore assert against the row geometry classes directly:
//   - inline rows are a centered flex row (`items-center`, never `flex-col`),
//   - stacked rows are `flex-col` with a two-line-clamped title.
// =====================================================================
describe("Agent Connections modal — responsive execution-row layout", () => {
  it("desktop master-detail pane renders execution rows inline (unchanged)", async () => {
    routeFetch([execView({ uuid: "run", status: "running", startedAt: NOW })]);
    const { container } = await renderView();
    await waitFor(() => expect(screen.getAllByText("Task run").length).toBeGreaterThan(0));

    // On first paint the mobile drill-down is closed, so the only execution rows
    // in the DOM belong to the always-present desktop pane — all must be inline.
    const rows = container.querySelectorAll("li");
    expect(rows.length).toBeGreaterThan(0);
    rows.forEach((row) => {
      expect(row.className).toContain("items-center");
      expect(row.className).not.toContain("flex-col");
    });
  });

  it("mobile drill-down renders execution rows stacked (title gets full width)", async () => {
    routeFetch([
      execView({
        uuid: "run",
        status: "running",
        startedAt: NOW,
        entityTitle: "A very long running task title that used to truncate",
      }),
    ]);
    const { container } = await renderView();
    await waitFor(() =>
      expect(
        screen.getAllByText("A very long running task title that used to truncate").length,
      ).toBeGreaterThan(0),
    );

    // Drill into the connection on mobile: the only `.lg:hidden` subtree on first
    // paint is the mobile card list (the drill-down wrapper isn't mounted yet).
    const mobileCard = container.querySelector(".lg\\:hidden button");
    expect(mobileCard).not.toBeNull();
    fireEvent.click(mobileCard!);

    // The mobile detail pane now renders ExecutionRow with layout="stacked": a
    // flex-col <li> whose title relaxes to a two-line clamp.
    await waitFor(() =>
      expect(container.querySelectorAll("li.flex-col").length).toBeGreaterThan(0),
    );
    const stackedRow = container.querySelector("li.flex-col");
    expect(stackedRow?.textContent).toContain(
      "A very long running task title that used to truncate",
    );
    // The Interrupt control survives the layout change (controls retained).
    expect(
      screen.getAllByRole("button", { name: "Interrupt this running execution" }).length,
    ).toBeGreaterThan(0);
  });
});
