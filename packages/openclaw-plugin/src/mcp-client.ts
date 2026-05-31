/**
 * Plugin-INTERNAL MCP client.
 *
 * This is NOT how the agent gets Chorus tools — those are exposed natively by
 * OpenClaw connecting to the `mcp.servers.chorus` entry written by
 * `ensureChorusMcpServer` (see mcp-registration.ts). The plugin no longer
 * hand-wraps any Chorus tool with `api.registerTool`.
 *
 * This client exists only for the plugin's OWN synchronous calls into Chorus:
 *   - `/chorus` command: chorus_checkin, chorus_get_my_assignments,
 *     chorus_get_available_ideas (see commands.ts)
 *   - SSE reconnect back-fill: chorus_get_notifications (see index.ts)
 *
 * No agent-facing tool depends on it. Keep it a generic StreamableHTTP
 * `callTool` client (lazy connect + 404 reconnect); do not grow it into a tool
 * surface.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export type McpClientStatus = "disconnected" | "connecting" | "connected" | "reconnecting";

export interface ChorusMcpClientOptions {
  chorusUrl: string;
  apiKey: string;
  logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
}

/**
 * Wraps @modelcontextprotocol/sdk Client with:
 * - Lazy connection (connect on first callTool)
 * - Auto-reconnect on session expiry (404)
 * - Status tracking
 * - Graceful disconnect
 */
export class ChorusMcpClient {
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;
  private _status: McpClientStatus = "disconnected";
  private readonly opts: ChorusMcpClientOptions;

  constructor(opts: ChorusMcpClientOptions) {
    this.opts = opts;
  }

  get status(): McpClientStatus {
    return this._status;
  }

  /** Establish MCP connection. Called lazily on first callTool. */
  async connect(): Promise<void> {
    if (this._status === "connected" && this.client) return;

    this._status = "connecting";
    try {
      this.transport = new StreamableHTTPClientTransport(
        new URL("/api/mcp", this.opts.chorusUrl),
        {
          requestInit: {
            headers: {
              Authorization: `Bearer ${this.opts.apiKey}`,
            },
          },
        }
      );

      this.client = new Client({
        name: "openclaw-chorus",
        version: "0.1.0",
      });

      await this.client.connect(this.transport);
      this._status = "connected";
      this.opts.logger.info("MCP connection established");
    } catch (err) {
      this._status = "disconnected";
      this.client = null;
      this.transport = null;
      throw err;
    }
  }

  /**
   * Call a Chorus MCP tool. Handles lazy connection and auto-reconnect.
   * Returns parsed JSON from the first text content block.
   */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    // Lazy connect
    if (!this.client || this._status !== "connected") {
      await this.connect();
    }

    try {
      return await this._doCallTool(name, args);
    } catch (err: unknown) {
      // Session expired (404) or connection lost — reconnect and retry once
      if (this.isSessionExpiredError(err)) {
        this.opts.logger.warn("MCP session expired, reconnecting...");
        this._status = "reconnecting";
        this.client = null;
        this.transport = null;
        await this.connect();
        return await this._doCallTool(name, args);
      }
      throw err;
    }
  }

  /** Graceful disconnect. */
  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close();
      } catch {
        // Ignore close errors
      }
    }
    this.client = null;
    this.transport = null;
    this._status = "disconnected";
    this.opts.logger.info("MCP connection closed");
  }

  private async _doCallTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.client) throw new Error("MCP client not connected");

    const result = await this.client.callTool({ name, arguments: args });

    if (result.isError) {
      const errorText = (result.content as Array<{ type: string; text?: string }>)
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      throw new Error(`Chorus MCP tool error (${name}): ${errorText}`);
    }

    // Parse first text content block as JSON
    const textContent = (result.content as Array<{ type: string; text?: string }>).find(
      (c) => c.type === "text"
    );
    if (!textContent?.text) return null;

    try {
      return JSON.parse(textContent.text);
    } catch {
      // Return raw text if not valid JSON
      return textContent.text;
    }
  }

  private isSessionExpiredError(err: unknown): boolean {
    if (err instanceof Error) {
      const msg = err.message.toLowerCase();
      return msg.includes("404") || msg.includes("session") || msg.includes("not found");
    }
    return false;
  }
}
