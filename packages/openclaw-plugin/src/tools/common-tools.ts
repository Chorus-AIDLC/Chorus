import type { ChorusMcpClient } from "../mcp-client.js";

function toolResult(result: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], details: result };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerCommonTools(api: any, mcpClient: ChorusMcpClient) {
  api.registerTool({
    name: "chorus_checkin",
    label: "Check-in",
    description: "Agent check-in. Returns persona, roles, and pending assignments. Recommended at session start.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async execute() {
      const result = await mcpClient.callTool("chorus_checkin", {});
      return toolResult(result);
    },
  });

  api.registerTool({
    name: "chorus_get_notifications",
    label: "Get Notifications",
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
      return toolResult(result);
    },
  });

  api.registerTool({
    name: "chorus_get_project",
    label: "Get Project",
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
      return toolResult(result);
    },
  });

  api.registerTool({
    name: "chorus_get_task",
    label: "Get Task",
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
      return toolResult(result);
    },
  });

  api.registerTool({
    name: "chorus_get_idea",
    label: "Get Idea",
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
      return toolResult(result);
    },
  });

  api.registerTool({
    name: "chorus_get_available_tasks",
    label: "Available Tasks",
    description: "Get tasks available to claim in a project (status=open). Optionally filter by proposal UUIDs.",
    parameters: {
      type: "object",
      properties: {
        projectUuid: { type: "string", description: "Project UUID" },
        proposalUuids: { type: "array", items: { type: "string" }, description: "Filter tasks by proposal UUIDs" },
      },
      required: ["projectUuid"],
      additionalProperties: false,
    },
    async execute(_id: string, { projectUuid, proposalUuids }: { projectUuid: string; proposalUuids?: string[] }) {
      const args: Record<string, unknown> = { projectUuid };
      if (proposalUuids && proposalUuids.length > 0) args.proposalUuids = proposalUuids;
      const result = await mcpClient.callTool("chorus_get_available_tasks", args);
      return toolResult(result);
    },
  });

  api.registerTool({
    name: "chorus_get_available_ideas",
    label: "Available Ideas",
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
      return toolResult(result);
    },
  });

  // --- List tools for project exploration ---

  api.registerTool({
    name: "chorus_list_projects",
    label: "List Projects",
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
      return toolResult(result);
    },
  });

  api.registerTool({
    name: "chorus_list_tasks",
    label: "List Tasks",
    description: "List tasks for a project. Can filter by status, priority, and proposal UUIDs.",
    parameters: {
      type: "object",
      properties: {
        projectUuid: { type: "string", description: "Project UUID" },
        status: { type: "string", description: "Filter by status: open | assigned | in_progress | to_verify | done | closed" },
        priority: { type: "string", description: "Filter by priority: low | medium | high" },
        proposalUuids: { type: "array", items: { type: "string" }, description: "Filter tasks by proposal UUIDs" },
        page: { type: "number", description: "Page number (default: 1)" },
        pageSize: { type: "number", description: "Items per page (default: 20)" },
      },
      required: ["projectUuid"],
      additionalProperties: false,
    },
    async execute(_id: string, { projectUuid, status, priority, proposalUuids, page, pageSize }: { projectUuid: string; status?: string; priority?: string; proposalUuids?: string[]; page?: number; pageSize?: number }) {
      const args: Record<string, unknown> = { projectUuid };
      if (status) args.status = status;
      if (priority) args.priority = priority;
      if (proposalUuids && proposalUuids.length > 0) args.proposalUuids = proposalUuids;
      if (page !== undefined) args.page = page;
      if (pageSize !== undefined) args.pageSize = pageSize;
      const result = await mcpClient.callTool("chorus_list_tasks", args);
      return toolResult(result);
    },
  });

  api.registerTool({
    name: "chorus_get_ideas",
    label: "List Ideas",
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
      return toolResult(result);
    },
  });

  api.registerTool({
    name: "chorus_get_proposals",
    label: "List Proposals",
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
      return toolResult(result);
    },
  });

  api.registerTool({
    name: "chorus_get_documents",
    label: "List Documents",
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
      return toolResult(result);
    },
  });

  api.registerTool({
    name: "chorus_get_document",
    label: "Get Document",
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
      return toolResult(result);
    },
  });

  api.registerTool({
    name: "chorus_get_unblocked_tasks",
    label: "Unblocked Tasks",
    description: "Get tasks that are ready to start — status is open/assigned and all dependencies are resolved (done/closed). Optionally filter by proposal UUIDs. Note: to_verify is NOT considered resolved.",
    parameters: {
      type: "object",
      properties: {
        projectUuid: { type: "string", description: "Project UUID" },
        proposalUuids: { type: "array", items: { type: "string" }, description: "Filter tasks by proposal UUIDs" },
      },
      required: ["projectUuid"],
      additionalProperties: false,
    },
    async execute(_id: string, { projectUuid, proposalUuids }: { projectUuid: string; proposalUuids?: string[] }) {
      const args: Record<string, unknown> = { projectUuid };
      if (proposalUuids && proposalUuids.length > 0) args.proposalUuids = proposalUuids;
      const result = await mcpClient.callTool("chorus_get_unblocked_tasks", args);
      return toolResult(result);
    },
  });

  api.registerTool({
    name: "chorus_get_activity",
    label: "Activity Stream",
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
      return toolResult(result);
    },
  });

  api.registerTool({
    name: "chorus_get_comments",
    label: "Get Comments",
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
      return toolResult(result);
    },
  });

  api.registerTool({
    name: "chorus_get_elaboration",
    label: "Get Elaboration",
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
      return toolResult(result);
    },
  });

  api.registerTool({
    name: "chorus_get_my_assignments",
    label: "My Assignments",
    description: "Get all Ideas and Tasks currently assigned to you.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async execute() {
      const result = await mcpClient.callTool("chorus_get_my_assignments", {});
      return toolResult(result);
    },
  });

  // --- Project group tools ---

  api.registerTool({
    name: "chorus_get_project_groups",
    label: "List Groups",
    description: "List all project groups. Returns groups with project counts and completion rates.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async execute() {
      const result = await mcpClient.callTool("chorus_get_project_groups", {});
      return toolResult(result);
    },
  });

  api.registerTool({
    name: "chorus_get_project_group",
    label: "Get Group",
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
      return toolResult(result);
    },
  });

  // --- Write tools ---

  api.registerTool({
    name: "chorus_add_comment",
    label: "Add Comment",
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
      return toolResult(result);
    },
  });

  api.registerTool({
    name: "chorus_search_mentionables",
    label: "Search Mentionables",
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
      return toolResult(result);
    },
  });

  // ===== Task Creation & Editing (available to all roles) =====

  api.registerTool({
    name: "chorus_create_tasks",
    label: "Create Tasks",
    description:
      "Batch create tasks in a project. Two modes:\n\n" +
      "**Quick Task** (skip Idea→Proposal): omit proposalUuid. Ideal for bug fixes, small features, post-delivery patches.\n" +
      "Flow: create → chorus_claim_task → execute → chorus_report_work → chorus_submit_for_verify → done.\n\n" +
      "**Proposal-linked** (traditional AI-DLC): pass proposalUuid to associate with an approved proposal.\n\n" +
      "Supports batch creation with intra-batch dependencies (draftUuid + dependsOnDraftUuids) and dependencies on existing tasks (dependsOnTaskUuids).",
    parameters: {
      type: "object",
      properties: {
        projectUuid: { type: "string", description: "Project UUID" },
        proposalUuid: { type: "string", description: "Associated Proposal UUID (optional — omit for Quick Task mode)" },
        tasks: {
          type: "array",
          description: "Task list. Each: { title, description?, priority?, storyPoints?, acceptanceCriteriaItems?, draftUuid?, dependsOnDraftUuids?, dependsOnTaskUuids? }",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "Task title" },
              description: { type: "string", description: "Task description" },
              priority: { type: "string", description: 'Priority: "low", "medium", or "high"' },
              storyPoints: { type: "number", description: "Effort estimate in agent hours" },
              acceptanceCriteriaItems: { type: "array", description: "Structured acceptance criteria: [{ description, required? }]", items: { type: "object", properties: { description: { type: "string" }, required: { type: "boolean" } }, required: ["description"] } },
              draftUuid: { type: "string", description: "Temporary UUID for intra-batch dependency references" },
              dependsOnDraftUuids: { type: "array", description: "Dependent draftUuid list within this batch", items: { type: "string" } },
              dependsOnTaskUuids: { type: "array", description: "Dependent existing Task UUID list", items: { type: "string" } },
            },
            required: ["title"],
          },
        },
      },
      required: ["projectUuid", "tasks"],
      additionalProperties: false,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async execute(_id: string, { projectUuid, proposalUuid, tasks }: any) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args: Record<string, any> = { projectUuid, tasks };
      if (proposalUuid !== undefined) args.proposalUuid = proposalUuid;
      const result = await mcpClient.callTool("chorus_create_tasks", args);
      return toolResult(result);
    },
  });

  api.registerTool({
    name: "chorus_update_task",
    label: "Update Task",
    description:
      "Update a task — edit fields, manage dependencies, or change status.\n\n" +
      "**Field editing** (any role): title, description, priority, storyPoints, addDependsOn/removeDependsOn (incremental dependency management).\n\n" +
      "**Status update** (assignee only): in_progress (requires all dependencies resolved), to_verify.\n\n" +
      "For Quick Tasks: create → claim → edit details → execute → verify → done.",
    parameters: {
      type: "object",
      properties: {
        taskUuid: { type: "string", description: "Task UUID" },
        status: { type: "string", description: "New status: in_progress | to_verify (assignee only)" },
        sessionUuid: { type: "string", description: "Session UUID for sub-agent identification" },
        title: { type: "string", description: "New task title" },
        description: { type: "string", description: "New task description (supports @mentions)" },
        priority: { type: "string", description: 'New priority: "low", "medium", or "high"' },
        storyPoints: { type: "number", description: "New effort estimate (agent hours)" },
        addDependsOn: { type: "array", description: "Task UUIDs to add as dependencies", items: { type: "string" } },
        removeDependsOn: { type: "array", description: "Task UUIDs to remove from dependencies", items: { type: "string" } },
      },
      required: ["taskUuid"],
      additionalProperties: false,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async execute(_id: string, { taskUuid, status, sessionUuid, title, description, priority, storyPoints, addDependsOn, removeDependsOn }: any) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args: Record<string, any> = { taskUuid };
      if (status !== undefined) args.status = status;
      if (sessionUuid !== undefined) args.sessionUuid = sessionUuid;
      if (title !== undefined) args.title = title;
      if (description !== undefined) args.description = description;
      if (priority !== undefined) args.priority = priority;
      if (storyPoints !== undefined) args.storyPoints = storyPoints;
      if (addDependsOn !== undefined) args.addDependsOn = addDependsOn;
      if (removeDependsOn !== undefined) args.removeDependsOn = removeDependsOn;
      const result = await mcpClient.callTool("chorus_update_task", args);
      return toolResult(result);
    },
  });

  api.registerTool({
    name: "chorus_search",
    label: "Search",
    description: "Search across tasks, ideas, proposals, documents, projects, and project groups.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query (matches title, description, content)" },
        scope: { type: "string", enum: ["global", "group", "project"], description: "Search scope (default: global)" },
        scopeUuid: { type: "string", description: "Project group UUID (when scope=group) or project UUID (when scope=project)" },
        entityTypes: { type: "array", items: { type: "string", enum: ["task", "idea", "proposal", "document", "project", "project_group"] }, description: "Entity types to search (default: all). Example: [\"task\", \"idea\"]" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async execute(_id: string, { query, scope, scopeUuid, entityTypes }: { query: string; scope?: string; scopeUuid?: string; entityTypes?: string[] }) {
      const args: Record<string, unknown> = { query };
      if (scope) args.scope = scope;
      if (scopeUuid) args.scopeUuid = scopeUuid;
      if (entityTypes) args.entityTypes = entityTypes;
      const result = await mcpClient.callTool("chorus_search", args);
      return toolResult(result);
    },
  });
}
