// src/app/api/events/notifications/route.ts
// User-scoped SSE endpoint for real-time notification delivery
// Auth via cookie (EventSource automatically sends cookies)

import { getAuthContext } from "@/lib/auth";
import { eventBus, controlEventName } from "@/lib/event-bus";
import {
  parseSelfReport,
  registerConnection,
  touchConnection,
  markDisconnected,
} from "@/services/daemon-connection.service";
import {
  reconcileOffline,
  publishExecutionChange,
} from "@/services/daemon-execution.service";
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await getAuthContext(request);
  if (!auth) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Self-report registry (auth is already settled above — these query params
  // are read AFTER auth and never influence the authorization outcome).
  // connUuid is null for non-daemon (browser/unknown/absent) clientType; when
  // null, the lifecycle below is skipped and the route behaves exactly as before
  // (no DaemonConnection row is written).
  const report = parseSelfReport(request.nextUrl.searchParams);
  const conn = await registerConnection(auth.companyUuid, auth.actorUuid, report);

  const userKey = `${auth.type}:${auth.actorUuid}`;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const send = (data: string) => {
        try {
          controller.enqueue(encoder.encode(data));
        } catch {
          // Stream closed
        }
      };

      // Send initial connection confirmation
      send(": connected\n\n");

      // Tell a self-reporting daemon which DaemonConnection it registered as, so
      // it can attribute its execution-state snapshots to this connection
      // (POST /api/daemon/execution-state requires the connectionUuid). Emitted
      // as a normal data event the daemon's SSE listener parses; browser clients
      // ignore the unrecognized `type`. Only sent when a connection row was
      // actually registered (conn is null for non-daemon clientTypes).
      if (conn) {
        send(
          `data: ${JSON.stringify({ type: "connection_registered", connectionUuid: conn.uuid })}\n\n`,
        );
      }

      // Subscribe to notification events for this user
      const handler = (event: Record<string, unknown>) => {
        send(`data: ${JSON.stringify(event)}\n\n`);
      };

      eventBus.on(`notification:${userKey}`, handler);

      // Subscribe the per-connection reverse-control handler (子3) — only for a
      // real daemon connection (conn non-null). The control event is keyed per
      // connection (`control:{conn.uuid}`) so an interrupt reaches only the one
      // daemon stream holding the subprocess, never every connection of the agent.
      // It is forwarded verbatim as a `type:"control"` SSE data event the daemon's
      // listener forks to its control handler — NOT a wake, NOT a Notification.
      // Browser clients have no `conn`, so they never subscribe and never receive it.
      const controlHandler = conn
        ? (event: Record<string, unknown>) => {
            send(`data: ${JSON.stringify(event)}\n\n`);
          }
        : null;
      if (conn && controlHandler) {
        eventBus.on(controlEventName(conn.uuid), controlHandler);
      }

      // Heartbeat every 30s to keep connection alive
      const heartbeat = setInterval(() => {
        send(": heartbeat\n\n");
        // Liveness safety net: bump lastSeenAt. Fire-and-forget — the service
        // swallows + logs its own errors and never throws.
        if (conn) void touchConnection(auth.companyUuid, conn);
      }, 30_000);

      // Cleanup on abort (client disconnect)
      request.signal.addEventListener("abort", () => {
        eventBus.off(`notification:${userKey}`, handler);
        // Tear down the per-connection control subscription alongside the
        // notification handler (only present for a real daemon connection).
        if (conn && controlHandler) {
          eventBus.off(controlEventName(conn.uuid), controlHandler);
        }
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // Already closed
        }
        // Primary disconnect signal: mark the registry row offline, then
        // reconcile its running/queued execution rows to the `ended` terminal
        // state (rows retained as history) and push the now-empty active set to
        // any UI viewing this connection. All fire-and-forget — never throw to
        // the client; the reconcile + publish swallow + log their own errors.
        if (conn) {
          void markDisconnected(auth.companyUuid, conn);
          void reconcileOffline(auth.companyUuid, conn.uuid).then(() =>
            publishExecutionChange(auth.companyUuid, conn.uuid),
          );
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
