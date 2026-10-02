// src/app/api/events/route.ts
// SSE Endpoint — Push real-time change events to the browser
// Auth via cookie (EventSource automatically sends cookies)

import { getAuthContext } from "@/lib/auth";
import {
  eventBus,
  type RealtimeEvent,
  type PresenceEvent,
  type ProjectAccessChangedEvent,
} from "@/lib/event-bus";
import logger from "@/lib/logger";
import {
  accessibleProjectUuids,
  resolveEntityProjectUuid,
  filterExecutionViewsByAccess,
  membershipPrincipal,
} from "@/services/project-access.service";
import { accessibleGroupUuids, getGroupAccess } from "@/services/project-group-access.service";
import {
  firstCompanyUser, invalidateImplicitGroupAdminCache,
} from "@/services/project-group-implicit-admin.service";
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
  listVisibleConnectionUuids,
  executionEventName,
  type ExecutionEvent,
} from "@/services/daemon-execution.service";
import {
  isSessionVisibleToCaller,
  listVisibleRunningSessionActivities,
  reconcileOrphanTurns,
  SESSION_ACTIVITY_EVENT_NAME,
  transcriptEventName,
  type SessionActivityEvent,
  type PublishedSessionActivityEvent,
  type TranscriptEvent,
} from "@/services/daemon-session.service";
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

