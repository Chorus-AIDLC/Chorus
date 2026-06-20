import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

import { resolveConfig, validateConfigWithWarnings } from "./config.js";
import { ensureChorusMcpServer } from "./mcp-registration.js";
import { ChorusMcpClient } from "./mcp-client.js";
import { ChorusSseListener } from "./sse-listener.js";
import { ChorusEventRouter, type WakeAttribution } from "./event-router.js";
import { resolveWakeRunContext } from "./wake.js";
import { registerChorusCommands } from "./commands.js";
import { ConnectionState } from "./connection-state.js";
import { createControlHandler, type ControlBehaviorHooks } from "./control-handler.js";
import { createDaemonRestClient } from "./daemon-rest-client.js";
import { LineageResolver } from "./lineage.js";
import { OpenClawDaemonClient, type WakeRequest } from "./daemon-client.js";
import type { DaemonPendingTurn } from "./daemon-rest-client.js";

/**
 * JSON-Schema config contract for the Chorus plugin.
 *
 * This mirrors the canonical `configSchema` in `openclaw.plugin.json`
 * (the manifest is validated by the host BEFORE this code loads). Keep the two
 * in sync: same property set, same `additionalProperties: false`.
 */
const CHORUS_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    chorusUrl: {
      type: "string",
      description: "Chorus server URL (e.g. https://chorus.example.com)",
    },
    apiKey: {
      type: "string",
      description: "Chorus API Key (cho_ prefix)",
    },
  },
} as const;

