import type { ChorusMcpClient } from "../mcp-client.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerAdminTools(api: any, mcpClient: ChorusMcpClient) {
  api.registerTool({
    name: "chorus_admin_create_project",
    description: "Create a new project. Call chorus_get_project_groups first to find the right groupUuid.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Project name" },
        description: { type: "string", description: "Project description" },
        groupUuid: { type: "string", description: "Project group UUID (optional, use chorus_get_project_groups to list groups)" },
      },
      required: ["name"],
      additionalProperties: false,
    },
    async execute(_id: string, { name, description, groupUuid }: { name: string; description?: string; groupUuid?: string }) {
      const args: Record<string, unknown> = { name };
      if (description) args.description = description;
      if (groupUuid) args.groupUuid = groupUuid;
      const result = await mcpClient.callTool("chorus_admin_create_project", args);
      return JSON.stringify(result, null, 2);
    },
  });

  api.registerTool({
    name: "chorus_admin_create_project_group",
    description: "Create a new project group for organizing projects.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Group name" },
        description: { type: "string", description: "Group description" },
      },
      required: ["name"],
      additionalProperties: false,
    },
    async execute(_id: string, { name, description }: { name: string; description?: string }) {
      const args: Record<string, unknown> = { name };
      if (description) args.description = description;
      const result = await mcpClient.callTool("chorus_admin_create_project_group", args);
      return JSON.stringify(result, null, 2);
    },
  });

  api.registerTool({
    name: "chorus_mark_acceptance_criteria",
    description: "Mark acceptance criteria as passed or failed (admin verification). Blocked criteria prevent task from being verified (to_verify -> done).",
    parameters: {
      type: "object",
      properties: {
        taskUuid: { type: "string", description: "Task UUID" },
        criteria: {
          type: "array",
          description: "Array of { uuid, status: 'passed'|'failed', evidence?: string }",
          items: {
            type: "object",
            properties: {
              uuid: { type: "string", description: "AcceptanceCriterion UUID" },
              status: { type: "string", description: "Verification result: passed | failed" },
              evidence: { type: "string", description: "Optional evidence/notes" },
            },
            required: ["uuid", "status"],
          },
        },
      },
      required: ["taskUuid", "criteria"],
      additionalProperties: false,
    },
    async execute(_id: string, { taskUuid, criteria }: { taskUuid: string; criteria: Array<{ uuid: string; status: string; evidence?: string }> }) {
      const result = await mcpClient.callTool("chorus_mark_acceptance_criteria", { taskUuid, criteria });
      return JSON.stringify(result, null, 2);
    },
  });
}
