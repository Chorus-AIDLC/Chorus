// cli/__tests__/chorus-client.test.mjs
// Covers the MCP client contract used across the daemon: callTool returns
// parsed JSON, and validateAndFetchIdentity extracts the agent identity.
// (cli-daemon AC "ChorusMcpClient ... returns parsed JSON" + login validation.)
import { describe, it, expect, vi } from "vitest";
import { ChorusClient, validateAndFetchIdentity } from "../chorus-client.mjs";

/** Build a ChorusClient with its internal MCP client + connect() stubbed. */
function clientWith(callToolImpl) {
  const c = new ChorusClient({ url: "https://c", apiKey: "cho_x" });
  c.status = "connected";
  c.client = { callTool: callToolImpl };
  let connects = 0;
  // Stub (re)connect so we can detect whether a reconnect was attempted.
  c.connect = async () => {
    connects++;
    c.status = "connected";
    c.client = { callTool: callToolImpl };
  };
  return { c, connects: () => connects };
}

describe("validateAndFetchIdentity", () => {
  it("calls chorus_checkin and returns {uuid,name} on success", async () => {
    const callTool = vi.fn(async () => ({ agent: { uuid: "a-1", name: "Bot" } }));
    const disconnect = vi.fn(async () => {});
    const makeClient = vi.fn((o) => ({ url: o.url, apiKey: o.apiKey, callTool, disconnect }));

    const identity = await validateAndFetchIdentity(
      { url: "https://c", apiKey: "cho_x" },
      { makeClient }
    );

    expect(makeClient).toHaveBeenCalledWith({ url: "https://c", apiKey: "cho_x" });
    expect(callTool).toHaveBeenCalledWith("chorus_checkin", {});
    expect(identity).toEqual({ uuid: "a-1", name: "Bot" });
    expect(disconnect).toHaveBeenCalled(); // always disconnects (finally)
  });

  it("falls back to uuid when name is missing", async () => {
    const makeClient = () => ({
      callTool: async () => ({ agent: { uuid: "only-uuid" } }),
      disconnect: async () => {},
    });
    const identity = await validateAndFetchIdentity({ url: "u", apiKey: "k" }, { makeClient });
    expect(identity).toEqual({ uuid: "only-uuid", name: "only-uuid" });
  });

  it("throws on an unexpected response shape and still disconnects", async () => {
    const disconnect = vi.fn(async () => {});
    const makeClient = () => ({ callTool: async () => ({ notAgent: true }), disconnect });
    await expect(
      validateAndFetchIdentity({ url: "u", apiKey: "k" }, { makeClient })
    ).rejects.toThrow(/no agent identity/i);
    expect(disconnect).toHaveBeenCalled();
  });

  it("propagates a transport/auth error from callTool", async () => {
    const disconnect = vi.fn(async () => {});
    const makeClient = () => ({
      callTool: async () => {
        throw new Error("401 Unauthorized");
      },
      disconnect,
    });
    await expect(
      validateAndFetchIdentity({ url: "u", apiKey: "bad" }, { makeClient })
    ).rejects.toThrow(/401/);
    expect(disconnect).toHaveBeenCalled();
  });
});

describe("ChorusClient.callTool tool-error vs session-expiry", () => {
  it("does NOT reconnect on a tool-level error whose text contains 'not found'", async () => {
    // Server ran the tool and returned an error result — NOT a session issue.
    const callTool = vi.fn(async () => ({
      isError: true,
      content: [{ type: "text", text: "Task not found" }],
    }));
    const { c, connects } = clientWith(callTool);

    await expect(c.callTool("chorus_get_task", { taskUuid: "x" })).rejects.toThrow(/Task not found/);
    // Called exactly once — no reconnect+retry triggered by the "not found" text.
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(connects()).toBe(0);
  });

  it("DOES reconnect+retry once on a real stateless-404 transport error", async () => {
    let n = 0;
    const callTool = vi.fn(async () => {
      n++;
      if (n === 1) throw new Error("HTTP 404: session not found"); // transport-level
      return { isError: false, content: [{ type: "text", text: '{"ok":true}' }] };
    });
    const { c, connects } = clientWith(callTool);

    const out = await c.callTool("chorus_checkin", {});
    expect(out).toEqual({ ok: true });
    expect(callTool).toHaveBeenCalledTimes(2); // first failed, retried after reconnect
    expect(connects()).toBe(1);
  });
});
