import type { ChorusMcpClient } from "../mcp-client.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerDevTools(api: any, mcpClient: ChorusMcpClient) {
  api.registerTool({
    name: "chorus_claim_task",
    description: "Claim an open task (open -> assigned)",
    parameters: {
      type: "object",
      properties: {
        taskUuid: { type: "string", description: "Task UUID to claim" },
      },
      required: ["taskUuid"],
      additionalProperties: false,
    },
    async execute(_id: string, { taskUuid }: { taskUuid: string }) {
      const result = await mcpClient.callTool("chorus_claim_task", { taskUuid });
      return JSON.stringify(result, null, 2);
    },
  });

  api.registerTool({
    name: "chorus_update_task",
    description: "Update task status (only the assignee can operate). Moving to in_progress requires all dependsOn tasks to be done or closed — otherwise the request is rejected with blocker details. Use chorus_get_unblocked_tasks to find tasks ready to start.",
    parameters: {
      type: "object",
      properties: {
        taskUuid: { type: "string", description: "Task UUID" },
        status: { type: "string", description: "New status: in_progress | to_verify" },
        sessionUuid: { type: "string", description: "Session UUID for sub-agent identification" },
      },
      required: ["taskUuid", "status"],
      additionalProperties: false,
    },
    async execute(_id: string, { taskUuid, status, sessionUuid }: { taskUuid: string; status: string; sessionUuid?: string }) {
      const args: Record<string, unknown> = { taskUuid, status };
      if (sessionUuid) args.sessionUuid = sessionUuid;
      const result = await mcpClient.callTool("chorus_update_task", args);
      return JSON.stringify(result, null, 2);
    },
  });

  api.registerTool({
    name: "chorus_report_work",
    description: "Report work progress or completion on a task",
    parameters: {
      type: "object",
      properties: {
        taskUuid: { type: "string", description: "Task UUID" },
        report: { type: "string", description: "Work report content" },
        status: { type: "string", description: "Optional: update status at the same time (in_progress | to_verify)" },
        sessionUuid: { type: "string", description: "Session UUID for sub-agent identification" },
      },
      required: ["taskUuid", "report"],
      additionalProperties: false,
    },
    async execute(_id: string, { taskUuid, report, status, sessionUuid }: { taskUuid: string; report: string; status?: string; sessionUuid?: string }) {
      const args: Record<string, unknown> = { taskUuid, report };
      if (status) args.status = status;
      if (sessionUuid) args.sessionUuid = sessionUuid;
      const result = await mcpClient.callTool("chorus_report_work", args);
      return JSON.stringify(result, null, 2);
    },
  });

  api.registerTool({
    name: "chorus_submit_for_verify",
    description: "Submit task for human verification (in_progress -> to_verify)",
    parameters: {
      type: "object",
      properties: {
        taskUuid: { type: "string", description: "Task UUID" },
        summary: { type: "string", description: "Work summary" },
      },
      required: ["taskUuid"],
      additionalProperties: false,
    },
    async execute(_id: string, { taskUuid, summary }: { taskUuid: string; summary?: string }) {
      const args: Record<string, unknown> = { taskUuid };
      if (summary) args.summary = summary;
      const result = await mcpClient.callTool("chorus_submit_for_verify", args);
      return JSON.stringify(result, null, 2);
    },
  });

  api.registerTool({
    name: "chorus_report_criteria_self_check",
    description: "Report self-check results on acceptance criteria for a task you're working on. For required criteria, keep working until all pass. Only mark optional criteria as failed if out of scope.",
    parameters: {
      type: "object",
      properties: {
        taskUuid: { type: "string", description: "Task UUID" },
        criteria: {
          type: "array",
          description: "Array of { uuid, devStatus: 'passed'|'failed', devEvidence?: string }",
          items: {
            type: "object",
            properties: {
              uuid: { type: "string", description: "AcceptanceCriterion UUID" },
              devStatus: { type: "string", description: "Self-check result: passed | failed" },
              devEvidence: { type: "string", description: "Optional evidence/notes" },
            },
            required: ["uuid", "devStatus"],
          },
        },
      },
      required: ["taskUuid", "criteria"],
      additionalProperties: false,
    },
    async execute(_id: string, { taskUuid, criteria }: { taskUuid: string; criteria: Array<{ uuid: string; devStatus: string; devEvidence?: string }> }) {
      const result = await mcpClient.callTool("chorus_report_criteria_self_check", { taskUuid, criteria });
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
