import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChorusEventRouter } from "../event-router.js";
import type { SseNotificationEvent } from "../sse-listener.js";

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeNotification(over: Partial<Record<string, unknown>> = {}) {
  return {
    uuid: "n1",
    projectUuid: "proj-1",
    entityType: "task",
    entityUuid: "task-1",
    entityTitle: "Build widget",
    action: "task_assigned",
    message: "You have a task",
    actorType: "user",
    actorUuid: "user-1",
    actorName: "Alice",
    ...over,
  };
}

/** MCP client fake: callTool resolves a queued response keyed by tool name. */
function makeMcpClient(responses: Record<string, unknown> = {}) {
  const callTool = vi.fn(async (name: string) => responses[name] ?? null);
  return { callTool };
}

/** Wait for the router's fire-and-forget async dispatch to settle. */
async function flush() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe("ChorusEventRouter.dispatch", () => {
  let wake: ReturnType<typeof vi.fn>;
  let logger: ReturnType<typeof makeLogger>;

  beforeEach(() => {
    wake = vi.fn();
    logger = makeLogger();
  });

  function build(responses: Record<string, unknown>) {
    const mcpClient = makeMcpClient(responses) as never;
    const router = new ChorusEventRouter({ mcpClient, wake, logger });
    return { router, mcpClient };
  }

  it("ignores non new_notification event types", () => {
    const { router } = build({});
    router.dispatch({ type: "count_update" } as SseNotificationEvent);
    expect(wake).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('"count_update" ignored'));
  });

  it("drops connection_registered SILENTLY (no wake, never logged as ignored)", () => {
    const { router } = build({});
    // Defense-in-depth: even if the listener fork were bypassed, the router must
    // not treat connection_registered as an unhandled/ignored event.
    router.dispatch({ type: "connection_registered", connectionUuid: "c1" } as unknown as SseNotificationEvent);
    expect(wake).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining("ignored"));
  });

  it("drops a type:control event SILENTLY (no wake, never logged as ignored)", () => {
    const { router } = build({});
    router.dispatch({ type: "control", command: "interrupt" } as unknown as SseNotificationEvent);
    expect(wake).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining("ignored"));
  });

  it("warns and skips when notificationUuid is missing", () => {
    const { router } = build({});
    router.dispatch({ type: "new_notification" } as SseNotificationEvent);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("missing notificationUuid"));
  });

  it("task_assigned: wakes the agent without auto-claiming the task", async () => {
    const { router, mcpClient } = build({
      chorus_get_notifications: { notifications: [makeNotification()] },
    });
    router.dispatch({ type: "new_notification", notificationUuid: "n1" } as SseNotificationEvent);
    await flush();

    // The plugin no longer auto-claims; it only wakes the agent.
    expect(mcpClient.callTool).not.toHaveBeenCalledWith("chorus_claim_task", expect.anything());
    expect(wake).toHaveBeenCalledOnce();
    const [msg, ctxKey] = wake.mock.calls[0];
    expect(msg).toContain("Task assigned");
    expect(msg).toContain("task-1");
    expect(msg).toContain("chorus_claim_task");
    expect(ctxKey).toBe("chorus:task_assigned:task-1");
  });

  it.each([
    ["mentioned", "idea", "@mentioned"],
    ["proposal_rejected", "proposal", "REJECTED"],
    ["proposal_approved", "proposal", "APPROVED"],
    ["idea_claimed", "idea", "assigned to you"],
    ["task_verified", "task", "verified"],
    ["task_reopened", "task", "reopened"],
    ["elaboration_requested", "idea", "Elaboration requested"],
    ["elaboration_answered", "idea", "Elaboration answers submitted"],
  ])("routes action '%s' to a wake containing %j", async (action, entityType, needle) => {
    const { router } = build({
      chorus_get_notifications: {
        notifications: [makeNotification({ action, entityType, uuid: "n1" })],
      },
    });
    router.dispatch({ type: "new_notification", notificationUuid: "n1" } as SseNotificationEvent);
    await flush();
    expect(wake).toHaveBeenCalledOnce();
    expect(wake.mock.calls[0][0]).toContain(needle);
    expect(wake.mock.calls[0][1]).toBe(`chorus:${action}:task-1`);
  });

  it("logs (no wake) for an unhandled action", async () => {
    const { router } = build({
      chorus_get_notifications: { notifications: [makeNotification({ action: "some_future_thing" })] },
    });
    router.dispatch({ type: "new_notification", notificationUuid: "n1" } as SseNotificationEvent);
    await flush();
    expect(wake).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("Unhandled notification action"));
  });

  it("warns when the notification UUID is not in the unread list", async () => {
    const { router } = build({
      chorus_get_notifications: { notifications: [makeNotification({ uuid: "different" })] },
    });
    router.dispatch({ type: "new_notification", notificationUuid: "n1" } as SseNotificationEvent);
    await flush();
    expect(wake).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("not found in unread list"));
  });

  it("does not throw when the notifications fetch returns a malformed payload", async () => {
    const { router } = build({ chorus_get_notifications: { notifications: "nope" } });
    router.dispatch({ type: "new_notification", notificationUuid: "n1" } as SseNotificationEvent);
    await flush();
    expect(wake).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Could not fetch notifications"));
  });
});

describe("ChorusEventRouter — wake attribution (daemon parity)", () => {
  let wake: ReturnType<typeof vi.fn>;
  let logger: ReturnType<typeof makeLogger>;

  beforeEach(() => {
    wake = vi.fn();
    logger = makeLogger();
  });

  function build(responses: Record<string, unknown>, lineage?: { resolve: ReturnType<typeof vi.fn> }) {
    const mcpClient = makeMcpClient(responses) as never;
    const router = new ChorusEventRouter({ mcpClient, wake, logger, lineage: lineage as never });
    return { router };
  }

  it("resolves lineage and threads { entity*, rootIdeaUuid, directIdeaUuid } as the wake attribution", async () => {
    const resolve = vi.fn(async () => ({ rootIdeaUuid: "root-1", directIdeaUuid: "direct-1" }));
    const { router } = build(
      { chorus_get_notifications: { notifications: [makeNotification()] } },
      { resolve },
    );
    router.dispatch({ type: "new_notification", notificationUuid: "n1" } as SseNotificationEvent);
    await flush();

    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ entityType: "task", entityUuid: "task-1" }));
    const attribution = wake.mock.calls[0][2];
    expect(attribution).toEqual({
      entityType: "task",
      entityUuid: "task-1",
      rootIdeaUuid: "root-1",
      directIdeaUuid: "direct-1",
    });
  });

  it("falls back to entity-only attribution when lineage resolve throws (wake not lost)", async () => {
    const resolve = vi.fn(async () => {
      throw new Error("boom");
    });
    const { router } = build(
      { chorus_get_notifications: { notifications: [makeNotification()] } },
      { resolve },
    );
    router.dispatch({ type: "new_notification", notificationUuid: "n1" } as SseNotificationEvent);
    await flush();

    expect(wake).toHaveBeenCalledOnce();
    expect(wake.mock.calls[0][2]).toEqual({ entityType: "task", entityUuid: "task-1" });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Lineage resolve failed"));
  });

  it("threads entity-only attribution when no lineage resolver is wired", async () => {
    const { router } = build({ chorus_get_notifications: { notifications: [makeNotification()] } });
    router.dispatch({ type: "new_notification", notificationUuid: "n1" } as SseNotificationEvent);
    await flush();
    expect(wake.mock.calls[0][2]).toEqual({ entityType: "task", entityUuid: "task-1" });
  });
});
