import type { ChorusConnection } from "./lib.js";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  [key: string]: unknown;
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface McpResult {
  content: Array<{ type: string; [key: string]: unknown }>;
  isError?: boolean;
  structuredContent?: { [key: string]: JsonValue };
  [key: string]: unknown;
}

export interface McpClientOptions extends ChorusConnection {
  version?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class McpToolError extends Error {
  constructor(public readonly result: McpResult) {
    super(`Chorus tool failed: ${JSON.stringify(result)}`);
    this.name = "McpToolError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class McpClient {
  constructor(private readonly options: McpClientOptions) {}

  private async operation<T>(
    signal: AbortSignal | undefined,
    run: (request: (method: string, params?: Record<string, unknown>) => Promise<unknown>) => Promise<T>,
  ): Promise<T> {
    const { url, apiKey } = this.options;
    if (!url || !apiKey) throw new Error("Chorus is not configured: set CHORUS_URL and CHORUS_API_KEY or configure the Chorus MCP connection.");
    const controller = new AbortController();
    const abort = () => controller.abort(new Error("Chorus MCP request aborted"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timeoutMs = this.options.timeoutMs ?? 30_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      signal?.removeEventListener("abort", abort);
      throw new Error("Chorus MCP timeout must be finite and positive");
    }
    const timer = setTimeout(() => controller.abort(new Error("Chorus MCP request timed out")), timeoutMs);
    let rejectAbort: () => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", rejectAbort, { once: true });
    });
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    const base = url.replace(/\/+$/, "");
    const endpoint = base.includes("/api/mcp") ? base : `${base}/api/mcp`;
    let nextId = 1;
    const request = async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
      controller.signal.throwIfAborted();
      const notification = method === "notifications/initialized";
      const id = notification ? undefined : nextId++;
      const response = await (this.options.fetch ?? globalThis.fetch)(endpoint, {
        method: "POST",
        headers: { ...headers },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: controller.signal,
        redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Chorus MCP ${method}: HTTP ${response.status}`);
      }
      const sessionId = response.headers.get("mcp-session-id");
      if (sessionId) headers["Mcp-Session-Id"] = sessionId;
      if (notification) {
        if (response.headers.get("content-type")?.includes("application/json")) {
          const raw = await response.text();
          if (raw) {
            const envelope: unknown = JSON.parse(raw);
            if (record(envelope) && record(envelope.error)) {
              throw new Error(`Chorus MCP ${method}: JSON-RPC ${envelope.error.code ?? "error"}: ${envelope.error.message ?? "request failed"}`);
            }
          }
        } else {
          await response.body?.cancel();
        }
        return undefined;
      }
      const envelope = response.headers.get("content-type")?.includes("text/event-stream")
        ? await this.readSse(response, id!, controller.signal)
        : JSON.parse(await response.text());
      if (!record(envelope) || envelope.jsonrpc !== "2.0" || envelope.id !== id) {
        throw new Error(`Chorus MCP ${method}: invalid JSON-RPC response`);
      }
      if (record(envelope.error)) {
        throw new Error(`Chorus MCP ${method}: JSON-RPC ${envelope.error.code ?? "error"}: ${envelope.error.message ?? "request failed"}`);
      }
      if (!("result" in envelope)) throw new Error(`Chorus MCP ${method}: missing result`);
      return envelope.result;
    };
    try {
      controller.signal.throwIfAborted();
      return await Promise.race([aborted, (async () => {
        const initialized = await request("initialize", {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "chorus-pi", version: this.options.version ?? "0.0.0" },
        });
        if (!record(initialized)) throw new Error("Chorus MCP initialize: invalid result");
        if (typeof initialized.protocolVersion === "string") {
          headers["MCP-Protocol-Version"] = initialized.protocolVersion;
        }
        await request("notifications/initialized");
        return run(request);
      })()]);
    } catch (error) {
      if (error instanceof McpToolError) {
        throw new McpToolError(JSON.parse(JSON.stringify(error.result).replaceAll(apiKey, "[redacted]")));
      }
      const message = error instanceof Error ? error.message : "request failed";
      throw new Error(message.replaceAll(apiKey, "[redacted]"));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", rejectAbort);
    }
  }

  private async readSse(response: Response, id: number, signal: AbortSignal): Promise<unknown> {
    if (!response.body) throw new Error("Chorus MCP: empty SSE response");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const cancel = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        if (done) buffer += "\n\n";
        let boundary: RegExpExecArray | null;
        while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
          const event = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).replace(/^ /, "")).join("\n");
          if (!data) continue;
          const envelope: unknown = JSON.parse(data);
          if (record(envelope) && envelope.id === id) return envelope;
        }
        if (done) throw new Error("Chorus MCP: SSE ended without matching JSON-RPC response");
      }
    } finally {
      signal.removeEventListener("abort", cancel);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  async listTools(signal?: AbortSignal): Promise<McpTool[]> {
    return this.operation(signal, async (request) => {
      const tools: McpTool[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const result = await request("tools/list", cursor ? { cursor } : {});
        if (!record(result) || !Array.isArray(result.tools) || result.tools.some((tool) =>
          !record(tool) || typeof tool.name !== "string" || !record(tool.inputSchema))) {
          throw new Error("Chorus MCP tools/list: invalid tool schemas");
        }
        tools.push(...result.tools as McpTool[]);
        if (result.nextCursor !== undefined && typeof result.nextCursor !== "string") {
          throw new Error("Chorus MCP tools/list: invalid pagination cursor");
        }
        cursor = result.nextCursor as string | undefined;
        if (cursor) {
          if (cursors.has(cursor)) throw new Error("Chorus MCP tools/list: repeated pagination cursor");
          cursors.add(cursor);
        }
      } while (cursor);
      return tools;
    });
  }

  async callTool(tool: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<McpResult> {
    return this.operation(signal, async (request) => {
      const result = await request("tools/call", { name: tool, arguments: args });
      if (!record(result) || !Array.isArray(result.content) || result.content.some((item) =>
        !record(item) || typeof item.type !== "string") ||
        (result.isError !== undefined && typeof result.isError !== "boolean") ||
        (result.structuredContent !== undefined && !record(result.structuredContent))) {
        throw new Error("Chorus MCP tools/call: invalid result");
      }
      if (result.isError) throw new McpToolError(result as McpResult);
      return result as McpResult;
    });
  }
}

export async function mcpCall<T = unknown>(
  options: McpClientOptions, tool: string, args: Record<string, unknown> = {}, signal?: AbortSignal,
): Promise<T> {
  const result = await new McpClient(options).callTool(tool, args, signal);
  if (result.structuredContent) return result.structuredContent as T;
  const text = result.content.find((item) => item.type === "text")?.text;
  if (typeof text !== "string") throw new Error(`Chorus MCP ${tool}: missing text result`);
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}
