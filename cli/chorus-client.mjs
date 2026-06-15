// cli/chorus-client.mjs
// Minimal MCP client for the Chorus CLI daemon's OWN calls into the server
// (login validation, notification backfill, lineage resolution). Reuses
// @modelcontextprotocol/sdk, already a top-level dependency — adds no new dep
// (CLAUDE.md pitfall #9). Plain ESM port of packages/openclaw-plugin/src/mcp-client.ts.
//
// This is the daemon's client to Chorus; it is NOT how the spawned Claude Code
// gets its chorus_* tools (that's wired via --mcp-config in the spawner task).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const NOOP_LOGGER = { info() {}, warn() {}, error() {} };

/**
 * @typedef {Object} ChorusClientOptions
 * @property {string} url      Chorus base URL.
 * @property {string} apiKey   `cho_` API key.
 * @property {{info(m:string):void,warn(m:string):void,error(m:string):void}} [logger]
 */

export class ChorusClient {
  /** @param {ChorusClientOptions} opts */
  constructor(opts) {
    this.url = opts.url;
    this.apiKey = opts.apiKey;
    this.logger = opts.logger ?? NOOP_LOGGER;
    /** @type {Client | null} */
    this.client = null;
    /** @type {StreamableHTTPClientTransport | null} */
    this.transport = null;
    this.status = "disconnected";
  }

  /** Lazily establish the MCP connection. */
  async connect() {
    if (this.status === "connected" && this.client) return;
    this.status = "connecting";
    try {
      this.transport = new StreamableHTTPClientTransport(new URL("/api/mcp", this.url), {
        requestInit: { headers: { Authorization: `Bearer ${this.apiKey}` } },
      });
      this.client = new Client({ name: "chorus-cli-daemon", version: "0.1.0" });
      await this.client.connect(this.transport);
      this.status = "connected";
    } catch (err) {
      this.status = "disconnected";
      this.client = null;
      this.transport = null;
      throw err;
    }
  }

  /**
   * Call an MCP tool, returning the first text content block parsed as JSON
   * (or the raw text if not JSON). Lazy-connects; retries once on a stateless
   * 404 / session-expired error.
   * @param {string} name
   * @param {Record<string, unknown>} [args]
   * @returns {Promise<unknown>}
   */
  async callTool(name, args = {}) {
    if (!this.client || this.status !== "connected") await this.connect();
    try {
      return await this.#doCallTool(name, args);
    } catch (err) {
      if (this.#isSessionExpired(err)) {
        this.logger.warn("MCP session expired, reconnecting...");
        this.status = "reconnecting";
        this.client = null;
        this.transport = null;
        await this.connect();
        return await this.#doCallTool(name, args);
      }
      throw err;
    }
  }

  async disconnect() {
    if (this.client) {
      try {
        await this.client.close();
      } catch {
        // ignore
      }
    }
    this.client = null;
    this.transport = null;
    this.status = "disconnected";
  }

  /** @param {string} name @param {Record<string, unknown>} args */
  async #doCallTool(name, args) {
    if (!this.client) throw new Error("MCP client not connected");
    const result = await this.client.callTool({ name, arguments: args });
    const blocks = /** @type {Array<{type:string,text?:string}>} */ (result.content ?? []);
    if (result.isError) {
      const text = blocks.filter((c) => c.type === "text").map((c) => c.text).join("\n");
      // Tool-LEVEL error (e.g. "Task not found"): the call reached the server
      // and the tool ran — this is NOT a transport/session failure. Tag it so
      // #isSessionExpired won't mistake its text (which may contain "not found")
      // for a stateless-404 and trigger a pointless reconnect + retry.
      const err = new Error(`Chorus MCP tool error (${name}): ${text}`);
      /** @type {any} */ (err).isToolError = true;
      throw err;
    }
    const textBlock = blocks.find((c) => c.type === "text");
    if (!textBlock?.text) return null;
    try {
      return JSON.parse(textBlock.text);
    } catch {
      return textBlock.text;
    }
  }

  /** @param {unknown} err */
  #isSessionExpired(err) {
    if (!(err instanceof Error)) return false;
    // A tool-level error reached the server and ran — never a session/transport
    // issue, so don't reconnect+retry on it (it'd fail identically).
    if (/** @type {any} */ (err).isToolError) return false;
    const m = err.message.toLowerCase();
    // Stateless-404 / lost-transport signals only. "not found" is intentionally
    // NOT matched on its own (too broad — collides with entity-not-found tool
    // text); a transport 404 still contains "404".
    return m.includes("404") || m.includes("session");
  }
}

/**
 * Validate a url + apiKey pair by calling `chorus_checkin` and reading the
 * authenticated agent identity. Returns the identity on success; throws on
 * failure (bad key, unreachable server, unexpected shape).
 *
 * @param {{ url: string, apiKey: string }} creds
 * @param {{ makeClient?: (o: ChorusClientOptions) => ChorusClient }} [deps]
 * @returns {Promise<{ uuid: string, name: string }>}
 */
export async function validateAndFetchIdentity(creds, deps = {}) {
  const makeClient = deps.makeClient ?? ((o) => new ChorusClient(o));
  const client = makeClient({ url: creds.url, apiKey: creds.apiKey });
  try {
    const result = /** @type {{ agent?: { uuid?: string, name?: string } }} */ (
      await client.callTool("chorus_checkin", {})
    );
    const agent = result?.agent;
    if (!agent || typeof agent.uuid !== "string") {
      throw new Error("Unexpected chorus_checkin response — no agent identity returned");
    }
    return { uuid: agent.uuid, name: typeof agent.name === "string" ? agent.name : agent.uuid };
  } finally {
    await client.disconnect();
  }
}
