// cli/__tests__/chorus-client-raw.test.mjs
// Covers cli-mcp-client: ChorusClient.callToolRaw (verbatim text, no JSON parse)
// and listTools, incl. the session-expiry reconnect+retry path.
import { describe, it, expect } from "vitest";
import { ChorusClient } from "../chorus-client.mjs";

/** Build a ChorusClient with its internal MCP client + connect() stubbed. */
function clientWith(impl) {
  const c = new ChorusClient({ url: "https://c", apiKey: "cho_x" });
  c.status = "connected";
  c.client = impl;
  let connects = 0;
  c.connect = async () => {
    connects++;
    c.status = "connected";
    c.client = impl;
  };
  return { c, connects: () => connects };
}

describe("ChorusClient.callToolRaw", () => {
  it("returns verbatim joined text of text blocks, without JSON parsing", async () => {
    const raw = '{"draftUuid":"d-1"}\nline2 with "quotes" and \\ backslash';
    const { c } = clientWith({
      callTool: async () => ({
        content: [
          { type: "text", text: raw },
          { type: "image", data: "ignored" },
        ],
      }),
    });
    const out = await c.callToolRaw("chorus_get_task", { taskUuid: "t1" });
    expect(out).toEqual({ isError: false, text: raw });
    // Not parsed/re-serialized — exact bytes preserved.
    expect(out.text).toContain('\\ backslash');
    expect(out.text).toContain('"quotes"');
  });

  it("joins multiple text blocks with a newline", async () => {
    const { c } = clientWith({
      callTool: async () => ({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }),
    });
    expect((await c.callToolRaw("x")).text).toBe("a\nb");
  });

  it("flags isError and returns the error text verbatim", async () => {
    const { c } = clientWith({
      callTool: async () => ({ isError: true, content: [{ type: "text", text: "Task not found" }] }),
    });
    expect(await c.callToolRaw("x")).toEqual({ isError: true, text: "Task not found" });
  });

  it("empty content yields empty text", async () => {
    const { c } = clientWith({ callTool: async () => ({}) });
    expect(await c.callToolRaw("x")).toEqual({ isError: false, text: "" });
  });

  it("reconnects once and retries on a session-expired (404) error", async () => {
    let calls = 0;
    const { c, connects } = clientWith({
      callTool: async () => {
        calls++;
        if (calls === 1) throw new Error("HTTP 404 session not found");
        return { content: [{ type: "text", text: "ok" }] };
      },
    });
    const out = await c.callToolRaw("x");
    expect(out.text).toBe("ok");
    expect(calls).toBe(2);
    expect(connects()).toBe(1); // one reconnect
  });

  it("does not reconnect on a tool-level error text (only real session loss)", async () => {
    // A tool error is delivered as isError:true, not thrown — so no reconnect.
    let calls = 0;
    const { c, connects } = clientWith({
      callTool: async () => {
        calls++;
        return { isError: true, content: [{ type: "text", text: "not found" }] };
      },
    });
    await c.callToolRaw("x");
    expect(calls).toBe(1);
    expect(connects()).toBe(0);
  });
});

describe("ChorusClient.listTools", () => {
  it("maps tools/list to [{name, description}]", async () => {
    const { c } = clientWith({
      listTools: async () => ({
        tools: [
          { name: "chorus_get_task", description: "Get a task", inputSchema: {} },
          { name: "chorus_add_comment" },
        ],
      }),
    });
    expect(await c.listTools()).toEqual([
      { name: "chorus_get_task", description: "Get a task" },
      { name: "chorus_add_comment", description: "" },
    ]);
  });

  it("reconnects once and retries on session expiry", async () => {
    let calls = 0;
    const { c, connects } = clientWith({
      listTools: async () => {
        calls++;
        if (calls === 1) throw new Error("session expired (404)");
        return { tools: [{ name: "t" }] };
      },
    });
    expect(await c.listTools()).toEqual([{ name: "t", description: "" }]);
    expect(connects()).toBe(1);
  });
});
