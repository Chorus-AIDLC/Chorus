// src/app/api/events/route.ts
// SSE Endpoint — Push real-time change events to the browser
// Auth via cookie (EventSource automatically sends cookies)

import { getAuthContext } from "@/lib/auth";
import { eventBus, type RealtimeEvent, type PresenceEvent } from "@/lib/event-bus";
import {
  parseSelfReport,
  registerConnection,
  touchConnection,
  markDisconnected,
} from "@/services/daemon-connection.service";
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await getAuthContext(request);
  if (!auth) {
    return new Response("Unauthorized", { status: 401 });
  }

  const projectUuid = request.nextUrl.searchParams.get("projectUuid");

  // Self-report registry (auth is already settled above — these query params
  // are read AFTER auth and never influence the authorization outcome).
  // connUuid is null for non-daemon (browser/unknown/absent) clientType; when
  // null, the lifecycle below is skipped and the route behaves exactly as before
  // (no DaemonConnection row is written).
  const report = parseSelfReport(request.nextUrl.searchParams);
  const conn = await registerConnection(auth.companyUuid, auth.actorUuid, report);

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();

      const send = (data: string) => {
        try {
          controller.enqueue(encoder.encode(data));
        } catch {
          // Stream closed
        }
      };

      // Send initial connection confirmation
      send(": connected\n\n");

      // Subscribe to change events
      const handler = (event: RealtimeEvent) => {
        // Filter by company (multi-tenancy)
        if (event.companyUuid !== auth.companyUuid) return;
        // Optionally filter by project
        if (projectUuid && event.projectUuid !== projectUuid) return;

        send(`data: ${JSON.stringify(event)}\n\n`);
      };

      eventBus.on("change", handler);

      // Subscribe to presence events
      const presenceHandler = (event: PresenceEvent) => {
        // Filter by company (multi-tenancy)
        if (event.companyUuid !== auth.companyUuid) return;
        // Filter by project
        if (projectUuid && event.projectUuid !== projectUuid) return;

        send(`data: ${JSON.stringify({ type: "presence", ...event })}\n\n`);
      };

      eventBus.on("presence", presenceHandler);

      // Heartbeat every 30s to keep connection alive
      const heartbeat = setInterval(() => {
        send(": heartbeat\n\n");
        // Liveness safety net: bump lastSeenAt. Fire-and-forget — the service
        // swallows + logs its own errors and never throws.
        if (conn) void touchConnection(auth.companyUuid, conn);
      }, 30_000);

      // Cleanup on abort (client disconnect)
      request.signal.addEventListener("abort", () => {
        eventBus.off("change", handler);
        eventBus.off("presence", presenceHandler);
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // Already closed
        }
        // Primary disconnect signal: mark the registry row offline.
        // Fire-and-forget — never throws to the client.
        if (conn) void markDisconnected(auth.companyUuid, conn);
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
