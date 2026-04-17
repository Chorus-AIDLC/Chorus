import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockHandleRequest = vi.hoisted(() => vi.fn().mockResolvedValue(new Response()));

vi.mock("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js", () => ({
  WebStandardStreamableHTTPServerTransport: vi.fn(function (this: Record<string, unknown>) {
    this.handleRequest = mockHandleRequest;
  }),
}));

vi.mock("@/mcp/server", () => ({
  createMcpServer: vi.fn().mockReturnValue({
    connect: vi.fn().mockResolvedValue(undefined),
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
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("POST - Stateless Request Handling", () => {
    it("should create fresh server+transport and handle request", async () => {
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

    it("should create independent server+transport per request", async () => {
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

      expect(WebStandardStreamableHTTPServerTransport).toHaveBeenCalledTimes(2);
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
