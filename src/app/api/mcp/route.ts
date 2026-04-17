// src/app/api/mcp/route.ts
// Stateless MCP HTTP Endpoint — each request creates a fresh server+transport.
// No session state, no caching. Supports horizontal scaling natively.

import { NextRequest, NextResponse } from "next/server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "@/mcp/server";
import { extractApiKey, validateApiKey } from "@/lib/api-key";
import { getProjectUuidsByGroup } from "@/services/project.service";
import type { AgentAuthContext } from "@/types/auth";
import logger from "@/lib/logger";

const mcpLogger = logger.child({ module: "mcp" });

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
      projectUuids = await getProjectUuidsByGroup(validation.agent.companyUuid, projectGroupUuid);
    } else if (projectHeader) {
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

    // Stateless: fresh server+transport per request, no session state
    const transport = new WebStandardStreamableHTTPServerTransport({});
    const server = createMcpServer(auth);
    await server.connect(transport);

    const response = await transport.handleRequest(request);
    return response;
  } catch (error) {
    mcpLogger.error({ err: error }, "MCP endpoint error");
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// DELETE /api/mcp - No sessions to close in stateless mode
export async function DELETE() {
  return new Response(null, { status: 405 });
}

// OPTIONS - CORS Preflight
export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, mcp-session-id, mcp-protocol-version",
    },
  });
}
