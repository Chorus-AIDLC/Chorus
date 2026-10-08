import { describe, expect, test } from "bun:test";
import { McpClient, McpToolError, mcpCall } from "../lib/mcp-client.js";

const connection = { url: "http://localhost:9999", apiKey: "cho_private_fixture" };
const success = { content: [{ type: "text", text: '{"ok":true}' }] };
type RpcRequest = { id?: number; method: string; params?: Record<string, unknown> };

function json(body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json", ...headers } });
}

function fixture(reply: (body: RpcRequest) => Response | Promise<Response>) {
  const requests: Array<{ body: RpcRequest; headers: Headers; url: string; signal: AbortSignal | null | undefined }> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(init!.body as string) as RpcRequest;
    requests.push({ body, headers: new Headers(init?.headers), url: String(url), signal: init?.signal });
    if (body.method === "initialize") return json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26" } }, { "mcp-session-id": "session-fixture" });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    return reply(body);
  }) as typeof fetch;
  return { client: new McpClient({ ...connection, fetch: fetcher }), requests, fetch: fetcher };
}

test("JSON transport negotiates and forwards session/protocol headers and real arguments", async () => {
  const { client, requests } = fixture((body) => json({ jsonrpc: "2.0", id: body.id, result: success }));
  expect(await client.callTool("chorus_get_task", { taskUuid: "task" })).toEqual(success);
  expect(requests.map(({ body }) => body.method)).toEqual(["initialize", "notifications/initialized", "tools/call"]);
  expect(requests[0].url).toBe("http://localhost:9999/api/mcp");
  expect(requests[0].headers.get("Mcp-Session-Id")).toBeNull();
  for (const request of requests.slice(1)) {
    expect(request.headers.get("Mcp-Session-Id")).toBe("session-fixture");
    expect(request.headers.get("MCP-Protocol-Version")).toBe("2025-03-26");
    expect(request.headers.get("Authorization")).toBe(`Bearer ${connection.apiKey}`);
  }
  expect(requests[1].body.id).toBeUndefined();
  expect(requests[2].body.params).toEqual({ name: "chorus_get_task", arguments: { taskUuid: "task" } });
});

test("discovery follows pagination and preserves all schema metadata", async () => {
  const schema = { name: "chorus_get_task", inputSchema: { type: "object", required: ["taskUuid"] }, annotations: { readOnlyHint: true } };
  const { client, requests } = fixture((body) => json({ jsonrpc: "2.0", id: body.id, result: body.params?.cursor
    ? { tools: [schema] } : { tools: [], nextCursor: "page-2" } }));
  expect(await client.listTools()).toEqual([schema]);
  expect(requests.at(-1)?.body.params).toEqual({ cursor: "page-2" });
  expect(requests.at(-1)?.body.id).toBe(3);
});

test("SSE handles chunks, CRLF, multiple data lines, notifications and a live stream", async () => {
  let cancelled = false;
  const { client } = fixture((body) => {
    const source = `: keepalive\r\nevent: message\r\ndata:{"jsonrpc":"2.0","method":"notifications/progress"}\r\n\r\ndata: {"jsonrpc":"2.0","id":999,"result":{}}\r\n\r\nevent: message\r\ndata: {"jsonrpc":"2.0",\r\ndata: "id":${body.id},"result":${JSON.stringify(success)}}\r\n\r\n`;
    const bytes = new TextEncoder().encode(source);
    return new Response(new ReadableStream({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.slice(offset, offset + 7));
      },
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "text/event-stream" } });
  });
  expect(await client.callTool("chorus_checkin")).toEqual(success);
  expect(cancelled).toBe(true);
});

