// src/app/api/mcp/route.ts
// MCP HTTP Endpoint (ARCHITECTURE.md §5.2)
// UUID-Based Architecture: All operations use UUIDs

import { NextRequest, NextResponse } from "next/server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "@/mcp/server";
import { extractApiKey, validateApiKey } from "@/lib/api-key";
import { getProjectUuidsByGroup } from "@/services/project.service";
import type { AgentAuthContext } from "@/types/auth";

// Store active session transports
// Sessions are cleaned up via: client DELETE request, transport onclose callback,
// or process restart. No idle timeout — MCP SDK design does not require one,
// and always-on clients (e.g., OpenClaw) need indefinite sessions.
const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();

// Generate session ID
function generateSessionId(): string {
  return crypto.randomUUID();
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
      // Reuse existing session
      transport = sessions.get(sessionId)!;
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

      // Clean up session when transport closes (client DELETE or connection drop)
      transport.onclose = () => {
        sessions.delete(newSessionId);
      };

      sessions.set(newSessionId, transport);
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

    const transport = sessions.get(sessionId);
    if (transport) {
      await transport.close();
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
