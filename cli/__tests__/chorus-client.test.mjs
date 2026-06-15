// cli/__tests__/chorus-client.test.mjs
// Covers the MCP client contract used across the daemon: callTool returns
// parsed JSON, and validateAndFetchIdentity extracts the agent identity.
// (cli-daemon AC "ChorusMcpClient ... returns parsed JSON" + login validation.)
import { describe, it, expect, vi } from "vitest";
import { validateAndFetchIdentity } from "../chorus-client.mjs";

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
