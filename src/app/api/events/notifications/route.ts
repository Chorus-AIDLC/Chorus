// src/app/api/events/notifications/route.ts
// User-scoped SSE endpoint for real-time notification delivery
// Auth via cookie (EventSource automatically sends cookies)

import { getAuthContext } from "@/lib/auth";
import { eventBus, controlEventName } from "@/lib/event-bus";
import {
  parseSelfReport,
  registerConnection,
  isConnectionConflict,
  touchConnection,
  markDisconnected,
  STALE_THRESHOLD_MS,
} from "@/services/daemon-connection.service";
import {
  reconcileOffline,
  publishExecutionChange,
} from "@/services/daemon-execution.service";
import { reconcileOrphanTurns } from "@/services/daemon-session.service";
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
  const acknowledgmentAware = report.livenessAck === "v1";
  const registration = await registerConnection(auth.companyUuid, auth.actorUuid, report);
  // Split the tri-state result into two narrow bindings:
  //  - `conflict`: a live different-process daemon already holds this (agent, host, cwd).
  //    NO row was written, so we wire up NO per-connection lifecycle; instead the stream
  //    emits a single `connection_conflict` event so the daemon can warn + skip that cwd.
  //  - `conn`: a real registered connection (handle) — the full lifecycle is wired as
  //    before. `null` registration (non-daemon clientType / swallowed write failure)
  //    leaves both null and the route behaves exactly as before this change.
  const conflict = isConnectionConflict(registration) ? registration : null;
  const conn = isConnectionConflict(registration) ? null : registration;

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

      // First data event tells the daemon how its registration resolved. Exactly
      // one of three outcomes:
      //  - conflict → a single `connection_conflict` event carrying the conflicting
      //    host + cwd, so the daemon warns and skips that cwd (it must NOT also get a
      //    `connection_registered`, since no row was written).
      //  - registered → the usual `connection_registered` with the connectionUuid the
      //    daemon attributes its execution-state snapshots to.
      //  - neither (non-daemon clientType) → no handshake event at all, as before.
      // Browser clients ignore both unrecognized `type`s (same as today's
      // connection_registered / control).
      if (conflict) {
        send(
          `data: ${JSON.stringify({ type: "connection_conflict", host: conflict.host, cwd: conflict.cwd })}\n\n`,
        );
      } else if (conn) {
        send(
          `data: ${JSON.stringify({
            type: "connection_registered",
            connectionUuid: conn.uuid,
            ...(acknowledgmentAware ? { connectedAt: conn.connectedAt.toISOString() } : {}),
          })}\n\n`,
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
        if (conn && !acknowledgmentAware) void touchConnection(auth.companyUuid, conn);
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
          // Deferred orphan-turn reconcile: unlike executions (flipped immediately
          // above), a running TURN gets the full staleness window before being
          // declared interrupted — SSE streams reconnect transiently, and
          // reconcileOrphanTurns re-verifies age-only eligibility at fire time, so a
          // reconnected daemon (fresh lastSeenAt) makes this a no-op. Per-instance
          // best-effort: unref'd so it never holds the process; a timer lost to a
          // server restart is covered by the read-time fallback.
          const orphanTimer = setTimeout(() => {
            void reconcileOrphanTurns(auth.companyUuid, conn.uuid);
          }, STALE_THRESHOLD_MS);
          orphanTimer.unref?.();
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
