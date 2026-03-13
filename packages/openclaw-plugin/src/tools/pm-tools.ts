import type { ChorusMcpClient } from "../mcp-client.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerPmTools(api: any, mcpClient: ChorusMcpClient) {
  // 1. chorus_claim_idea
  api.registerTool({
    name: "chorus_claim_idea",
    description: "Claim an open Idea for elaboration (open -> elaborating). After claiming, start elaboration or create a proposal directly.",
    parameters: {
      type: "object",
      properties: {
        ideaUuid: { type: "string", description: "UUID of the idea to claim" },
      },
      required: ["ideaUuid"],
      additionalProperties: false,
    },
    async execute(_id: string, { ideaUuid }: { ideaUuid: string }) {
      const result = await mcpClient.callTool("chorus_claim_idea", { ideaUuid });
      return JSON.stringify(result, null, 2);
    },
  });

  // 2. chorus_start_elaboration
  api.registerTool({
    name: "chorus_start_elaboration",
    description: "Start an elaboration round for an Idea. Creates structured questions for the stakeholder to answer before proposal creation.",
    parameters: {
      type: "object",
      properties: {
        ideaUuid: { type: "string", description: "UUID of the idea" },
        depth: { type: "string", description: 'Elaboration depth: "minimal", "standard", or "comprehensive"' },
        questions: {
          type: "array",
          description: "Array of questions. Each: { id, text, category, options: [{ id, label, description? }] }",
          items: { type: "object" },
        },
      },
      required: ["ideaUuid", "depth", "questions"],
      additionalProperties: false,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async execute(_id: string, { ideaUuid, depth, questions }: { ideaUuid: string; depth: string; questions: any[] }) {
      const result = await mcpClient.callTool("chorus_pm_start_elaboration", { ideaUuid, depth, questions });
      return JSON.stringify(result, null, 2);
    },
  });

  // 3. chorus_answer_elaboration
  api.registerTool({
    name: "chorus_answer_elaboration",
    description: "Answer elaboration questions for an Idea. Submits answers for a specific elaboration round.",
    parameters: {
      type: "object",
      properties: {
        ideaUuid: { type: "string", description: "UUID of the idea" },
        roundUuid: { type: "string", description: "UUID of the elaboration round" },
        answers: {
          type: "array",
          description: "Array of answers. Each: { questionId, selectedOptionId, customText }",
          items: { type: "object" },
        },
      },
      required: ["ideaUuid", "roundUuid", "answers"],
      additionalProperties: false,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async execute(_id: string, { ideaUuid, roundUuid, answers }: { ideaUuid: string; roundUuid: string; answers: any[] }) {
      const result = await mcpClient.callTool("chorus_answer_elaboration", { ideaUuid, roundUuid, answers });
      return JSON.stringify(result, null, 2);
    },
  });

  // 4. chorus_validate_elaboration
  api.registerTool({
    name: "chorus_validate_elaboration",
    description: "Validate answers from an elaboration round. Empty issues array = all valid, marks elaboration as resolved.",
    parameters: {
      type: "object",
      properties: {
        ideaUuid: { type: "string", description: "UUID of the idea" },
        roundUuid: { type: "string", description: "UUID of the elaboration round" },
        issues: {
          type: "array",
          description: 'Array of issues. Each: { questionId, type: "contradiction"|"ambiguity"|"incomplete", description }. Empty = valid.',
          items: { type: "object" },
        },
      },
      required: ["ideaUuid", "roundUuid", "issues"],
      additionalProperties: false,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async execute(_id: string, { ideaUuid, roundUuid, issues }: { ideaUuid: string; roundUuid: string; issues: any[] }) {
      const result = await mcpClient.callTool("chorus_pm_validate_elaboration", { ideaUuid, roundUuid, issues });
      return JSON.stringify(result, null, 2);
    },
  });

  // 5. chorus_create_proposal
  api.registerTool({
    name: "chorus_create_proposal",
    description: "Create an empty Proposal container. Use chorus_add_document_draft and chorus_add_task_draft to populate it afterwards.",
    parameters: {
      type: "object",
      properties: {
        projectUuid: { type: "string", description: "Project UUID" },
        title: { type: "string", description: "Proposal title" },
        inputType: { type: "string", description: 'Input source type: "idea" or "document"' },
        inputUuids: { type: "array", description: "Array of input UUIDs", items: { type: "string" } },
        description: { type: "string", description: "Proposal description" },
      },
      required: ["projectUuid", "title", "inputType", "inputUuids"],
      additionalProperties: false,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async execute(_id: string, { projectUuid, title, inputType, inputUuids, description }: any) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args: Record<string, any> = { projectUuid, title, inputType, inputUuids };
      if (description !== undefined) args.description = description;
      const result = await mcpClient.callTool("chorus_pm_create_proposal", args);
      return JSON.stringify(result, null, 2);
    },
  });

  // 6. chorus_add_document_draft
  api.registerTool({
    name: "chorus_add_document_draft",
    description: "Add a document draft to a pending Proposal container.",
    parameters: {
      type: "object",
      properties: {
        proposalUuid: { type: "string", description: "Proposal UUID" },
        type: { type: "string", description: "Document type (prd, tech_design, adr, spec, guide)" },
        title: { type: "string", description: "Document title" },
        content: { type: "string", description: "Document content (Markdown)" },
      },
      required: ["proposalUuid", "type", "title", "content"],
      additionalProperties: false,
    },
    async execute(_id: string, { proposalUuid, type, title, content }: { proposalUuid: string; type: string; title: string; content: string }) {
      const result = await mcpClient.callTool("chorus_pm_add_document_draft", { proposalUuid, type, title, content });
      return JSON.stringify(result, null, 2);
    },
  });

  // 7. chorus_add_task_draft
  api.registerTool({
    name: "chorus_add_task_draft",
    description: "Add a task draft to a pending Proposal container.",
    parameters: {
      type: "object",
      properties: {
        proposalUuid: { type: "string", description: "Proposal UUID" },
        title: { type: "string", description: "Task title" },
        description: { type: "string", description: "Task description" },
        priority: { type: "string", description: 'Priority: "low", "medium", or "high"' },
        storyPoints: { type: "number", description: "Effort estimate in agent hours" },
        acceptanceCriteriaItems: { type: "array", description: "Structured acceptance criteria: [{ description, required? }]", items: { type: "object", properties: { description: { type: "string" }, required: { type: "boolean" } }, required: ["description"] } },
        dependsOnDraftUuids: { type: "array", description: "Dependent task draft UUIDs", items: { type: "string" } },
      },
      required: ["proposalUuid", "title"],
      additionalProperties: false,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async execute(_id: string, { proposalUuid, title, description, priority, storyPoints, acceptanceCriteriaItems, dependsOnDraftUuids }: any) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args: Record<string, any> = { proposalUuid, title };
      if (description !== undefined) args.description = description;
      if (priority !== undefined) args.priority = priority;
      if (storyPoints !== undefined) args.storyPoints = storyPoints;
      if (acceptanceCriteriaItems !== undefined) args.acceptanceCriteriaItems = acceptanceCriteriaItems;
      if (dependsOnDraftUuids !== undefined) args.dependsOnDraftUuids = dependsOnDraftUuids;
      const result = await mcpClient.callTool("chorus_pm_add_task_draft", args);
      return JSON.stringify(result, null, 2);
    },
  });

  // 8. chorus_get_proposal — View full proposal with all drafts
  api.registerTool({
    name: "chorus_get_proposal",
    description: "Get detailed information for a Proposal, including all document drafts and task drafts with their UUIDs. Use this to inspect proposal contents before modifying or submitting.",
    parameters: {
      type: "object",
      properties: {
        proposalUuid: { type: "string", description: "Proposal UUID" },
      },
      required: ["proposalUuid"],
      additionalProperties: false,
    },
    async execute(_id: string, { proposalUuid }: { proposalUuid: string }) {
      const result = await mcpClient.callTool("chorus_get_proposal", { proposalUuid });
      return JSON.stringify(result, null, 2);
    },
  });

  // 9. chorus_update_document_draft — Modify an existing document draft
  api.registerTool({
    name: "chorus_update_document_draft",
    description: "Update a document draft in a Proposal. Can change title, type, or content.",
    parameters: {
      type: "object",
      properties: {
        proposalUuid: { type: "string", description: "Proposal UUID" },
        draftUuid: { type: "string", description: "Document draft UUID to update" },
        title: { type: "string", description: "New document title" },
        type: { type: "string", description: "New document type (prd, tech_design, adr, spec, guide)" },
        content: { type: "string", description: "New document content (Markdown)" },
      },
      required: ["proposalUuid", "draftUuid"],
      additionalProperties: false,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async execute(_id: string, { proposalUuid, draftUuid, title, type, content }: any) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args: Record<string, any> = { proposalUuid, draftUuid };
      if (title !== undefined) args.title = title;
      if (type !== undefined) args.type = type;
      if (content !== undefined) args.content = content;
      const result = await mcpClient.callTool("chorus_pm_update_document_draft", args);
      return JSON.stringify(result, null, 2);
    },
  });

  // 10. chorus_update_task_draft — Modify an existing task draft (including dependencies)
  api.registerTool({
    name: "chorus_update_task_draft",
    description: "Update a task draft in a Proposal. Use this to fix validation issues, add dependencies (dependsOnDraftUuids), change priority, etc.",
    parameters: {
      type: "object",
      properties: {
        proposalUuid: { type: "string", description: "Proposal UUID" },
        draftUuid: { type: "string", description: "Task draft UUID to update" },
        title: { type: "string", description: "New task title" },
        description: { type: "string", description: "New task description" },
        priority: { type: "string", description: 'Priority: "low", "medium", or "high"' },
        storyPoints: { type: "number", description: "Effort estimate in agent hours" },
        acceptanceCriteriaItems: { type: "array", description: "Structured acceptance criteria: [{ description, required? }]", items: { type: "object", properties: { description: { type: "string" }, required: { type: "boolean" } }, required: ["description"] } },
        dependsOnDraftUuids: { type: "array", description: "Task draft UUIDs this task depends on (sets execution order)", items: { type: "string" } },
      },
      required: ["proposalUuid", "draftUuid"],
      additionalProperties: false,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async execute(_id: string, { proposalUuid, draftUuid, title, description, priority, storyPoints, acceptanceCriteriaItems, dependsOnDraftUuids }: any) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args: Record<string, any> = { proposalUuid, draftUuid };
      if (title !== undefined) args.title = title;
      if (description !== undefined) args.description = description;
      if (priority !== undefined) args.priority = priority;
      if (storyPoints !== undefined) args.storyPoints = storyPoints;
      if (acceptanceCriteriaItems !== undefined) args.acceptanceCriteriaItems = acceptanceCriteriaItems;
      if (dependsOnDraftUuids !== undefined) args.dependsOnDraftUuids = dependsOnDraftUuids;
      const result = await mcpClient.callTool("chorus_pm_update_task_draft", args);
      return JSON.stringify(result, null, 2);
    },
  });

  // 11. chorus_remove_document_draft
  api.registerTool({
    name: "chorus_remove_document_draft",
    description: "Remove a document draft from a Proposal.",
    parameters: {
      type: "object",
      properties: {
        proposalUuid: { type: "string", description: "Proposal UUID" },
        draftUuid: { type: "string", description: "Document draft UUID to remove" },
      },
      required: ["proposalUuid", "draftUuid"],
      additionalProperties: false,
    },
    async execute(_id: string, { proposalUuid, draftUuid }: { proposalUuid: string; draftUuid: string }) {
      const result = await mcpClient.callTool("chorus_pm_remove_document_draft", { proposalUuid, draftUuid });
      return JSON.stringify(result, null, 2);
    },
  });

  // 12. chorus_remove_task_draft
  api.registerTool({
    name: "chorus_remove_task_draft",
    description: "Remove a task draft from a Proposal.",
    parameters: {
      type: "object",
      properties: {
        proposalUuid: { type: "string", description: "Proposal UUID" },
        draftUuid: { type: "string", description: "Task draft UUID to remove" },
      },
      required: ["proposalUuid", "draftUuid"],
      additionalProperties: false,
    },
    async execute(_id: string, { proposalUuid, draftUuid }: { proposalUuid: string; draftUuid: string }) {
      const result = await mcpClient.callTool("chorus_pm_remove_task_draft", { proposalUuid, draftUuid });
      return JSON.stringify(result, null, 2);
    },
  });

  // 13. chorus_validate_proposal
  api.registerTool({
    name: "chorus_validate_proposal",
    description: "Validate a Proposal's completeness before submission. Returns errors (block submit), warnings, and info. ALWAYS call this before chorus_submit_proposal. If errors exist, use chorus_update_task_draft / chorus_update_document_draft to fix them, then validate again.",
    parameters: {
      type: "object",
      properties: {
        proposalUuid: { type: "string", description: "Proposal UUID to validate" },
      },
      required: ["proposalUuid"],
      additionalProperties: false,
    },
    async execute(_id: string, { proposalUuid }: { proposalUuid: string }) {
      const result = await mcpClient.callTool("chorus_pm_validate_proposal", { proposalUuid });
      return JSON.stringify(result, null, 2);
    },
  });

  // 9. chorus_submit_proposal
  api.registerTool({
    name: "chorus_submit_proposal",
    description: "Submit a Proposal for approval (draft -> pending). Requires all input Ideas to have elaboration resolved.",
    parameters: {
      type: "object",
      properties: {
        proposalUuid: { type: "string", description: "Proposal UUID to submit" },
      },
      required: ["proposalUuid"],
      additionalProperties: false,
    },
    async execute(_id: string, { proposalUuid }: { proposalUuid: string }) {
      const result = await mcpClient.callTool("chorus_pm_submit_proposal", { proposalUuid });
      return JSON.stringify(result, null, 2);
    },
  });

  // 15. chorus_pm_assign_task
  api.registerTool({
    name: "chorus_pm_assign_task",
    description: "Assign a task to a specified Developer Agent. The task must be in open or assigned status. Use chorus_search_mentionables to find the agent UUID.",
    parameters: {
      type: "object",
      properties: {
        taskUuid: { type: "string", description: "Task UUID" },
        agentUuid: { type: "string", description: "Target Developer Agent UUID" },
      },
      required: ["taskUuid", "agentUuid"],
      additionalProperties: false,
    },
    async execute(_id: string, { taskUuid, agentUuid }: { taskUuid: string; agentUuid: string }) {
      const result = await mcpClient.callTool("chorus_pm_assign_task", { taskUuid, agentUuid });
      return JSON.stringify(result, null, 2);
    },
  });

  // 16. chorus_move_idea
  api.registerTool({
    name: "chorus_move_idea",
    description: "Move an Idea to a different project within the same company. Also moves linked draft/pending Proposals.",
    parameters: {
      type: "object",
      properties: {
        ideaUuid: { type: "string", description: "UUID of the idea to move" },
        targetProjectUuid: { type: "string", description: "UUID of the target project" },
      },
      required: ["ideaUuid", "targetProjectUuid"],
      additionalProperties: false,
    },
    async execute(_id: string, { ideaUuid, targetProjectUuid }: { ideaUuid: string; targetProjectUuid: string }) {
      const result = await mcpClient.callTool("chorus_move_idea", { ideaUuid, targetProjectUuid });
      return JSON.stringify(result, null, 2);
    },
  });

  // 17. chorus_pm_create_idea
  api.registerTool({
    name: "chorus_pm_create_idea",
    description: "Create a new Idea in a project. Use this when you discover a requirement, want to propose work, or record a user request.",
    parameters: {
      type: "object",
      properties: {
        projectUuid: { type: "string", description: "Project UUID" },
        title: { type: "string", description: "Idea title" },
        content: { type: "string", description: "Idea detailed description" },
      },
      required: ["projectUuid", "title"],
      additionalProperties: false,
    },
    async execute(_id: string, { projectUuid, title, content }: { projectUuid: string; title: string; content?: string }) {
      const args: Record<string, unknown> = { projectUuid, title };
      if (content) args.content = content;
      const result = await mcpClient.callTool("chorus_pm_create_idea", args);
      return JSON.stringify(result, null, 2);
    },
  });
}