describe("visible failures", () => {
  test("JSON-RPC initialization and notification failures stop before the tool call", async () => {
    for (const stage of ["initialize", "notifications/initialized"]) {
      const { fetch, requests } = fixture(() => json({}));
      const fetcher = (async (url, init) => {
        const body = JSON.parse(init!.body as string);
        if (body.method === stage) return json({ jsonrpc: "2.0", id: body.id ?? null, error: { code: -32000, message: "Session rejected" } });
        return fetch(url, init);
      }) as typeof globalThis.fetch;
      await expect(new McpClient({ ...connection, fetch: fetcher }).callTool("chorus_checkin")).rejects.toThrow("Session rejected");
      expect(requests.some(({ body }) => body.method === "tools/call")).toBe(false);
    }
  });

  for (const stage of ["initialize", "notifications/initialized", "tools/call"]) {
    test(`HTTP failure at ${stage} stops dispatch`, async () => {
      const { fetch, requests } = fixture((body) => json({ jsonrpc: "2.0", id: body.id, result: success }));
      const visited: string[] = [];
      const fetcher = (async (url, init) => {
        const body = JSON.parse(init!.body as string);
        visited.push(body.method);
        if (body.method === stage) return new Response(connection.apiKey, { status: 403 });
        return fetch(url, init);
      }) as typeof globalThis.fetch;
      await expect(new McpClient({ ...connection, fetch: fetcher }).callTool("chorus_checkin")).rejects.toThrow("HTTP 403");
      expect(visited.at(-1)).toBe(stage);
      expect(requests.some(({ body }) => body.method === stage)).toBe(false);
    });
  }

  test("JSON-RPC error retains code/message without leaking credentials", async () => {
    const { client } = fixture((body) => json({ jsonrpc: "2.0", id: body.id, error: { code: -32602, message: `invalid ${connection.apiKey}` } }));
    await expect(client.callTool("chorus_checkin")).rejects.toThrow("JSON-RPC -32602: invalid [redacted]");
  });

  test("isError throws with the real remote result retained", async () => {
    const result = { content: [{ type: "text", text: "Task already assigned" }], isError: true, structuredContent: { code: "conflict" } };
    const { client } = fixture((body) => json({ jsonrpc: "2.0", id: body.id, result }));
    try {
      await client.callTool("chorus_claim_task");
      throw new Error("unexpected success");
    } catch (error) {
      expect(error).toBeInstanceOf(McpToolError);
      expect((error as McpToolError).result).toEqual(result);
      expect((error as Error).message).toContain("Task already assigned");
    }
  });

  for (const result of [null, {}, { content: "bad" }, { content: [null] }, { content: [], isError: "true" }]) {
    test(`malformed tool result ${JSON.stringify(result)}`, async () => {
      const { client } = fixture((body) => json({ jsonrpc: "2.0", id: body.id, result }));
      await expect(client.callTool("chorus_checkin")).rejects.toThrow("invalid result");
    });
  }

  for (const body of ["not JSON", '{"jsonrpc":"2.0","id":2}', '{"jsonrpc":"2.0","id":999,"result":{}}']) {
    test(`malformed envelope ${body}`, async () => {
      const { client } = fixture(() => new Response(body));
      await expect(client.callTool("chorus_checkin")).rejects.toThrow();
    });
  }

  test("schema lookup failure is not an empty success", async () => {
    const { client } = fixture((body) => json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "chorus_get_task" }] } }));
    await expect(client.listTools()).rejects.toThrow("invalid tool schemas");
  });

  test("later discovery page errors discard partial results", async () => {
    const { client } = fixture((body) => json(body.params?.cursor
      ? { jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "page unavailable" } }
      : { jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "chorus_checkin", inputSchema: {} }], nextCursor: "page-2" } }));
    await expect(client.listTools()).rejects.toThrow("page unavailable");
  });

  test("SSE JSON-RPC errors and missing matching responses fail", async () => {
    const errorFixture = fixture((body) => new Response(`data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32602, message: "bad args" } })}\n\n`,
      { headers: { "content-type": "text/event-stream" } }));
    await expect(errorFixture.client.callTool("chorus_checkin")).rejects.toThrow("bad args");
    const emptyFixture = fixture(() => new Response("event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":999,\"result\":{}}\n\n",
      { headers: { "content-type": "text/event-stream" } }));
    await expect(emptyFixture.client.callTool("chorus_checkin")).rejects.toThrow("without matching");
  });

  test("repeated pagination cursor terminates visibly", async () => {
    const { client } = fixture((body) => json({ jsonrpc: "2.0", id: body.id, result: { tools: [], nextCursor: "repeat" } }));
    await expect(client.listTools()).rejects.toThrow("repeated pagination cursor");
  });

  test("missing configuration performs no requests", async () => {
    const { fetch, requests } = fixture(() => json({}));
    await expect(new McpClient({ url: "", apiKey: "", fetch }).listTools()).rejects.toThrow("not configured");
    expect(requests).toHaveLength(0);
  });

  test("network errors redact keys", async () => {
    const fetcher = (async () => { throw new Error(`fetch ${connection.apiKey} failed`); }) as typeof fetch;
    await expect(new McpClient({ ...connection, fetch: fetcher }).listTools()).rejects.toThrow("fetch [redacted] failed");
  });
});