export default definePluginEntry({
  id: "chorus-openclaw-plugin",
  name: "Chorus",
  description:
    "Chorus AI-DLC collaboration platform — native MCP + SSE real-time events",
  configSchema: {
    jsonSchema: CHORUS_JSON_SCHEMA,
    uiHints: { apiKey: { sensitive: true } },
  },

  register(api: OpenClawPluginApi) {
    // 1. Discovery-mode guard: heavy runtime wiring (MCP connect, SSE socket,
    //    config mutation) must run ONLY in "full" registration mode. In
    //    discovery / cli-metadata / setup-* modes we declare nothing heavy.
    if (api.registrationMode !== "full") return;

    // 2. Resolve + validate config from the host-validated pluginConfig bag.
    const config = resolveConfig(api.pluginConfig);
    const logger = api.logger;
    if (!validateConfigWithWarnings(config, logger)) {
      return;
    }

    // After validateConfigWithWarnings, chorusUrl and apiKey are present.
    const chorusUrl = config.chorusUrl!;
    const apiKey = config.apiKey!;

    logger.info(`Chorus plugin initializing — ${chorusUrl}`);

    // 3. Ensure the Chorus MCP server is registered with OpenClaw so the agent
    //    gains native chorus__* tools (fire-and-log; real impl in sibling task).
    void ensureChorusMcpServer(api, config).catch((err) =>
      logger.error(`MCP registration failed: ${err}`),
    );

    // 4. Slim MCP client for the plugin's own synchronous calls (checkin,
    //    assignments, notifications back-fill).
    const mcpClient = new ChorusMcpClient({ chorusUrl, apiKey, logger });

    // 4b. Connection identity + reverse control channel + daemon reporting (parity).
    //     `connectionState` holds the DaemonConnection uuid the server reports
    //     post-handshake (captured by the listener's onConnectionId); it is the
    //     single source of truth for "which connection am I", read by the control
    //     handler's double-check AND the daemon REST reporter (lazily, so order
    //     doesn't matter — both predate the handshake).
    const connectionState = new ConnectionState();

    //     The shared pure-REST daemon client owns the `/api/daemon/*` payload shapes
    //     (turn-advance / transcript / execution-state / report-interrupt /
    //     pending-turns). It reads the connectionUuid lazily from connectionState.
    const restClient = createDaemonRestClient({
      url: chorusUrl,
      apiKey,
      getConnectionUuid: () => connectionState.getConnectionUuid(),
      logger,
    });

    //     Lineage resolver: per-notification { rootIdeaUuid, directIdeaUuid } via the
    //     root-idea REST endpoint, so the daemon client anchors the session on the
    //     DIRECT idea (resume/deliver_turn continuity) and reports the ROOT idea in
    //     its execution snapshot (the two-id contract).
    const lineage = new LineageResolver({ url: chorusUrl, apiKey, logger });

    //     The in-process daemon client wraps runEmbeddedAgent with full reporting,
    //     the AbortController registry (real mid-run interrupt), the execution
    //     snapshot source, deterministic session-key mapping, and the at-most-once
    //     pending-turns backfill. `resolveRunContext` is the ONE place that reaches
    //     into api.config/api.runtime (kept out of the client so it stays testable).
    //     `redispatch` resolves lineage for a synthetic resume so it continues the
    //     SAME session, then runs the wake; a delivered turn already carries its ids.
    let daemonClient: OpenClawDaemonClient;
    const redispatch = (req: WakeRequest): void => {
      void (async () => {
        let enriched = req;
        // A resume only knows the entity — resolve its lineage so the wake anchors on
        // the same business key (direct idea) the original run used. A delivered turn
        // already carries directIdeaUuid, so we skip the round-trip when present.
        if (req.directIdeaUuid == null && req.entityType && req.entityUuid) {
          try {
            const { rootIdeaUuid, directIdeaUuid } = await lineage.resolve({
              entityType: req.entityType,
              entityUuid: req.entityUuid,
            });
            enriched = { ...req, rootIdeaUuid, directIdeaUuid };
          } catch (err) {
            logger.warn(`[Chorus] resume lineage resolve failed: ${err}`);
          }
        }
        await daemonClient.runWake(enriched);
      })();
    };
    daemonClient = new OpenClawDaemonClient({
      restClient,
      resolveRunContext: () => resolveWakeRunContext(api, logger),
      redispatch,
      // Build the prompt for a delivered human_instruction turn. The free-text body
      // lives only on the turn (promptText); fall back to a generic nudge if absent.
      buildTurnPrompt: (turn: DaemonPendingTurn) =>
        turn.promptText && turn.promptText.trim()
          ? `[Chorus] A human sent you an instruction in this conversation:\n\n${turn.promptText}`
          : `[Chorus] A human sent you a new instruction in this conversation (session ${turn.sessionId}). Review the latest comments and respond.`,
      logger,
    });

    //     The control handler ROUTES verified control commands to the daemon client's
    //     behavior hooks (real abort / resume re-dispatch / pending-turns sweep),
    //     after its own double-check (own connection + held entity).
    const controlHooks: ControlBehaviorHooks = daemonClient.controlHooks;
    const onControl = createControlHandler({ connectionState, hooks: controlHooks, logger });

    // 5. Event router. Wakes the agent in-process by running an embedded agent turn
    //    via the daemon client (which calls api.runtime.agent.runEmbeddedAgent and
    //    reports lifecycle/transcript). The router resolves each notification's
    //    lineage, then the daemon client's runWake gracefully DROPS (logs + returns)
    //    when it cannot run — it never throws, so the SSE service stays alive.
    const wakeFn = (message: string, contextKey: string, attribution?: WakeAttribution): void => {
      void daemonClient.runWake({
        prompt: message,
        contextKey,
        entityType: attribution?.entityType,
        entityUuid: attribution?.entityUuid,
        directIdeaUuid: attribution?.directIdeaUuid,
        rootIdeaUuid: attribution?.rootIdeaUuid,
      });
    };
    const eventRouter = new ChorusEventRouter({
      mcpClient,
      logger,
      lineage,
      wake: wakeFn,
    });

    // 6. Background SSE service. The SSE socket opens only inside start(), which
    //    the host calls in full mode — keeping the heavy socket gated.
    let sseListener: ChorusSseListener | null = null;
    api.registerService({
      id: "chorus-sse",
      async start() {
        sseListener = new ChorusSseListener({
          chorusUrl,
          apiKey,
          logger,
          onEvent: (event) => eventRouter.dispatch(event),
          // Capture (and refresh on reconnect) the DaemonConnection identity the
          // server reports post-handshake. NOT a wake — forked by the listener.
          onConnectionId: (connectionUuid) => {
            connectionState.setConnectionUuid(connectionUuid);
            logger.info(`[Chorus] registered as daemon connection ${connectionUuid}`);
          },
          // Reverse control channel. The handler does the double-check and routes
          // to the behavior hooks — NEVER the wake path.
          onControl,
          onReconnect: async () => {
            // (1) Notification backfill — re-pull unread notifications missed during
            //     the gap (autonomous wakes). (2) Pending-turns backfill — re-derive
            //     this connection's unstarted human_instruction turns from the turn
            //     table and run each (the lost-deliver_turn-ping safety net). The two
            //     share the daemon client's seen-set so a turn is run at most once
            //     across live delivery + backfill. Each swallows its own errors so one
            //     failing source never aborts the other.
            try {
              const result = (await mcpClient.callTool("chorus_get_notifications", {
                status: "unread",
                autoMarkRead: false,
              })) as { notifications?: Array<{ uuid: string }> } | null;
              const count = result?.notifications?.length ?? 0;
              if (count > 0) {
                logger.info(`SSE reconnect: ${count} unread notifications to process`);
              }
            } catch (err) {
              logger.warn(`Failed to back-fill notifications: ${err}`);
            }
            await daemonClient.onReconnect();
          },
        });
        await sseListener.connect();
      },
      async stop() {
        sseListener?.disconnect();
        await mcpClient.disconnect();
      },
    });

    // 7. /chorus command (status | tasks | ideas | skills).
    registerChorusCommands(api, mcpClient, () => sseListener?.status ?? "disconnected");
  },
});
