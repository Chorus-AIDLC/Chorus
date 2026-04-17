import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockHandleRequest = vi.hoisted(() => vi.fn().mockResolvedValue(new Response()));
const mockConnect = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js", () => ({
  WebStandardStreamableHTTPServerTransport: vi.fn(function (this: Record<string, unknown>) {
    this.handleRequest = mockHandleRequest;
  }),
}));

vi.mock("@/mcp/server", () => ({
  createMcpServer: vi.fn().mockReturnValue({
    connect: mockConnect,
  }),
}));

vi.mock("@/lib/api-key", () => ({
  extractApiKey: vi.fn().mockReturnValue("test-key"),
  validateApiKey: vi.fn().mockResolvedValue({
    valid: true,
    agent: {
      uuid: "agent-uuid",
      companyUuid: "company-uuid",
      roles: ["developer"],
      name: "Test Agent",
    },
  }),
}));

describe("Stateless MCP Endpoint", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { _resetServerCacheForTest } = await import("@/app/api/mcp/route");
    _resetServerCacheForTest();
  });

  describe("POST - Request Handling", () => {
    it("should create transport and handle request", async () => {
      const { POST } = await import("@/app/api/mcp/route");

      const request = new NextRequest("http://localhost:3000/api/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer test-key",
        },
      });

      const response = await POST(request);

      expect(mockHandleRequest).toHaveBeenCalled();
      expect(response).toBeInstanceOf(Response);
    });

    it("should create a new transport per request but reuse cached server", async () => {
      const { POST } = await import("@/app/api/mcp/route");
      const { createMcpServer } = await import("@/mcp/server");
      const { WebStandardStreamableHTTPServerTransport } = await import(
        "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
      );

      const request1 = new NextRequest("http://localhost:3000/api/mcp", {
        method: "POST",
        headers: { authorization: "Bearer test-key" },
      });

      const request2 = new NextRequest("http://localhost:3000/api/mcp", {
        method: "POST",
        headers: { authorization: "Bearer test-key" },
      });

      await POST(request1);
      await POST(request2);

      // Two transports created (one per request)
      expect(WebStandardStreamableHTTPServerTransport).toHaveBeenCalledTimes(2);
      // Server created only once (cached by API key)
      expect(createMcpServer).toHaveBeenCalledTimes(1);
    });

    it("should create separate servers for different agents", async () => {
      const { POST } = await import("@/app/api/mcp/route");
      const { createMcpServer } = await import("@/mcp/server");
      const apiKeyLib = await import("@/lib/api-key");

      const request1 = new NextRequest("http://localhost:3000/api/mcp", {
        method: "POST",
        headers: { authorization: "Bearer key-1" },
      });

      await POST(request1);

      // Change agent for second request
      vi.mocked(apiKeyLib.validateApiKey).mockResolvedValueOnce({
        valid: true,
        agent: {
          uuid: "agent-uuid-2",
          companyUuid: "company-uuid",
          roles: ["pm"],
          name: "PM Agent",
          ownerUuid: null,
        },
      });

      const request2 = new NextRequest("http://localhost:3000/api/mcp", {
        method: "POST",
        headers: { authorization: "Bearer key-2" },
      });

      await POST(request2);

      // Different agents = different servers
      expect(createMcpServer).toHaveBeenCalledTimes(2);
    });

    it("should create transport without sessionIdGenerator", async () => {
      const { POST } = await import("@/app/api/mcp/route");
      const { WebStandardStreamableHTTPServerTransport } = await import(
        "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
      );

      const request = new NextRequest("http://localhost:3000/api/mcp", {
        method: "POST",
        headers: { authorization: "Bearer test-key" },
      });

      await POST(request);

      const constructorArgs = vi.mocked(WebStandardStreamableHTTPServerTransport).mock.calls[0][0];
      expect(constructorArgs).not.toHaveProperty("sessionIdGenerator");
    });
  });

  describe("DELETE - Method Not Allowed", () => {
    it("should return 405 for DELETE requests", async () => {
      const { DELETE } = await import("@/app/api/mcp/route");

      const response = await DELETE();
      expect(response.status).toBe(405);
    });
  });

  describe("Error Handling", () => {
    it("should return 401 for missing API key", async () => {
      const { POST } = await import("@/app/api/mcp/route");
      const apiKeyLib = await import("@/lib/api-key");
      vi.mocked(apiKeyLib.extractApiKey).mockReturnValueOnce(null);

      const request = new NextRequest("http://localhost:3000/api/mcp", {
        method: "POST",
        headers: {},
      });

      const response = await POST(request);
      expect(response.status).toBe(401);
    });

    it("should return 401 for invalid API key", async () => {
      const { POST } = await import("@/app/api/mcp/route");
      const apiKeyLib = await import("@/lib/api-key");
      vi.mocked(apiKeyLib.validateApiKey).mockResolvedValueOnce({
        valid: false,
        error: "Invalid API key",
      });

      const request = new NextRequest("http://localhost:3000/api/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer invalid-key",
        },
      });

      const response = await POST(request);
      expect(response.status).toBe(401);
    });
  });
});