const sseLogger = logger.child({ module: "sse-events" });

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
  const registration = await registerConnection(auth.companyUuid, auth.actorUuid, report);
  // Tri-state split (mirrors /api/events/notifications): a conflict wrote NO row, so
  // it gets a single `connection_conflict` event and NO per-connection lifecycle; a
  // handle gets the full lifecycle as before; a null registration leaves both null.
  const conflict = isConnectionConflict(registration) ? registration : null;
  const conn = isConnectionConflict(registration) ? null : registration;
  const notificationChannel =
    !conn && !conflict ? `notification:${auth.type}:${auth.actorUuid}` : null;

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

  // Private-project isolation: the set of projects this subscriber may see
  // (public + private-member; agents resolve via their owner inside the service).
  // Resolved before the stream opens so a query failure is a 500, never mid-stream.
  // Kept fresh by the `project_access_changed` listener below.
  const principal = membershipPrincipal(auth);
  let firstUser = await firstCompanyUser(auth.companyUuid);
  let firstUserRefreshFailed = false;
  const affectsSubscriber = (event: ProjectAccessChangedEvent) => {
    if (event.companyUuid !== auth.companyUuid) return false;
    const userUuids = Array.isArray(event.userUuids) ? event.userUuids : [];
    return userUuids.length === 0 || (!!principal && userUuids.includes(principal));
  };
  // An access change that lands WHILE the initial set is being computed would be
  // missed (the stream's listener isn't attached yet). Record it and recompute
  // once the stream starts.
  const missedAccessChanges = new Set<string>();
  const connectWindowHandler = (event: ProjectAccessChangedEvent) => {
    if (affectsSubscriber(event)) missedAccessChanges.add(event.projectUuid);
  };
  const missedGroupChanges: RealtimeEvent[] = [];
  const connectWindowGroupHandler = (event: RealtimeEvent) => {
    if (event.companyUuid === auth.companyUuid && event.entityType === "project_group") {
      missedGroupChanges.push(event);
    }
  };
  eventBus.on("project_access_changed", connectWindowHandler);
  eventBus.on("change", connectWindowGroupHandler);
  let accessibleProjects: Set<string>;
  let knownGroups: Set<string>;
  try {
    const [projects, groups] = await Promise.all([
      accessibleProjectUuids(auth),
      accessibleGroupUuids(auth),
    ]);
    accessibleProjects = new Set(projects);
    // Historical discovery is authority only for a UUID-only invalidation.
    // Every current-access decision still uses the fresh, revision-aware gate.
    knownGroups = new Set(groups);
  } catch (err) {
    eventBus.off("project_access_changed", connectWindowHandler);
    eventBus.off("change", connectWindowGroupHandler);
    throw err;
  }

  const stream = new ReadableStream({
    async start(controller) {
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

      // On a registration conflict (a live different-process daemon already holds this
      // (agent, host, cwd)), emit a single `connection_conflict` event so a daemon on
      // this endpoint warns + skips that cwd. No row was written, so NO per-connection
      // execution/transcript lifecycle is wired below (all gated on `conn`). Browser
      // clients ignore the unrecognized `type`. Symmetric with the notification route.
      if (conflict) {
        send(
          `data: ${JSON.stringify({ type: "connection_conflict", host: conflict.host, cwd: conflict.cwd })}\n\n`,
        );
      }

      // ----- Project-access gate for change/presence events -----
      // Every recompute of `accessibleProjects` and every delivery decision made
      // while a recompute is outstanding run on ONE serial promise chain. So:
      //   - an event that arrives while a recompute is in flight is decided against
      //     the NEW set once it resolves (never against the stale one), and
      //   - event order is preserved: while anything is queued on the chain, new
      //     events queue behind it instead of jumping ahead synchronously.
      // With nothing outstanding (the common case) delivery is synchronous.
      let gateChain: Promise<void> = Promise.resolve();
      let gateOutstanding = 0;
      let accessRevision = 0;
      let groupRevision = 0;
      let projectAccessClosed = false;
      const closeProjectAccess = () => {
        firstUserRefreshFailed = true;
        projectAccessClosed = true;
        // Invalidate snapshots and async delivery decisions already in flight.
        accessRevision++;
        groupRevision++;
        accessibleProjects.clear();
        invalidateImplicitGroupAdminCache(auth);
      };
      const enqueueGate = (step: () => void | Promise<void>) => {
        gateOutstanding++;
        gateChain = gateChain
          .then(step)
          .catch((err) => {
            sseLogger.error({ err }, "SSE project-access gate step failed");
          })
          .finally(() => {
            gateOutstanding--;
          });
      };

      // One queued refresh consumes a burst of child access changes. Revoke each
      // triggering project synchronously, and retry if a change arrives during
      // the query; no delivery can use an older snapshot while this step runs.
      let refreshScheduled = false;
      const refreshProjects = new Set<string>();
      const recomputeAccess = (triggerProjectUuid: string | undefined) => {
        invalidateImplicitGroupAdminCache(auth);
        accessRevision++;
        if (triggerProjectUuid) {
          accessibleProjects.delete(triggerProjectUuid);
          refreshProjects.add(triggerProjectUuid);
        }
        if (refreshScheduled) return;
        refreshScheduled = true;
        enqueueGate(async () => {
          try {
            while (!request.signal.aborted) {
              if (projectAccessClosed) return;
              const revision = accessRevision;
              const refreshed = new Set(await accessibleProjectUuids(auth));
              if (projectAccessClosed || request.signal.aborted) return;
              if (revision !== accessRevision) continue;
              accessibleProjects = refreshed;
              return;
            }
          } catch (err) {
            firstUserRefreshFailed = true;
            sseLogger.error({ err }, "SSE accessible-project recompute failed");
            if (!triggerProjectUuid) closeProjectAccess();
            for (const uuid of refreshProjects) accessibleProjects.delete(uuid);
          } finally {
            refreshProjects.clear();
            refreshScheduled = false;
          }
        });
      };

      // Group metadata has its own discovery gate, including legacy events with
      // an empty projectUuid.
      const isProjectScoped = (event: { projectUuid?: string; entityType?: string }) =>
        !!event.projectUuid && event.entityType !== "project_group";

      const gateDeliver = (
        event: { projectUuid?: string; entityType?: string; entityUuid?: string },
        deliver: () => void,
      ) => {
        if (event.entityType === "project_group") {
          enqueueGate(async () => {
            if (!event.entityUuid || request.signal.aborted) return;
            // getGroupAccess is deliberately fresh. A revoke queued while it is
            // awaiting the DB invalidates that result, even though its refresh
            // is later on this same serial chain.
            for (let attempt = 0; attempt < 3; attempt++) {
              const revision = `${accessRevision}:${groupRevision}`;
              invalidateImplicitGroupAdminCache(auth);
              const access = await getGroupAccess(auth, event.entityUuid);
              if (revision !== `${accessRevision}:${groupRevision}`) continue;
              if (request.signal.aborted) return;
              // The handler projects group events to UUID-only refreshes. A
              // previous viewer needs that refresh after deletion/revocation,
              // then loses the remembered visibility until fresh rediscovery.
              // Consuming it on this serial gate also suppresses queued updates.
              if (access.group) {
                knownGroups.add(event.entityUuid);
                deliver();
              } else if (knownGroups.delete(event.entityUuid)) {
                deliver();
              }
              return;
            }
          });
          return;
        }
        const decide = () => {
          if (isProjectScoped(event) && (projectAccessClosed || !accessibleProjects.has(event.projectUuid!))) return;
          deliver();
        };
        if (gateOutstanding === 0) decide();
        else enqueueGate(decide);
      };

      // Session activity and execution rows reference an idea / project, not a
      // RealtimeEvent projectUuid. Resolve the idea's CURRENT project per decision
      // (ideas can move between projects, so no connection-lifetime cache) and
      // check it against the live accessible set. Ad-hoc sessions (no idea) keep
      // their existing owner/company scoping; an idea that no longer resolves is
      // hidden (fail closed).
      const canSeeIdea = async (
        ideaUuid: string | null | undefined,
        memo?: Map<string, Promise<string | null>>,
      ): Promise<boolean> => {
        if (!ideaUuid) return true;
        if (projectAccessClosed) return false;
        let pending = memo?.get(ideaUuid);
        if (!pending) {
          pending = resolveEntityProjectUuid(auth.companyUuid, "idea", ideaUuid);
          memo?.set(ideaUuid, pending);
        }
        const ideaProjectUuid = await pending;
        return !projectAccessClosed && !!ideaProjectUuid && accessibleProjects.has(ideaProjectUuid);
      };

      // Subscribe to change events
      const handler = (event: RealtimeEvent) => {
        // Filter by company (multi-tenancy)
        if (event.companyUuid !== auth.companyUuid) return;
        if (event.entityType === "project_group") groupRevision++;
        // Optionally filter by project
        if (projectUuid && event.projectUuid !== projectUuid) return;

        // A project created after connect is not in the set yet (creation emits no
        // project_access_changed). Recompute once, then decide against the new set:
        // a public project or one we were made a member of is delivered; a private
        // project we cannot see is still dropped.
        if (
          event.entityType === "project" &&
          event.action === "created" &&
          event.projectUuid &&
          !accessibleProjects.has(event.projectUuid)
        ) {
          recomputeAccess(undefined);
        }

        const payload = event.entityType === "project_group" ? {
          companyUuid: auth.companyUuid,
          projectUuid: "",
          entityType: "project_group",
          entityUuid: event.entityUuid,
          action: event.action,
        } : event;
        gateDeliver(event, () => send(`data: ${JSON.stringify(payload)}\n\n`));
      };

      eventBus.on("change", handler);
      eventBus.off("change", connectWindowGroupHandler);
      for (const event of missedGroupChanges) handler(event);

      // Subscribe to presence events
      const presenceHandler = (event: PresenceEvent) => {
        // Filter by company (multi-tenancy)
        if (event.companyUuid !== auth.companyUuid) return;
        // Filter by project
        if (projectUuid && event.projectUuid !== projectUuid) return;

        gateDeliver(event, () =>
          send(`data: ${JSON.stringify({ type: "presence", ...event })}\n\n`),
        );
      };

      eventBus.on("presence", presenceHandler);

      // Refresh the accessible set when a project's visibility or membership
      // changes. Empty userUuids = visibility flip (may affect everyone); otherwise
      // only recompute when our membership principal (user, or agent's owner) is
      // among the changed users.
      const accessChangedHandler = (event: ProjectAccessChangedEvent) => {
        if (!affectsSubscriber(event)) return;
        // Fail closed immediately, including asynchronous delivery decisions
        // already ahead of the refresh on the serial gate.
        recomputeAccess(event.projectUuid);
      };

      eventBus.on("project_access_changed", accessChangedHandler);
      eventBus.off("project_access_changed", connectWindowHandler);
      // Catch up on any access change that raced the initial computation.
      for (const missed of missedAccessChanges) recomputeAccess(missed);

      // Browser notifications share this company-wide dashboard stream. Daemon
      // clients have a registered connection and keep using the dedicated
      // /api/events/notifications transport for registration/control/liveness.
      const notificationHandler = (event: Record<string, unknown>) => {
        gateDeliver({ projectUuid: typeof event.projectUuid === "string" ? event.projectUuid : undefined }, () =>
          send(`data: ${JSON.stringify(event)}\n\n`),
        );
      };
      if (notificationChannel) {
        eventBus.on(notificationChannel, notificationHandler);
      }

      // Subscribe to per-connection execution-state events for every connection
      // this caller may see. Each event is forwarded tagged with a `type:
      // "execution"` discriminator the client routes on (alongside change +
      // presence). The companyUuid is re-checked defensively even though the
      // channel is already owner/self scoped, mirroring the change/presence
      // multi-tenancy fence. The full active set rides in the event payload, so
      // the client re-renders without a follow-up read round-trip.
      const executionHandler = (event: ExecutionEvent) => {
        if (event.companyUuid !== auth.companyUuid) return;
        // Connection ownership is not project access: drop execution rows (and
        // their titles) for projects the caller can no longer see. Decided on the
        // serial gate so it uses the current set and keeps event order.
        enqueueGate(async () => {
          // Same rule as the REST execution reads (drop hidden rows, redact hidden
          // lineage anchors), judged against this stream's live accessible set.
          for (let attempt = 0; attempt < 3; attempt++) {
            const revision = accessRevision;
            const executions = await filterExecutionViewsByAccess(
              auth, event.executions ?? [], accessibleProjects,
            );
            if (revision !== accessRevision) continue;
            if (!request.signal.aborted) {
              send(`data: ${JSON.stringify({ type: "execution", ...event, executions })}\n\n`);
            }
            return;
          }
        });
      };
      const executionChannels = visibleConnectionUuids.map(executionEventName);
      for (const channel of executionChannels) {
        eventBus.on(channel, executionHandler);
      }

      // Attach the company-wide activity listener BEFORE reading the running-turn
      // snapshot. Live events that land during the query are buffered and flushed
      // after replay, so a concurrent end always wins over a stale snapshot row.
      // Ownership travels only on the process-local event and is projected here
      // into subscriber-relative `canOpen`; it is never sent over the wire.
      let activityBootstrapping = true;
      const bufferedActivityEvents: SessionActivityEvent[] = [];
      const projectActivity = (
        event: PublishedSessionActivityEvent,
      ): SessionActivityEvent | null => {
        if (event.companyUuid !== auth.companyUuid) return null;
        if (auth.type === "agent" && event.agentUuid !== auth.actorUuid) {
          return null;
        }
        const { agentOwnerUuid, ...activity } = event;
        return {
          ...activity,
          canOpen:
            auth.type === "agent"
              ? event.agentUuid === auth.actorUuid
              : agentOwnerUuid === auth.actorUuid,
        };
      };
      const sessionActivityHandler = (event: PublishedSessionActivityEvent) => {
        const projected = projectActivity(event);
        if (!projected) return;
        // Idea-anchored sessions are project data: hide them from callers who
        // cannot see the idea's project (ids alone reveal a private session).
        enqueueGate(async () => {
          if (!(await canSeeIdea(projected.directIdeaUuid).catch(() => false))) return;
          if (activityBootstrapping) {
            bufferedActivityEvents.push(projected);
            return;
          }
          send(`data: ${JSON.stringify(projected)}\n\n`);
        });
      };
      eventBus.on(SESSION_ACTIVITY_EVENT_NAME, sessionActivityHandler);

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
        void firstCompanyUser(auth.companyUuid).then((current) => {
          if (request.signal.aborted || (current === firstUser && !firstUserRefreshFailed)) return;
          firstUserRefreshFailed = false;
          projectAccessClosed = false;
          firstUser = current;
          invalidateImplicitGroupAdminCache(auth);
          accessibleProjects.clear();
          groupRevision++;
          recomputeAccess(undefined);
          // Each stream detects the same change independently. Refresh only this
          // subscriber, rather than multiplying company-wide/Redis broadcasts.
          if (!projectUuid) enqueueGate(async () => {
            try {
              while (!request.signal.aborted) {
                const revision = `${accessRevision}:${groupRevision}`;
                const refreshed = new Set(await accessibleGroupUuids(auth));
                if (revision !== `${accessRevision}:${groupRevision}`) continue;
                const changed = new Set([...knownGroups, ...refreshed]);
                knownGroups = refreshed;
                for (const entityUuid of changed) {
                  send(`data: ${JSON.stringify({
                    companyUuid: auth.companyUuid, projectUuid: "",
                    entityType: "project_group", entityUuid, action: "updated",
                  })}\n\n`);
                }
                return;
              }
            } catch (err) {
              closeProjectAccess();
              sseLogger.error({ err }, "SSE automatic Admin group refresh failed");
            }
          });
        }).catch((err) => {
          closeProjectAccess();
          sseLogger.error({ err }, "SSE automatic Admin refresh failed");
        });
        // Liveness safety net: bump lastSeenAt. Fire-and-forget — the service
        // swallows + logs its own errors and never throws.
        if (conn) void touchConnection(auth.companyUuid, conn);
      }, 30_000);

      // Cleanup on abort (client disconnect)
      request.signal.addEventListener("abort", () => {
        eventBus.off("change", handler);
        eventBus.off("presence", presenceHandler);
        eventBus.off("project_access_changed", accessChangedHandler);
        if (notificationChannel) {
          eventBus.off(notificationChannel, notificationHandler);
        }
        for (const channel of executionChannels) {
          eventBus.off(channel, executionHandler);
        }
        eventBus.off(SESSION_ACTIVITY_EVENT_NAME, sessionActivityHandler);
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

      const runningActivities =
        await listVisibleRunningSessionActivities(auth);
      if (request.signal.aborted) return;
      // Replay on the gate, AFTER any live events already queued during the
      // snapshot query (they were buffered), with the same project filter.
      enqueueGate(async () => {
        if (request.signal.aborted) return;
        try {
          const memo = new Map<string, Promise<string | null>>();
          for (const event of runningActivities) {
            // A failed lookup hides that row (fail closed) instead of aborting the replay.
            if (await canSeeIdea(event.directIdeaUuid, memo).catch(() => false)) {
              send(`data: ${JSON.stringify(event)}\n\n`);
            }
          }
        } finally {
          // Always leave bootstrap mode, so live activity is never stuck in the buffer.
          activityBootstrapping = false;
          // Buffered events were judged when they arrived; access may have changed
          // since (e.g. removal during the snapshot query). Re-check each against
          // the CURRENT set at send time; a failed lookup hides that event.
          const flushMemo = new Map<string, Promise<string | null>>();
          for (const event of bufferedActivityEvents) {
            if (await canSeeIdea(event.directIdeaUuid, flushMemo).catch(() => false)) {
              send(`data: ${JSON.stringify(event)}\n\n`);
            }
          }
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
