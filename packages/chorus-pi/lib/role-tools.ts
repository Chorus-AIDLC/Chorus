import { existsSync, readFileSync } from "node:fs";
import { getAgentDir, VERSION, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { chorusConfigPaths, chorusMcpBackend, resolveChorusConfigFromMcpJson } from "./lib.js";
import { McpClient, type McpClientOptions } from "./mcp-client.js";
import { isRoleToolAllowed, type ChorusRole } from "./role-policy.js";

export interface RoleToolInput {
  action: "discover" | "call";
  tool?: string;
  arguments?: Record<string, unknown>;
}

export const ROLE_TOOL_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["discover", "call"] },
    tool: { type: "string", description: "Canonical Chorus operation name; required for call, optional discovery filter." },
    arguments: { type: "object", additionalProperties: true },
  },
  required: ["action"],
  additionalProperties: false,
};

export async function executeRoleTool(
  role: ChorusRole, input: RoleToolInput, options: McpClientOptions, signal?: AbortSignal,
) {
  if (!input || (input.action !== "discover" && input.action !== "call")) {
    throw new Error("Chorus action must be discover or call");
  }
  if (input.tool !== undefined && (typeof input.tool !== "string" || !isRoleToolAllowed(role, input.tool))) {
    throw new Error(`Chorus ${role}: operation is not allowed`);
  }
  if (input.action === "call" && !input.tool) throw new Error("Chorus call requires a tool name");
  if (input.arguments !== undefined && (input.arguments === null || typeof input.arguments !== "object" || Array.isArray(input.arguments))) {
    throw new Error("Chorus arguments must be an object");
  }
  const client = new McpClient(options);
  if (input.action === "discover") {
    const tools = (await client.listTools(signal)).filter((tool) =>
      isRoleToolAllowed(role, tool.name) && (!input.tool || tool.name === input.tool));
    return { content: [{ type: "text" as const, text: JSON.stringify({ tools }) }], details: { tools } };
  }
  const result = await client.callTool(input.tool!, input.arguments, signal);
  const content = result.content.map((item) => {
    if (item.type === "text" && typeof item.text === "string") return { type: "text" as const, text: item.text };
    if (item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string") {
      return { type: "image" as const, data: item.data, mimeType: item.mimeType };
    }
    return { type: "text" as const, text: JSON.stringify(item) };
  });
  return { content, details: result, structuredContent: result.structuredContent };
}

export function registerRoleTool(pi: ExtensionAPI, role: ChorusRole): void {
  pi.registerTool({
    name: role === "reviewer" ? "chorus_review" : "chorus_work",
    label: role === "reviewer" ? "Chorus Review" : "Chorus Work",
    description: `Role-scoped Chorus ${role} operations. Use action=discover to get allowed remote tool schemas, then action=call with tool and arguments. Forbidden operations fail before network access.`,
    parameters: ROLE_TOOL_SCHEMA as ToolDefinition["parameters"],
    async execute(_toolCallId, input, signal, _onUpdate, ctx) {
      const config = resolveChorusConfigFromMcpJson(
        chorusConfigPaths(ctx.cwd, getAgentDir(), VERSION, { existsSync }, chorusMcpBackend(pi.getCommands?.() ?? [])),
        { existsSync },
        (path) => readFileSync(path, "utf-8"),
        process.env,
      );
      return executeRoleTool(role, input as RoleToolInput, config, signal);
    },
  });
}
