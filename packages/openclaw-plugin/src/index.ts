// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OpenClawPluginApi = any;

import { chorusConfigSchema, type ChorusPluginConfig, validateConfigWithWarnings } from "./config.js";
import { ChorusMcpClient } from "./mcp-client.js";
import { ChorusSseListener } from "./sse-listener.js";
import { ChorusEventRouter } from "./event-router.js";
import { registerPmTools } from "./tools/pm-tools.js";
import { registerDevTools } from "./tools/dev-tools.js";
import { registerCommonTools } from "./tools/common-tools.js";
import { registerAdminTools } from "./tools/admin-tools.js";
import { registerChorusCommands } from "./commands.js";

/**
 * Trigger the OpenClaw agent by posting a system event to the gateway's
 * /hooks/wake endpoint. This enqueues the text into the agent's prompt
 * and triggers an immediate heartbeat so the agent processes it right away.
 */
async function wakeAgent(
  gatewayUrl: string,
  hooksToken: string,
  text: string,
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
) {
  try {
    const res = await fetch(`${gatewayUrl}/hooks/wake`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${hooksToken}`,
      },
      body: JSON.stringify({ text, mode: "now" }),
    });
    if (!res.ok) {
      logger.warn(`Wake agent failed: HTTP ${res.status}`);
    } else {
      logger.info(`Agent woken: ${text.slice(0, 80)}...`);
    }
  } catch (err) {
    logger.warn(`Wake agent error: ${err}`);
  }
}

const plugin = {
  id: "chorus-openclaw-plugin",
  name: "Chorus",
  description:
    "Chorus AI-DLC collaboration platform — SSE real-time events + MCP tool integration",
  configSchema: chorusConfigSchema,

  register(api: OpenClawPluginApi) {
    const rawConfig = api.pluginConfig ?? {};
    const config: ChorusPluginConfig = {
      chorusUrl: rawConfig.chorusUrl || undefined,
      apiKey: rawConfig.apiKey || undefined,
      projectUuids: rawConfig.projectUuids ?? [],
      autoStart: rawConfig.autoStart ?? true,
    };
    const logger = api.logger;

    if (!validateConfigWithWarnings(config, logger)) {
      return;
    }

    // After validateConfigWithWarnings, chorusUrl and apiKey are guaranteed present
    const chorusUrl = config.chorusUrl!;
    const apiKey = config.apiKey!;

    // Resolve gateway URL and hooks token from OpenClaw config
    const gatewayPort = api.config?.gateway?.port ?? 18789;
    const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
    const hooksToken = api.config?.hooks?.token ?? "";

    logger.info(
      `Chorus plugin initializing — ${chorusUrl} (${config.projectUuids?.length || "all"} projects)`
    );

    // --- MCP Client ---
    const mcpClient = new ChorusMcpClient({
      chorusUrl,
      apiKey,
      logger,
    });

    // --- Event Router ---
    const eventRouter = new ChorusEventRouter({
      mcpClient,
      config,
      logger,
      triggerAgent: (message: string, _metadata?: Record<string, unknown>) => {
        // Use /hooks/wake to enqueue a system event + trigger immediate heartbeat
        if (hooksToken) {
          wakeAgent(gatewayUrl, hooksToken, message, logger);
        } else {
          logger.warn(
            `[Chorus] Cannot wake agent — gateway.auth.token not configured. Event: ${message.slice(0, 100)}`
          );
        }
      },
    });

    // --- SSE Listener (background service) ---
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
            // Back-fill missed notifications after reconnect
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

    // --- Tools ---
    registerPmTools(api, mcpClient);
    registerDevTools(api, mcpClient);
    registerCommonTools(api, mcpClient);
    registerAdminTools(api, mcpClient);

    // --- Commands ---
    registerChorusCommands(api, mcpClient, () => sseListener?.status ?? "disconnected");
  },
};

export default plugin;
