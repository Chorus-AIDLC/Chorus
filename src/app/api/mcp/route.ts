// src/app/api/mcp/route.ts
// MCP HTTP Endpoint (ARCHITECTURE.md §5.2)
// UUID-Based Architecture: All operations use UUIDs

import { NextRequest, NextResponse } from "next/server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "@/mcp/server";
import { extractApiKey, validateApiKey } from "@/lib/api-key";
import { getProjectUuidsByGroup } from "@/services/project.service";
import type { AgentAuthContext } from "@/types/auth";

// Store session transport instances with activity tracking
const sessions = new Map<string, {
  transport: WebStandardStreamableHTTPServerTransport;
  lastActivity: number;
}>();

// Session configuration
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // Check every 5 minutes

// Generate session ID
function generateSessionId(): string {
  return crypto.randomUUID();
}

// Clean up expired sessions
function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    if (now - session.lastActivity > SESSION_TIMEOUT_MS) {
      console.log(`[MCP] Cleaning up expired session: ${sessionId}`);
      session.transport.close().catch(console.error);
      sessions.delete(sessionId);
    }
  }
}

// Start periodic cleanup
// NOTE: This assumes a persistent Node.js process (not serverless/edge).
// In serverless environments, cleanup would need to be handled differently
// (e.g., via external scheduler or on-demand cleanup).
setInterval(cleanupExpiredSessions, CLEANUP_INTERVAL_MS);

// Update session activity and reset timeout
function touchSession(sessionId: string) {
  const session = sessions.get(sessionId);
  if (session) {
    session.lastActivity = Date.now();
  }
}

// POST /api/mcp - MCP HTTP Endpoint
export async function POST(request: NextRequest) {
  try {
    // Validate API Key
    const authHeader = request.headers.get("authorization");
    const apiKey = extractApiKey(authHeader);

    if (!apiKey) {
      return NextResponse.json(
        { error: "Missing or invalid API key" },
        { status: 401 }
      );
    }

    const validation = await validateApiKey(apiKey);
    if (!validation.valid || !validation.agent) {
      return NextResponse.json(
        { error: validation.error || "Invalid API key" },
        { status: 401 }
      );
    }

    // Build auth context (UUID-based)
    // Priority: X-Chorus-Project-Group > X-Chorus-Project
    let projectUuids: string[] | undefined;

    const projectGroupUuid = request.headers.get("x-chorus-project-group");
    const projectHeader = request.headers.get("x-chorus-project");

    if (projectGroupUuid) {
      // Query all projects in the group via service layer
      projectUuids = await getProjectUuidsByGroup(validation.agent.companyUuid, projectGroupUuid);
    } else if (projectHeader) {
      // Parse comma-separated project UUIDs
      projectUuids = projectHeader.split(",").map((s) => s.trim()).filter(Boolean);
    }

    const auth: AgentAuthContext = {
      type: "agent",
      companyUuid: validation.agent.companyUuid,
      actorUuid: validation.agent.uuid,
      roles: validation.agent.roles as ("pm" | "developer" | "admin")[],
      ownerUuid: validation.agent.ownerUuid ?? undefined,
      agentName: validation.agent.name,
      projectUuids,
    };

    // Check session ID
    const sessionId = request.headers.get("mcp-session-id");

    let transport: WebStandardStreamableHTTPServerTransport;

    if (sessionId && sessions.has(sessionId)) {
      // Reuse existing session and update activity
      const session = sessions.get(sessionId)!;
      transport = session.transport;
      touchSession(sessionId);
    } else if (sessionId && !sessions.has(sessionId)) {
      // Client sent an expired/invalid session ID (session lost after server restart)
      // Return 404 to let client know it needs to reinitialize
      return NextResponse.json(
        { jsonrpc: "2.0", error: { code: -32001, message: "Session not found. Please reinitialize." }, id: null },
        { status: 404 }
      );
    } else {
      // No session ID — new connection, create new session
      const newSessionId = generateSessionId();
      transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => newSessionId,
      });

      // Create and connect MCP Server
      const server = createMcpServer(auth);
      await server.connect(transport);

      // Store session with initial activity timestamp
      sessions.set(newSessionId, {
        transport,
        lastActivity: Date.now(),
      });
    }

    // Handle request using Web Standard transport
    const response = await transport.handleRequest(request);
    return response;
  } catch (error) {
    console.error("MCP endpoint error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// DELETE /api/mcp - Close MCP Session
export async function DELETE(request: NextRequest) {
  try {
    const sessionId = request.headers.get("mcp-session-id");

    if (!sessionId) {
      return NextResponse.json(
        { error: "Missing session ID" },
        { status: 400 }
      );
    }

    const session = sessions.get(sessionId);
    if (session) {
      await session.transport.close();
      sessions.delete(sessionId);
    }

    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("MCP session close error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// OPTIONS - CORS Preflight
export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, mcp-session-id, mcp-protocol-version",
    },
  });
}
