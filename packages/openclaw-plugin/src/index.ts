import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

import { resolveConfig, validateConfigWithWarnings } from "./config.js";
import { ensureChorusMcpServer } from "./mcp-registration.js";
import { ChorusMcpClient } from "./mcp-client.js";
import { ChorusSseListener } from "./sse-listener.js";
import { ChorusEventRouter } from "./event-router.js";
import { createWake } from "./wake.js";
import { registerChorusCommands } from "./commands.js";

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

    // 5. Event router. Wakes the agent in-process by running an embedded agent
    //    turn via `api.runtime.agent.runEmbeddedAgent` (see wake.ts). `createWake`
    //    resolves the main agent session + configured model on each wake and
    //    gracefully DROPS (logs + returns) when it cannot run — it never throws,
    //    so the SSE service stays alive even on a host that exposes no session.
    const eventRouter = new ChorusEventRouter({
      mcpClient,
      logger,
      wake: createWake(api, logger),
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
          onReconnect: async () => {
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
