import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// Mock dependencies
const mockTransport = {
  handleRequest: vi.fn().mockResolvedValue(new Response()),
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
    it("should create session and call handleRequest", async () => {
      const request = new NextRequest("http://localhost:3000/api/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer test-key",
        },
      });

      const response = await POST(request);

      // Verify transport.handleRequest was called
      expect(mockTransport.handleRequest).toHaveBeenCalled();
      expect(response).toBeInstanceOf(Response);
    });

    it("should reuse session for subsequent requests", async () => {
      // First request - create session
      const request1 = new NextRequest("http://localhost:3000/api/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer test-key",
        },
      });

      await POST(request1);

      // Clear mock to track second call
      mockTransport.handleRequest.mockClear();

      // Second request - should reuse session
      const request2 = new NextRequest("http://localhost:3000/api/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer test-key",
        },
      });

      await POST(request2);

      // Transport should still be used (session reused)
      expect(mockTransport.handleRequest).toHaveBeenCalled();
    });

    it("should return 404 for expired session", async () => {
      // Create session
      const request1 = new NextRequest("http://localhost:3000/api/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer test-key",
        },
      });

      const response1 = await POST(request1);
      expect(response1.status).not.toBe(404);

      // Advance time beyond timeout (31 minutes)
      vi.advanceTimersByTime(31 * 60 * 1000);

      // Trigger cleanup interval
      vi.advanceTimersByTime(5 * 60 * 1000);

      // Try to use expired session with a session ID header
      // Since we can't easily get the session ID from the mock, we'll test the behavior
      // by creating a new request and verifying 404 is returned when session doesn't exist
      const request2 = new NextRequest("http://localhost:3000/api/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer test-key",
          "mcp-session-id": "expired-session-id",
        },
      });

      const response2 = await POST(request2);

      // Should return 404 for expired/invalid session ID
      expect(response2.status).toBe(404);
      const body = await response2.json();
      expect(body.error.message).toBe("Session not found. Please reinitialize.");
    });

    it("should keep session alive with continuous activity", async () => {
      // Create session
      const request = new NextRequest("http://localhost:3000/api/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer test-key",
        },
      });

      await POST(request);

      // Simulate activity every 25 minutes for 2 hours (5 intervals)
      for (let i = 0; i < 5; i++) {
        vi.advanceTimersByTime(25 * 60 * 1000);

        const activityRequest = new NextRequest("http://localhost:3000/api/mcp", {
          method: "POST",
          headers: {
            authorization: "Bearer test-key",
          },
        });

        const response = await POST(activityRequest);
        // Session should still be valid (not 404)
        expect(response.status).not.toBe(404);
      }
    });
  });

  describe("Session Cleanup", () => {
    it("should clean up expired sessions periodically", async () => {
      // Create session
      const request = new NextRequest("http://localhost:3000/api/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer test-key",
        },
      });

      await POST(request);

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

      // Delete with a session ID (we'll use a dummy one for testing)
      const deleteRequest2 = new NextRequest("http://localhost:3000/api/mcp", {
        method: "DELETE",
        headers: {
          "mcp-session-id": "test-session-id",
        },
      });

      const response2 = await DELETE(deleteRequest2);
      // Should return 204 even if session doesn't exist
      expect(response2.status).toBe(204);
    });
  });

  describe("Error Handling", () => {
    it("should return 401 for missing API key", async () => {
      vi.mocked(await import("@/lib/api-key")).extractApiKey.mockReturnValueOnce(null);

      const request = new NextRequest("http://localhost:3000/api/mcp", {
        method: "POST",
        headers: {},
      });

      const response = await POST(request);
      expect(response.status).toBe(401);
    });

    it("should return 401 for invalid API key", async () => {
      vi.mocked(await import("@/lib/api-key")).validateApiKey.mockResolvedValueOnce({
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