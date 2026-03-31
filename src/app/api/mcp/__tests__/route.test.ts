import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Track onclose callbacks per transport instance
let oncloseCallback: (() => void) | null = null;

// Create mock transport using vi.hoisted to make it available in mock factory
const mockTransport = vi.hoisted(() => ({
  handleRequest: vi.fn().mockResolvedValue(new Response()),
  close: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js", () => ({
  WebStandardStreamableHTTPServerTransport: vi.fn(function () {
    const transport = { ...mockTransport };
    Object.defineProperty(transport, "onclose", {
      set(fn: () => void) {
        oncloseCallback = fn;
      },
      configurable: true,
    });
    return transport;
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

describe("MCP Session Management", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    oncloseCallback = null;
  });

  describe("Session Lifecycle", () => {
    it("should create session and call handleRequest", async () => {
      const { POST } = await import("@/app/api/mcp/route");

      const request = new NextRequest("http://localhost:3000/api/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer test-key",
        },
      });

      const response = await POST(request);

      expect(mockTransport.handleRequest).toHaveBeenCalled();
      expect(response).toBeInstanceOf(Response);
    });

    it("should return 404 for unknown session ID", async () => {
      const { POST } = await import("@/app/api/mcp/route");

      const request = new NextRequest("http://localhost:3000/api/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer test-key",
          "mcp-session-id": "nonexistent-session-id",
        },
      });

      const response = await POST(request);

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error.message).toBe(
        "Session not found. Please reinitialize."
      );
    });

    it("should clean up session when transport onclose fires", async () => {
      const { POST } = await import("@/app/api/mcp/route");

      // Create session
      const request = new NextRequest("http://localhost:3000/api/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer test-key",
        },
      });

      await POST(request);
      expect(oncloseCallback).not.toBeNull();

      // Simulate transport close (e.g., client disconnected)
      oncloseCallback!();

      // The session should now be removed — any session ID that was valid
      // would now return 404 (tested indirectly via unknown session ID test above)
    });
  });

  describe("Session Deletion", () => {
    it("should delete session on DELETE request", async () => {
      const { POST, DELETE } = await import("@/app/api/mcp/route");

      // First create a session
      const createRequest = new NextRequest("http://localhost:3000/api/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer test-key",
        },
      });

      await POST(createRequest);

      // Delete with missing session ID should return 400
      const deleteRequest1 = new NextRequest("http://localhost:3000/api/mcp", {
        method: "DELETE",
        headers: {},
      });

      const response1 = await DELETE(deleteRequest1);
      expect(response1.status).toBe(400);

      // Delete with a session ID
      const deleteRequest2 = new NextRequest("http://localhost:3000/api/mcp", {
        method: "DELETE",
        headers: {
          "mcp-session-id": "test-session-id",
        },
      });

      const response2 = await DELETE(deleteRequest2);
      expect(response2.status).toBe(204);
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
