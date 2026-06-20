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
import {
  reconcileOffline,
  publishExecutionChange,
  listVisibleConnectionUuids,
  executionEventName,
  type ExecutionEvent,
} from "@/services/daemon-execution.service";
import {
  isSessionVisibleToCaller,
  transcriptEventName,
  type TranscriptEvent,
} from "@/services/daemon-session.service";
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

  // Resolve which daemon connections this caller may see (owner/self scoped) so
  // the stream can forward their per-connection `execution:{uuid}` events. The
  // execution channel is per-connection, so we subscribe to exactly the visible
  // set — never another owner's, never cross-company. Resolved at stream-start;
  // a connection that registers later is picked up by the next stream (the page's
  // connection poll + EventSource reconnect re-resolve this set). Resolved here so
  // a query failure surfaces as a 500 before the stream opens, never mid-stream.
  const visibleConnectionUuids = await listVisibleConnectionUuids(auth);

  // Optional per-session transcript subscription. The chat surface reconnects this
  // stream with `?sessionUuid=<uuid>` when a conversation opens (and without it when
  // none is open). We resolve visibility HERE — before the stream opens — under the
  // SAME owner/self + company fence the read route uses, so:
  //   - a query failure surfaces as a 500 before the stream opens (never mid-stream),
  //     mirroring how `listVisibleConnectionUuids` is resolved above; and
  //   - a session the caller cannot see is SILENTLY not subscribed (we never confirm
  //     it exists — non-disclosure). When `sessionUuid` is absent, no transcript
  //     channel is subscribed at all.
  // Only the channel name is kept; if `transcriptChannel` is null no transcript
  // handler is bound, so a non-visible / absent session forwards no transcript events.
  const requestedSessionUuid = request.nextUrl.searchParams.get("sessionUuid");
  const transcriptChannel =
    requestedSessionUuid && (await isSessionVisibleToCaller(auth, requestedSessionUuid))
      ? transcriptEventName(requestedSessionUuid)
      : null;

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

      // Subscribe to per-connection execution-state events for every connection
      // this caller may see. Each event is forwarded tagged with a `type:
      // "execution"` discriminator the client routes on (alongside change +
      // presence). The companyUuid is re-checked defensively even though the
      // channel is already owner/self scoped, mirroring the change/presence
      // multi-tenancy fence. The full active set rides in the event payload, so
      // the client re-renders without a follow-up read round-trip.
      const executionHandler = (event: ExecutionEvent) => {
        if (event.companyUuid !== auth.companyUuid) return;
        send(`data: ${JSON.stringify({ type: "execution", ...event })}\n\n`);
      };
      const executionChannels = visibleConnectionUuids.map(executionEventName);
      for (const channel of executionChannels) {
        eventBus.on(channel, executionHandler);
      }

      // Subscribe the OPEN conversation's transcript channel (when one was requested
      // AND verified visible above). Each event is forwarded tagged `type:
      // "transcript"` — the discriminator the client routes on alongside change /
      // presence / execution. The companyUuid is re-checked defensively even though
      // visibility was already fenced at subscribe time, mirroring the
      // change/presence/execution multi-tenancy fence (an event from another company is
      // dropped, never forwarded). The payload carries the affected `turn` plus, on the
      // `transcript_appended` trigger, the appended message tail — so the client patches
      // the open turn without a follow-up read.
      const transcriptHandler = (event: TranscriptEvent) => {
        if (event.companyUuid !== auth.companyUuid) return;
        send(`data: ${JSON.stringify({ type: "transcript", ...event })}\n\n`);
      };
      if (transcriptChannel) {
        eventBus.on(transcriptChannel, transcriptHandler);
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
        eventBus.off("change", handler);
        eventBus.off("presence", presenceHandler);
        for (const channel of executionChannels) {
          eventBus.off(channel, executionHandler);
        }
        if (transcriptChannel) {
          eventBus.off(transcriptChannel, transcriptHandler);
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
