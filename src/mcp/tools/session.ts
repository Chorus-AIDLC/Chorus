// src/mcp/tools/session.ts
// Agent Session MCP tools (available to all roles)
// UUID-Based Architecture: All operations use UUIDs

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AgentAuthContext } from "@/types/auth";
import * as sessionService from "@/services/session.service";

export function registerSessionTools(server: McpServer, auth: AgentAuthContext) {
  // chorus_list_sessions - List current agent's sessions
  server.registerTool(
    "chorus_list_sessions",
    {
      description: "List all Sessions for the current Agent",
      inputSchema: z.object({
        status: z.enum(["active", "closed"]).optional().describe("Filter by status"),
      }),
    },
    async ({ status }) => {
      const sessions = await sessionService.listAgentSessions(
        auth.companyUuid,
        auth.actorUuid,
        status
      );

      return {
        content: [{ type: "text", text: JSON.stringify(sessions, null, 2) }],
      };
    }
  );

  // chorus_get_session - Get session details
  server.registerTool(
    "chorus_get_session",
    {
      description: "Get Session details and active checkins",
      inputSchema: z.object({
        sessionUuid: z.string().describe("Session UUID"),
      }),
    },
    async ({ sessionUuid }) => {
      const session = await sessionService.getSession(auth.companyUuid, sessionUuid);
      if (!session) {
        return { content: [{ type: "text", text: "Session not found" }], isError: true };
      }

      if (session.agentUuid !== auth.actorUuid) {
        return { content: [{ type: "text", text: "No permission to access this Session" }], isError: true };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(session, null, 2) }],
      };
    }
  );

  // chorus_create_session - Create a new session
  server.registerTool(
    "chorus_create_session",
    {
      description: "Create a new Agent Session. TIP: Before creating, call chorus_list_sessions first to check for existing sessions that can be reopened with chorus_reopen_session.",
      inputSchema: z.object({
        name: z.string().describe("Session name (e.g. 'frontend-worker')"),
        description: z.string().optional().describe("Session description"),
      }),
    },
    async ({ name, description }) => {
      const session = await sessionService.createSession({
        companyUuid: auth.companyUuid,
        agentUuid: auth.actorUuid,
        name,
        description,
      });

      return {
        content: [{ type: "text", text: JSON.stringify({ uuid: session.uuid, name: session.name, status: session.status }, null, 2) }],
      };
    }
  );

  // chorus_close_session - Close a session
  server.registerTool(
    "chorus_close_session",
    {
      description: "Close a Session (batch checkout all checkins)",
      inputSchema: z.object({
        sessionUuid: z.string().describe("Session UUID"),
      }),
    },
    async ({ sessionUuid }) => {
      const session = await sessionService.getSession(auth.companyUuid, sessionUuid);
      if (!session) {
        return { content: [{ type: "text", text: "Session not found" }], isError: true };
      }

      if (session.agentUuid !== auth.actorUuid) {
        return { content: [{ type: "text", text: "No permission to close this Session" }], isError: true };
      }

      const closed = await sessionService.closeSession(auth.companyUuid, sessionUuid);

      return {
        content: [{ type: "text", text: JSON.stringify({ uuid: closed.uuid, status: closed.status }, null, 2) }],
      };
    }
  );

  // chorus_reopen_session - Reopen a closed session
  server.registerTool(
    "chorus_reopen_session",
    {
      description: "Reopen a closed Session (closed → active). Use this to reuse a previous session instead of creating a new one.",
      inputSchema: z.object({
        sessionUuid: z.string().describe("Session UUID"),
      }),
    },
    async ({ sessionUuid }) => {
      const session = await sessionService.getSession(auth.companyUuid, sessionUuid);
      if (!session) {
        return { content: [{ type: "text", text: "Session not found" }], isError: true };
      }

      if (session.agentUuid !== auth.actorUuid) {
        return { content: [{ type: "text", text: "No permission to reopen this Session" }], isError: true };
      }

      if (session.status !== "closed") {
        return { content: [{ type: "text", text: `Session is ${session.status}, only closed sessions can be reopened` }], isError: true };
      }

      const reopened = await sessionService.reopenSession(auth.companyUuid, sessionUuid);

      return {
        content: [{ type: "text", text: JSON.stringify({ uuid: reopened.uuid, status: reopened.status }, null, 2) }],
      };
    }
  );

  // chorus_session_checkin_task - Check in session to a task
  server.registerTool(
    "chorus_session_checkin_task",
    {
      description: "Check in a Session to a specified Task",
      inputSchema: z.object({
        sessionUuid: z.string().describe("Session UUID"),
        taskUuid: z.string().describe("Task UUID"),
      }),
    },
    async ({ sessionUuid, taskUuid }) => {
      const session = await sessionService.getSession(auth.companyUuid, sessionUuid);
      if (!session) {
        return { content: [{ type: "text", text: "Session not found" }], isError: true };
      }

      if (session.agentUuid !== auth.actorUuid) {
        return { content: [{ type: "text", text: "No permission to operate this Session" }], isError: true };
      }

      const checkin = await sessionService.sessionCheckinToTask(
        auth.companyUuid,
        sessionUuid,
        taskUuid
      );

      return {
        content: [{ type: "text", text: JSON.stringify({ sessionUuid, taskUuid, checkedInAt: checkin.checkinAt }, null, 2) }],
      };
    }
  );

  // chorus_session_checkout_task - Check out session from a task
  server.registerTool(
    "chorus_session_checkout_task",
    {
      description: "Check out a Session from a specified Task",
      inputSchema: z.object({
        sessionUuid: z.string().describe("Session UUID"),
        taskUuid: z.string().describe("Task UUID"),
      }),
    },
    async ({ sessionUuid, taskUuid }) => {
      const session = await sessionService.getSession(auth.companyUuid, sessionUuid);
      if (!session) {
        return { content: [{ type: "text", text: "Session not found" }], isError: true };
      }

      if (session.agentUuid !== auth.actorUuid) {
        return { content: [{ type: "text", text: "No permission to operate this Session" }], isError: true };
      }

      await sessionService.sessionCheckoutFromTask(auth.companyUuid, sessionUuid, taskUuid);

      return {
        content: [{ type: "text", text: `Successfully checked out from task ${taskUuid}` }],
      };
    }
  );

  // chorus_session_heartbeat - Session heartbeat
  server.registerTool(
    "chorus_session_heartbeat",
    {
      description: "Session heartbeat (updates lastActiveAt)",
      inputSchema: z.object({
        sessionUuid: z.string().describe("Session UUID"),
      }),
    },
    async ({ sessionUuid }) => {
      const session = await sessionService.getSession(auth.companyUuid, sessionUuid);
      if (!session) {
        return { content: [{ type: "text", text: "Session not found" }], isError: true };
      }

      if (session.agentUuid !== auth.actorUuid) {
        return { content: [{ type: "text", text: "No permission to operate this Session" }], isError: true };
      }

      await sessionService.heartbeatSession(auth.companyUuid, sessionUuid);

      return {
        content: [{ type: "text", text: `Heartbeat successful: ${new Date().toISOString()}` }],
      };
    }
  );
}
