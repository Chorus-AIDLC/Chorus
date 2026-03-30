import type { ChorusMcpClient } from "../mcp-client.js";

function toolResult(result: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], details: result };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerDevTools(api: any, mcpClient: ChorusMcpClient) {
  api.registerTool({
    name: "chorus_claim_task",
    label: "Claim Task",
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
      return toolResult(result);
    },
  });

  // chorus_update_task — migrated to common-tools.ts (available to all roles, enhanced with field editing)

  api.registerTool({
    name: "chorus_report_work",
    label: "Report Work",
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
      return toolResult(result);
    },
  });

  api.registerTool({
    name: "chorus_submit_for_verify",
    label: "Submit for Verify",
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
      return toolResult(result);
    },
  });

  api.registerTool({
    name: "chorus_report_criteria_self_check",
    label: "Self-Check AC",
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
      return toolResult(result);
    },
  });

}
