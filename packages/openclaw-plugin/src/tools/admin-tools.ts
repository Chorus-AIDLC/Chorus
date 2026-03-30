import type { ChorusMcpClient } from "../mcp-client.js";

function toolResult(result: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], details: result };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerAdminTools(api: any, mcpClient: ChorusMcpClient) {
  api.registerTool({
    name: "chorus_admin_create_project",
    label: "Create Project",
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
      return toolResult(result);
    },
  });

  api.registerTool({
    name: "chorus_admin_create_project_group",
    label: "Create Group",
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
      return toolResult(result);
    },
  });

  api.registerTool({
    name: "chorus_admin_approve_proposal",
    label: "Approve Proposal",
    description:
      "Approve a Proposal (Admin exclusive). On approval, documentDrafts and taskDrafts are automatically materialized into real Document and Task entities — materialized Tasks can then be claimed and executed by agents. " +
      "⚠️ This action is irreversible — unless there is a special reason, you MUST obtain explicit human approval before calling this tool.",
    parameters: {
      type: "object",
      properties: {
        proposalUuid: { type: "string", description: "Proposal UUID" },
        reviewNote: { type: "string", description: "Optional review note" },
      },
      required: ["proposalUuid"],
      additionalProperties: false,
    },
    async execute(_id: string, { proposalUuid, reviewNote }: { proposalUuid: string; reviewNote?: string }) {
      const args: Record<string, unknown> = { proposalUuid };
      if (reviewNote) args.reviewNote = reviewNote;
      const result = await mcpClient.callTool("chorus_admin_approve_proposal", args);
      return toolResult(result);
    },
  });

  api.registerTool({
    name: "chorus_admin_verify_task",
    label: "Verify Task",
    description:
      "Verify a Task (to_verify → done, Admin exclusive). Marks a task as completed after verification. Downstream tasks that depend on this task will only be unblocked after it is verified. " +
      "⚠️ This action is irreversible — unless there is a special reason, you MUST obtain explicit human approval before calling this tool.",
    parameters: {
      type: "object",
      properties: {
        taskUuid: { type: "string", description: "Task UUID" },
      },
      required: ["taskUuid"],
      additionalProperties: false,
    },
    async execute(_id: string, { taskUuid }: { taskUuid: string }) {
      const result = await mcpClient.callTool("chorus_admin_verify_task", { taskUuid });
      return toolResult(result);
    },
  });

  api.registerTool({
    name: "chorus_mark_acceptance_criteria",
    label: "Mark AC",
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
      return toolResult(result);
    },
  });
}
