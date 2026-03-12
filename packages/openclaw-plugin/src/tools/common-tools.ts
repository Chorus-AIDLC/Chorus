import type { ChorusMcpClient } from "../mcp-client.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerCommonTools(api: any, mcpClient: ChorusMcpClient) {
  api.registerTool({
    name: "chorus_checkin",
    description: "Agent check-in. Returns persona, roles, and pending assignments. Recommended at session start.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async execute() {
      const result = await mcpClient.callTool("chorus_checkin", {});
      return JSON.stringify(result, null, 2);
    },
  });

  api.registerTool({
    name: "chorus_get_notifications",
    description: "Get notifications. By default fetches unread and auto-marks them as read.",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", description: "Filter: unread | read | all (default: unread)" },
        autoMarkRead: { type: "boolean", description: "Auto-mark fetched unread as read (default: true)" },
      },
      additionalProperties: false,
    },
    async execute(_id: string, { status, autoMarkRead }: { status?: string; autoMarkRead?: boolean }) {
      const args: Record<string, unknown> = {};
      if (status) args.status = status;
      if (autoMarkRead !== undefined) args.autoMarkRead = autoMarkRead;
      const result = await mcpClient.callTool("chorus_get_notifications", args);
      return JSON.stringify(result, null, 2);
    },
  });

  api.registerTool({
    name: "chorus_get_project",
    description: "Get project details and context",
    parameters: {
      type: "object",
      properties: {
        projectUuid: { type: "string", description: "Project UUID" },
      },
      required: ["projectUuid"],
      additionalProperties: false,
    },
    async execute(_id: string, { projectUuid }: { projectUuid: string }) {
      const result = await mcpClient.callTool("chorus_get_project", { projectUuid });
      return JSON.stringify(result, null, 2);
    },
  });

  api.registerTool({
    name: "chorus_get_task",
    description: "Get detailed information and context for a single task",
    parameters: {
      type: "object",
      properties: {
        taskUuid: { type: "string", description: "Task UUID" },
      },
      required: ["taskUuid"],
      additionalProperties: false,
    },
    async execute(_id: string, { taskUuid }: { taskUuid: string }) {
      const result = await mcpClient.callTool("chorus_get_task", { taskUuid });
      return JSON.stringify(result, null, 2);
    },
  });

  api.registerTool({
    name: "chorus_get_idea",
    description: "Get detailed information for a single idea",
    parameters: {
      type: "object",
      properties: {
        ideaUuid: { type: "string", description: "Idea UUID" },
      },
      required: ["ideaUuid"],
      additionalProperties: false,
    },
    async execute(_id: string, { ideaUuid }: { ideaUuid: string }) {
      const result = await mcpClient.callTool("chorus_get_idea", { ideaUuid });
      return JSON.stringify(result, null, 2);
    },
  });

  api.registerTool({
    name: "chorus_get_available_tasks",
    description: "Get tasks available to claim in a project (status=open)",
    parameters: {
      type: "object",
      properties: {
        projectUuid: { type: "string", description: "Project UUID" },
      },
      required: ["projectUuid"],
      additionalProperties: false,
    },
    async execute(_id: string, { projectUuid }: { projectUuid: string }) {
      const result = await mcpClient.callTool("chorus_get_available_tasks", { projectUuid });
      return JSON.stringify(result, null, 2);
    },
  });

  api.registerTool({
    name: "chorus_get_available_ideas",
    description: "Get ideas available to claim in a project (status=open)",
    parameters: {
      type: "object",
      properties: {
        projectUuid: { type: "string", description: "Project UUID" },
      },
      required: ["projectUuid"],
      additionalProperties: false,
    },
    async execute(_id: string, { projectUuid }: { projectUuid: string }) {
      const result = await mcpClient.callTool("chorus_get_available_ideas", { projectUuid });
      return JSON.stringify(result, null, 2);
    },
  });

  // --- List tools for project exploration ---

  api.registerTool({
    name: "chorus_list_projects",
    description: "List all projects for the current company. Returns projects with counts of ideas, documents, tasks, and proposals.",
    parameters: {
      type: "object",
      properties: {
        page: { type: "number", description: "Page number (default: 1)" },
        pageSize: { type: "number", description: "Items per page (default: 20)" },
      },
      additionalProperties: false,
    },
    async execute(_id: string, { page, pageSize }: { page?: number; pageSize?: number }) {
      const args: Record<string, unknown> = {};
      if (page !== undefined) args.page = page;
      if (pageSize !== undefined) args.pageSize = pageSize;
      const result = await mcpClient.callTool("chorus_list_projects", args);
      return JSON.stringify(result, null, 2);
    },
  });

  api.registerTool({
    name: "chorus_list_tasks",
    description: "List tasks for a project. Can filter by status and priority.",
    parameters: {
      type: "object",
      properties: {
        projectUuid: { type: "string", description: "Project UUID" },
        status: { type: "string", description: "Filter by status: open | assigned | in_progress | to_verify | done | closed" },
        priority: { type: "string", description: "Filter by priority: low | medium | high" },
        page: { type: "number", description: "Page number (default: 1)" },
        pageSize: { type: "number", description: "Items per page (default: 20)" },
      },
      required: ["projectUuid"],
      additionalProperties: false,
    },
    async execute(_id: string, { projectUuid, status, priority, page, pageSize }: { projectUuid: string; status?: string; priority?: string; page?: number; pageSize?: number }) {
      const args: Record<string, unknown> = { projectUuid };
      if (status) args.status = status;
      if (priority) args.priority = priority;
      if (page !== undefined) args.page = page;
      if (pageSize !== undefined) args.pageSize = pageSize;
      const result = await mcpClient.callTool("chorus_list_tasks", args);
      return JSON.stringify(result, null, 2);
    },
  });

  api.registerTool({
    name: "chorus_get_ideas",
    description: "List ideas for a project. Can filter by status.",
    parameters: {
      type: "object",
      properties: {
        projectUuid: { type: "string", description: "Project UUID" },
        status: { type: "string", description: "Filter by status: open | elaborating | proposal_created | completed | closed" },
        page: { type: "number", description: "Page number (default: 1)" },
        pageSize: { type: "number", description: "Items per page (default: 20)" },
      },
      required: ["projectUuid"],
      additionalProperties: false,
    },
    async execute(_id: string, { projectUuid, status, page, pageSize }: { projectUuid: string; status?: string; page?: number; pageSize?: number }) {
      const args: Record<string, unknown> = { projectUuid };
      if (status) args.status = status;
      if (page !== undefined) args.page = page;
      if (pageSize !== undefined) args.pageSize = pageSize;
      const result = await mcpClient.callTool("chorus_get_ideas", args);
      return JSON.stringify(result, null, 2);
    },
  });

  api.registerTool({
    name: "chorus_get_proposals",
    description: "List proposals for a project. Can filter by status.",
    parameters: {
      type: "object",
      properties: {
        projectUuid: { type: "string", description: "Project UUID" },
        status: { type: "string", description: "Filter by status: draft | pending | approved | rejected" },
        page: { type: "number", description: "Page number (default: 1)" },
        pageSize: { type: "number", description: "Items per page (default: 20)" },
      },
      required: ["projectUuid"],
      additionalProperties: false,
    },
    async execute(_id: string, { projectUuid, status, page, pageSize }: { projectUuid: string; status?: string; page?: number; pageSize?: number }) {
      const args: Record<string, unknown> = { projectUuid };
      if (status) args.status = status;
      if (page !== undefined) args.page = page;
      if (pageSize !== undefined) args.pageSize = pageSize;
      const result = await mcpClient.callTool("chorus_get_proposals", args);
      return JSON.stringify(result, null, 2);
    },
  });

  api.registerTool({
    name: "chorus_get_documents",
    description: "List documents for a project. Can filter by type.",
    parameters: {
      type: "object",
      properties: {
        projectUuid: { type: "string", description: "Project UUID" },
        type: { type: "string", description: "Filter by type: prd | tech_design | adr | spec | guide" },
        page: { type: "number", description: "Page number (default: 1)" },
        pageSize: { type: "number", description: "Items per page (default: 20)" },
      },
      required: ["projectUuid"],
      additionalProperties: false,
    },
    async execute(_id: string, { projectUuid, type, page, pageSize }: { projectUuid: string; type?: string; page?: number; pageSize?: number }) {
      const args: Record<string, unknown> = { projectUuid };
      if (type) args.type = type;
      if (page !== undefined) args.page = page;
      if (pageSize !== undefined) args.pageSize = pageSize;
      const result = await mcpClient.callTool("chorus_get_documents", args);
      return JSON.stringify(result, null, 2);
    },
  });

  api.registerTool({
    name: "chorus_get_document",
    description: "Get the detailed content of a single document.",
    parameters: {
      type: "object",
      properties: {
        documentUuid: { type: "string", description: "Document UUID" },
      },
      required: ["documentUuid"],
      additionalProperties: false,
    },
    async execute(_id: string, { documentUuid }: { documentUuid: string }) {
      const result = await mcpClient.callTool("chorus_get_document", { documentUuid });
      return JSON.stringify(result, null, 2);
    },
  });

  api.registerTool({
    name: "chorus_get_unblocked_tasks",
    description: "Get tasks that are ready to start — status is open/assigned and all dependencies are resolved (done/closed). Note: to_verify is NOT considered resolved.",
    parameters: {
      type: "object",
      properties: {
        projectUuid: { type: "string", description: "Project UUID" },
      },
      required: ["projectUuid"],
      additionalProperties: false,
    },
    async execute(_id: string, { projectUuid }: { projectUuid: string }) {
      const result = await mcpClient.callTool("chorus_get_unblocked_tasks", { projectUuid });
      return JSON.stringify(result, null, 2);
    },
  });

  api.registerTool({
    name: "chorus_get_activity",
    description: "Get the activity stream for a project. Shows all actions taken by agents and users.",
    parameters: {
      type: "object",
      properties: {
        projectUuid: { type: "string", description: "Project UUID" },
        page: { type: "number", description: "Page number (default: 1)" },
        pageSize: { type: "number", description: "Items per page (default: 50)" },
      },
      required: ["projectUuid"],
      additionalProperties: false,
    },
    async execute(_id: string, { projectUuid, page, pageSize }: { projectUuid: string; page?: number; pageSize?: number }) {
      const args: Record<string, unknown> = { projectUuid };
      if (page !== undefined) args.page = page;
      if (pageSize !== undefined) args.pageSize = pageSize;
      const result = await mcpClient.callTool("chorus_get_activity", args);
      return JSON.stringify(result, null, 2);
    },
  });

  api.registerTool({
    name: "chorus_get_comments",
    description: "Get comments for an Idea, Proposal, Task, or Document. Useful for understanding context, decisions, and feedback.",
    parameters: {
      type: "object",
      properties: {
        targetType: { type: "string", description: "Target type: idea | proposal | task | document" },
        targetUuid: { type: "string", description: "Target UUID" },
        page: { type: "number", description: "Page number (default: 1)" },
        pageSize: { type: "number", description: "Items per page (default: 20)" },
      },
      required: ["targetType", "targetUuid"],
      additionalProperties: false,
    },
    async execute(_id: string, { targetType, targetUuid, page, pageSize }: { targetType: string; targetUuid: string; page?: number; pageSize?: number }) {
      const args: Record<string, unknown> = { targetType, targetUuid };
      if (page !== undefined) args.page = page;
      if (pageSize !== undefined) args.pageSize = pageSize;
      const result = await mcpClient.callTool("chorus_get_comments", args);
      return JSON.stringify(result, null, 2);
    },
  });

  api.registerTool({
    name: "chorus_get_elaboration",
    description: "Get the full elaboration state for an Idea, including all rounds, questions, answers, and progress summary.",
    parameters: {
      type: "object",
      properties: {
        ideaUuid: { type: "string", description: "Idea UUID" },
      },
      required: ["ideaUuid"],
      additionalProperties: false,
    },
    async execute(_id: string, { ideaUuid }: { ideaUuid: string }) {
      const result = await mcpClient.callTool("chorus_get_elaboration", { ideaUuid });
      return JSON.stringify(result, null, 2);
    },
  });

  api.registerTool({
    name: "chorus_get_my_assignments",
    description: "Get all Ideas and Tasks currently assigned to you.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async execute() {
      const result = await mcpClient.callTool("chorus_get_my_assignments", {});
      return JSON.stringify(result, null, 2);
    },
  });

  // --- Project group tools ---

  api.registerTool({
    name: "chorus_get_project_groups",
    description: "List all project groups. Returns groups with project counts and completion rates.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async execute() {
      const result = await mcpClient.callTool("chorus_get_project_groups", {});
      return JSON.stringify(result, null, 2);
    },
  });

  api.registerTool({
    name: "chorus_get_project_group",
    description: "Get a single project group with its projects and stats.",
    parameters: {
      type: "object",
      properties: {
        groupUuid: { type: "string", description: "Project group UUID" },
      },
      required: ["groupUuid"],
      additionalProperties: false,
    },
    async execute(_id: string, { groupUuid }: { groupUuid: string }) {
      const result = await mcpClient.callTool("chorus_get_project_group", { groupUuid });
      return JSON.stringify(result, null, 2);
    },
  });

  // --- Write tools ---

  api.registerTool({
    name: "chorus_add_comment",
    description: "Add a comment to an Idea, Proposal, Task, or Document",
    parameters: {
      type: "object",
      properties: {
        targetType: { type: "string", description: "Target type: idea | proposal | task | document" },
        targetUuid: { type: "string", description: "Target UUID" },
        content: { type: "string", description: "Comment content" },
      },
      required: ["targetType", "targetUuid", "content"],
      additionalProperties: false,
    },
    async execute(_id: string, { targetType, targetUuid, content }: { targetType: string; targetUuid: string; content: string }) {
      const result = await mcpClient.callTool("chorus_add_comment", { targetType, targetUuid, content });
      return JSON.stringify(result, null, 2);
    },
  });

  api.registerTool({
    name: "chorus_search_mentionables",
    description: "Search for users and agents that can be @mentioned. Returns name, type, and UUID. Use the UUID to write mentions as @[Name](type:uuid) in comment text.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Name or keyword to search" },
        limit: { type: "number", description: "Max results to return (default 10)" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async execute(_id: string, { query, limit }: { query: string; limit?: number }) {
      const args: Record<string, unknown> = { query };
      if (limit !== undefined) args.limit = limit;
      const result = await mcpClient.callTool("chorus_search_mentionables", args);
      return JSON.stringify(result, null, 2);
    },
  });
}