test("pre-aborted request never reaches the network", async () => {
  const { client, requests } = fixture(() => json({}));
  await expect(client.listTools(AbortSignal.abort())).rejects.toThrow("aborted");
  expect(requests).toHaveLength(0);
});

test("abort interrupts a pending fetch even if a custom fetch ignores its signal", async () => {
  const controller = new AbortController();
  let requestSignal: AbortSignal | null | undefined;
  const fetcher = ((_url, init) => {
    requestSignal = init?.signal;
    return new Promise<Response>(() => {});
  }) as typeof fetch;
  const pending = new McpClient({ ...connection, fetch: fetcher }).listTools(controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow("aborted");
  expect(requestSignal?.aborted).toBe(true);
});

test("finite timeout also bounds incomplete response bodies", async () => {
  let cancelled = false;
  const { fetch } = fixture(() => new Response(new ReadableStream({ cancel() { cancelled = true; } }),
    { headers: { "content-type": "text/event-stream" } }));
  await expect(new McpClient({ ...connection, fetch, timeoutMs: 15 }).callTool("chorus_checkin")).rejects.toThrow("timed out");
  expect(cancelled).toBe(true);
});

test("SSE initialization retains negotiated session and concurrent calls isolate their handshakes", async () => {
  let session = 0;
  const headers: string[] = [];
  const fetcher = (async (_url, init) => {
    const body = JSON.parse(init!.body as string);
    if (body.method === "initialize") {
      return new Response(`data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26" } })}\n\n`,
        { headers: { "content-type": "text/event-stream", "mcp-session-id": `session-${++session}` } });
    }
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    headers.push(new Headers(init?.headers).get("mcp-session-id")!);
    return json({ jsonrpc: "2.0", id: body.id, result: success });
  }) as typeof fetch;
  const client = new McpClient({ ...connection, url: "http://localhost:9999/api/mcp/", fetch: fetcher });
  await Promise.all([client.callTool("chorus_checkin"), client.callTool("chorus_get_task")]);
  expect(headers.sort()).toEqual(["session-1", "session-2"]);
});

test("legacy mcpCall unwraps JSON, plain text, and structured content without hiding errors", async () => {
  const { fetch } = fixture((body) => json({ jsonrpc: "2.0", id: body.id, result: success }));
  expect(await mcpCall({ ...connection, fetch }, "chorus_checkin")).toEqual({ ok: true });
  const textFixture = fixture((body) => json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "hello" }] } }));
  expect(await mcpCall({ ...connection, fetch: textFixture.fetch }, "chorus_checkin")).toBe("hello");
  const structuredFixture = fixture((body) => json({ jsonrpc: "2.0", id: body.id, result: { content: [], structuredContent: { uuid: "session" } } }));
  expect(await mcpCall({ ...connection, fetch: structuredFixture.fetch }, "chorus_checkin")).toEqual({ uuid: "session" });
  const errorFixture = fixture((body) => json({ jsonrpc: "2.0", id: body.id, result: { content: [], isError: true } }));
  await expect(mcpCall({ ...connection, fetch: errorFixture.fetch }, "chorus_checkin")).rejects.toThrow("Chorus tool failed");
});
