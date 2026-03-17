import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock dependencies
const mockTransport = {
  handleRequest: vi.fn(),
  close: vi.fn().mockResolvedValue(undefined),
};

vi.mock("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js", () => ({
  WebStandardStreamableHTTPServerTransport: vi.fn().mockImplementation(() => mockTransport),
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

// Import after mocking
import { POST, DELETE } from "@/app/api/mcp/route";

describe("MCP Session Management", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("Session Activity Tracking", () => {
    it("should create session with initial activity timestamp", async () => {
      const request = new Request("http://localhost:3000/api/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer test-key",
        },
      });

      await POST(request as any);

      // Verify session was created (transport.handleRequest called)
      expect(mockTransport.handleRequest).toHaveBeenCalled();
    });

    it("should update activity timestamp on subsequent requests", async () => {
      const request1 = new Request("http://localhost:3000/api/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer test-key",
        },
      });

      await POST(request1 as any);

      // Get the session ID from the first request
      const sessionId = mockTransport.handleRequest.mock.calls[0][0].headers.get("mcp-session-id");

      // Advance time by 10 minutes
      vi.advanceTimersByTime(10 * 60 * 1000);

      // Make another request with the same session ID
      const request2 = new Request("http://localhost:3000/api/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer test-key",
          "mcp-session-id": sessionId,
        },
      });

      await POST(request2 as any);

      // Session should still be valid (not return 404)
      expect(mockTransport.handleRequest).toHaveBeenCalledTimes(2);
    });

    it("should expire session after 30 minutes of inactivity", async () => {
      const request1 = new Request("http://localhost:3000/api/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer test-key",
        },
      });

      await POST(request1 as any);

      // Get the session ID from the first request
      const sessionId = mockTransport.handleRequest.mock.calls[0][0].headers.get("mcp-session-id");

      // Advance time by 31 minutes (beyond timeout)
      vi.advanceTimersByTime(31 * 60 * 1000);

      // Trigger cleanup
      vi.runAllTimers();

      // Try to use the expired session
      const request2 = new Request("http://localhost:3000/api/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer test-key",
          "mcp-session-id": sessionId,
        },
      });

      const response = await POST(request2 as any);

      // Should return 404 for expired session
      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error.message).toBe("Session not found. Please reinitialize.");
    });

    it("should keep session alive with continuous activity", async () => {
      const request1 = new Request("http://localhost:3000/api/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer test-key",
        },
      });

      await POST(request1 as any);

      const sessionId = mockTransport.handleRequest.mock.calls[0][0].headers.get("mcp-session-id");

      // Simulate activity every 25 minutes for 2 hours
      for (let i = 0; i < 5; i++) {
        vi.advanceTimersByTime(25 * 60 * 1000);

        const request = new Request("http://localhost:3000/api/mcp", {
          method: "POST",
          headers: {
            authorization: "Bearer test-key",
            "mcp-session-id": sessionId,
          },
        });

        await POST(request as any);
      }

      // Session should still be valid after 2 hours with continuous activity
      expect(mockTransport.handleRequest).toHaveBeenCalledTimes(6);
    });
  });

  describe("Session Cleanup", () => {
    it("should clean up expired sessions periodically", async () => {
      const request = new Request("http://localhost:3000/api/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer test-key",
        },
      });

      await POST(request as any);

      // Advance time beyond timeout
      vi.advanceTimersByTime(31 * 60 * 1000);

      // Trigger cleanup interval
      vi.advanceTimersByTime(5 * 60 * 1000);

      // Transport should be closed during cleanup
      expect(mockTransport.close).toHaveBeenCalled();
    });
  });

  describe("Session Deletion", () => {
    it("should delete session on DELETE request", async () => {
      const request1 = new Request("http://localhost:3000/api/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer test-key",
        },
      });

      await POST(request1 as any);

      const sessionId = mockTransport.handleRequest.mock.calls[0][0].headers.get("mcp-session-id");

      // Delete the session
      const deleteRequest = new Request("http://localhost:3000/api/mcp", {
        method: "DELETE",
        headers: {
          "mcp-session-id": sessionId,
        },
      });

      const response = await DELETE(deleteRequest as any);
      expect(response.status).toBe(204);
      expect(mockTransport.close).toHaveBeenCalled();

      // Try to use the deleted session
      const request2 = new Request("http://localhost:3000/api/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer test-key",
          "mcp-session-id": sessionId,
        },
      });

      const response2 = await POST(request2 as any);
      expect(response2.status).toBe(404);
    });
  });
});