// src/mcp/tools/public.ts
// Public MCP tools - available to all Agents (ARCHITECTURE.md §5.2)
// UUID-Based Architecture: All operations use UUIDs

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  collectionPageSchema,
  collectionPageSizeSchema,
  collectionToolConfig,
  compactCollectionRow,
  enforceToolClassification,
  serializeBoundedAggregate,
  serializeBoundedCollection,
  truncatePreviewText,
} from "./collection-contract";
import type { AgentAuthContext } from "@/types/auth";
import * as projectService from "@/services/project.service";
import { projectExists } from "@/services/project.service";
import * as ideaService from "@/services/idea.service";
import * as documentService from "@/services/document.service";
import * as taskService from "@/services/task.service";
import * as proposalService from "@/services/proposal.service";
import * as referenceArtifactService from "@/services/reference-artifact.service";
import { REFERENCE_TYPES } from "@/services/reference-artifact.service";
import * as activityService from "@/services/activity.service";
import * as commentService from "@/services/comment.service";
import * as assignmentService from "@/services/assignment.service";
import { zArray } from "./schema-utils";
import * as notificationService from "@/services/notification.service";
import * as elaborationService from "@/services/elaboration.service";
import * as projectGroupService from "@/services/project-group.service";
import * as mentionService from "@/services/mention.service";
import * as searchService from "@/services/search.service";
import * as sessionService from "@/services/session.service";
import * as checkinService from "@/services/checkin.service";
import { registerPermissionedTool } from "./register-helpers";
import { isAssignmentOwnedByActor } from "@/lib/uuid-resolver";
import {
  ACCEPTANCE_CRITERIA_REQUIRED_MESSAGE,
  hasNonEmptyAcceptanceCriteria,
  normalizeAcceptanceCriteria,
} from "@/lib/acceptance-criteria";

export function registerPublicTools(server: McpServer, auth: AgentAuthContext) {
  server = enforceToolClassification(server);
  const serializePage = (
    collectionKey: string,
    rows: unknown[],
    total: number,
    page: number,
    pageSize: number,
    keys: readonly string[],
    textKeys?: readonly string[],
    extra?: Record<string, unknown>,
  ) =>
    serializeBoundedCollection({
      collectionKey,
      rows: rows.map((row) => compactCollectionRow(row, keys, textKeys)),
      total,
      page,
      pageSize,
      extra,
    });

  const serializeAuthoritativePage = (
    collectionKey: string,
    rows: unknown[],
    total: number,
    page: number,
    pageSize: number,
    extra?: Record<string, unknown>,
  ) =>
    serializeBoundedCollection({
      collectionKey,
      rows,
      total,
      page,
      pageSize,
      extra,
    });

  const compactTracker = (
    tracker: Record<string, { name: string; ideas?: unknown[]; tasks?: unknown[] }>,
    itemKey: "ideas" | "tasks",
    keys: readonly string[],
    maximumRows = 100,
  ) => {
    let remaining = maximumRows;
    const compact: Record<string, { name: string; [key: string]: unknown }> = {};
    for (const [projectUuid, project] of Object.entries(tracker)) {
      const items = project[itemKey] ?? [];
      const rows = items
        .slice(0, remaining)
        .map((row) => compactCollectionRow(row, keys));
      remaining -= rows.length;
      compact[projectUuid] = {
        name: project.name,
        [itemKey]: rows,
      };
    }
    return compact;
  };

  // Inline reference item shape (Thread C) for the per-task references[] on
  // chorus_create_tasks. Enum derived from the service's allowed set so the
  // schema and service validation never drift; matches the createReferences
  // helper's ReferenceCreateItem ({ type, url, title, notes? }).
  const referenceInlineItemSchema = z.object({
    type: z.enum(REFERENCE_TYPES as unknown as [string, ...string[]]).describe("Reference type: docs, repo, issue_pr, or paper_blog"),
    url: z.string().describe("Web URL (http:// or https://)"),
    title: z.string().describe("Reference title"),
    notes: z.string().optional().describe("Optional one-line summary of why this reference is relevant — keep it to a single concise sentence (~200 chars, ≤2 lines); the UI clamps the display to 2 lines. Stored verbatim; no fetch."),
  });

  // chorus_get_project - Get project details and context
  server.registerTool(
    "chorus_get_project",
    {
      description: "Get project details and context",
      inputSchema: z.object({
        projectUuid: z.string().describe("Project UUID"),
      }),
    },
    async ({ projectUuid }) => {
      const project = await projectService.getProjectByUuid(auth.companyUuid, projectUuid);
      if (!project) {
        return { content: [{ type: "text", text: "Project not found" }], isError: true };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(project, null, 2) }],
      };
    }
  );

  // chorus_list_projects - List all projects
  server.registerTool(
    "chorus_list_projects",
    collectionToolConfig({
      description: "List compact project summaries. Use chorus_get_project for full details.",
      inputSchema: z.object({
        page: collectionPageSchema,
        pageSize: collectionPageSizeSchema,
      }),
    }),
    async ({ page, pageSize }) => {
      const skip = (page - 1) * pageSize;
      const { projects, total } = await projectService.listProjects({
        companyUuid: auth.companyUuid,
        skip,
        take: pageSize,
      });
      return {
        content: [{
          type: "text",
          text: serializePage(
            "projects",
            projects,
            total,
            page,
            pageSize,
            ["uuid", "name", "status", "groupUuid", "_count", "createdAt", "updatedAt"],
          ),
        }],
      };
    }
  );

  // chorus_get_ideas - Get Ideas list
  server.registerTool(
    "chorus_get_ideas",
    collectionToolConfig({
      description: "Get compact Idea summaries for a project. Use chorus_get_idea for full details.",
      inputSchema: z.object({
        projectUuid: z.string().describe("Project UUID"),
        status: z.enum(["open", "elaborating", "elaborated"]).optional().describe("Filter by status"),
        page: collectionPageSchema,
        pageSize: collectionPageSizeSchema,
      }),
    }),
    async ({ projectUuid, status, page = 1, pageSize = 20 }) => {
      // Verify project exists
      const project = await projectService.getProjectByUuid(auth.companyUuid, projectUuid);
      if (!project) {
        return { content: [{ type: "text", text: "Project not found" }], isError: true };
      }

      const skip = (page - 1) * pageSize;
      const { ideas, total } = await ideaService.listIdeas({
        companyUuid: auth.companyUuid,
        projectUuid,
        skip,
        take: pageSize,
        status,
      });

      return {
        content: [{
          type: "text",
          text: serializePage(
            "ideas",
            ideas,
            total,
            page,
            pageSize,
            ["uuid", "title", "status", "derivedStatus", "projectUuid", "parentUuid", "reportCount", "createdAt", "updatedAt"],
          ),
        }],
      };
    }
  );

  // chorus_get_documents - Get Documents list
  server.registerTool(
    "chorus_get_documents",
    collectionToolConfig({
      description: "Get compact Document summaries for a project. Use chorus_get_document for full content.",
      inputSchema: z.object({
        projectUuid: z.string().describe("Project UUID"),
        type: z.enum(["prd", "tech_design", "adr", "spec", "guide", "report"]).optional().describe("Filter by type"),
        page: collectionPageSchema,
        pageSize: collectionPageSizeSchema,
      }),
    }),
    async ({ projectUuid, type, page = 1, pageSize = 20 }) => {
      // Verify project exists
      const project = await projectService.getProjectByUuid(auth.companyUuid, projectUuid);
      if (!project) {
        return { content: [{ type: "text", text: "Project not found" }], isError: true };
      }

      const skip = (page - 1) * pageSize;
      const { documents, total } = await documentService.listDocuments({
        companyUuid: auth.companyUuid,
        projectUuid,
        skip,
        take: pageSize,
        type,
      });

      return {
        content: [{
          type: "text",
          text: serializePage(
            "documents",
            documents,
            total,
            page,
            pageSize,
            ["uuid", "title", "type", "projectUuid", "proposalUuid", "createdAt", "updatedAt"],
          ),
        }],
      };
    }
  );

  // chorus_get_document - Get single Document details
  server.registerTool(
    "chorus_get_document",
    {
      description: "Get the detailed content of a single Document",
      inputSchema: z.object({
        documentUuid: z.string().describe("Document UUID"),
      }),
    },
    async ({ documentUuid }) => {
      const document = await documentService.getDocument(auth.companyUuid, documentUuid);
      if (!document) {
        return { content: [{ type: "text", text: "Document not found" }], isError: true };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(document, null, 2) }],
      };
    }
  );

  // chorus_get_proposals - Get Proposals list
  server.registerTool(
    "chorus_get_proposals",
    collectionToolConfig({
      description: "Get compact Proposal summaries and statuses. Use chorus_get_proposal for details.",
      inputSchema: z.object({
        projectUuid: z.string().describe("Project UUID"),
        status: z.enum(["draft", "pending", "approved", "closed"]).optional().describe("Filter by status"),
        page: collectionPageSchema,
        pageSize: collectionPageSizeSchema,
      }),
    }),
    async ({ projectUuid, status, page = 1, pageSize = 20 }) => {
      // Verify project exists
      const project = await projectService.getProjectByUuid(auth.companyUuid, projectUuid);
      if (!project) {
        return { content: [{ type: "text", text: "Project not found" }], isError: true };
      }

      const skip = (page - 1) * pageSize;
      const { proposals, total } = await proposalService.listProposals({
        companyUuid: auth.companyUuid,
        projectUuid,
        skip,
        take: pageSize,
        status,
      });

      return {
        content: [{
          type: "text",
          text: serializePage(
            "proposals",
            proposals,
            total,
            page,
            pageSize,
            ["uuid", "title", "status", "projectUuid", "ideaUuid", "createdAt", "updatedAt"],
          ),
        }],
      };
    }
  );

  // chorus_get_task - Get Task details
  server.registerTool(
    "chorus_get_task",
    {
      description: "Get detailed information and context for a single Task",
      inputSchema: z.object({
        taskUuid: z.string().describe("Task UUID"),
      }),
    },
    async ({ taskUuid }) => {
      const task = await taskService.getTask(auth.companyUuid, taskUuid);
      if (!task) {
        return { content: [{ type: "text", text: "Task not found" }], isError: true };
      }
      // Inline reference read path (q6=a): surface the task's linked reference
      // artifacts so an authoring/review agent sees the evidence on the same
      // call. Additive + backward-compatible; no separate reference-read tool.
      const references = await referenceArtifactService.listReferences({
        companyUuid: auth.companyUuid,
        targetType: "task",
        targetUuid: task.uuid,
      });
      return {
        content: [{ type: "text", text: JSON.stringify({ ...task, references }, null, 2) }],
      };
    }
  );

  // chorus_list_tasks - List Tasks
  server.registerTool(
    "chorus_list_tasks",
    collectionToolConfig({
      description: "List compact Task summaries for a project. Use chorus_get_task for full details.",
      inputSchema: z.object({
        projectUuid: z.string().describe("Project UUID"),
        status: z.enum(["open", "assigned", "in_progress", "to_verify", "done", "closed"]).optional().describe("Filter by status"),
        priority: z.enum(["low", "medium", "high"]).optional().describe("Filter by priority"),
        proposalUuids: zArray(z.string()).optional().describe("Filter tasks by proposal UUIDs"),
        page: collectionPageSchema,
        pageSize: collectionPageSizeSchema,
      }),
    }),
    async ({ projectUuid, status, priority, proposalUuids, page = 1, pageSize = 20 }) => {
      // Verify project exists
      const project = await projectService.getProjectByUuid(auth.companyUuid, projectUuid);
      if (!project) {
        return { content: [{ type: "text", text: "Project not found" }], isError: true };
      }

      const skip = (page - 1) * pageSize;
      const { tasks, total } = await taskService.listTasks({
        companyUuid: auth.companyUuid,
        projectUuid,
        skip,
        take: pageSize,
        status,
        priority,
        proposalUuids,
      });

      return {
        content: [{
          type: "text",
          text: serializePage(
            "tasks",
            tasks,
            total,
            page,
            pageSize,
            ["uuid", "title", "status", "priority", "projectUuid", "proposalUuid", "assigneeUuid", "storyPoints", "createdAt", "updatedAt"],
          ),
        }],
      };
    }
  );

  // chorus_get_activity - Get project activity stream
  server.registerTool(
    "chorus_get_activity",
    collectionToolConfig({
      description: "Get the paginated activity stream for a project. Activities have no separate single-resource get tool, so rows include their full workflow data.",
      inputSchema: z.object({
        projectUuid: z.string().describe("Project UUID"),
        page: collectionPageSchema,
        pageSize: collectionPageSizeSchema,
      }),
    }),
    async ({ projectUuid, page = 1, pageSize = 20 }) => {
      // Verify project exists
      const project = await projectService.getProjectByUuid(auth.companyUuid, projectUuid);
      if (!project) {
        return { content: [{ type: "text", text: "Project not found" }], isError: true };
      }

      const skip = (page - 1) * pageSize;
      const { activities, total } = await activityService.listActivities({
        companyUuid: auth.companyUuid,
        projectUuid,
        skip,
        take: pageSize,
      });

      return {
        content: [{
          type: "text",
          text: serializeAuthoritativePage(
            "activities",
            activities,
            total,
            page,
            pageSize,
          ),
        }],
      };
    }
  );

  // chorus_add_comment - Add a comment
  server.registerTool(
    "chorus_add_comment",
    {
      description: "Add a comment to an Idea/Proposal/Task/Document",
      inputSchema: z.object({
        targetType: z.enum(["idea", "proposal", "task", "document"]).describe("Target type"),
        targetUuid: z.string().describe("Target UUID"),
        content: z.string().describe("Comment content"),
      }),
    },
    async ({ targetType, targetUuid, content }) => {
      try {
        const comment = await commentService.createComment({
          companyUuid: auth.companyUuid,
          targetType,
          targetUuid,
          content,
          authorType: "agent",
          authorUuid: auth.actorUuid,
        });

        // Resolve projectUuid from the target entity
        const projectUuid = await commentService.resolveProjectUuid(targetType, targetUuid);
        if (projectUuid) {
          await activityService.createActivity({
            companyUuid: auth.companyUuid,
            projectUuid,
            targetType: targetType as "idea" | "proposal" | "task" | "document",
            targetUuid,
            actorType: "agent",
            actorUuid: auth.actorUuid,
            action: "comment_added",
          });
        }

        return {
          content: [{ type: "text", text: JSON.stringify({ uuid: comment.uuid, targetType, targetUuid }, null, 2) }],
        };
      } catch (error) {
        if (error instanceof Error && error.message.includes("not found")) {
          return { content: [{ type: "text", text: `${targetType} not found` }], isError: true };
        }
        throw error;
      }
    }
  );

  // chorus_checkin - Agent heartbeat check-in
  server.registerTool(
    "chorus_checkin",
    collectionToolConfig({
      description:
        "Agent check-in. Returns agent identity (owner, roles, persona), activeProjects — a per-project distribution of your active ideas (project name + active-idea count, NOT a per-idea list) — a short guidance list (follow AI-DLC via the Chorus skill; use chorus_search to locate work), and up to 5 recent unread notifications (auto-marked read). Recommended at session start. For the full per-idea list, call chorus_get_my_assignments.",
      inputSchema: z.object({}),
    }),
    async () => {
      const result = await checkinService.buildCheckinResponse(auth);
      return {
        content: [{ type: "text", text: serializeBoundedAggregate(result) }],
      };
    }
  );

  // chorus_get_my_assignments - Get own claimed Ideas + Tasks
  server.registerTool(
    "chorus_get_my_assignments",
    collectionToolConfig({
      description:
        "Get the agent's FULL idea/task tracker, grouped by project — the on-demand full list (chorus_checkin only returns an activeProjects project→count distribution). Returns { ideaTracker, taskTracker } where ideaTracker carries per-idea derivedStatus + proposal/task counts and taskTracker carries acceptance criteria progress.",
      inputSchema: z.object({}),
    }),
    async () => {
      const result = await assignmentService.getMyAssignments(auth, auth.projectUuids);
      const ideaTracker = compactTracker(
        result.ideaTracker,
        "ideas",
        ["uuid", "title", "status", "parentUuid", "proposals", "tasks"],
      );
      const taskTracker = compactTracker(
        result.taskTracker,
        "tasks",
        ["uuid", "title", "status", "priority", "proposalUuid", "acceptanceSummary"],
      );

      return {
        content: [{
          type: "text",
          text: serializeBoundedAggregate({ ideaTracker, taskTracker }),
        }],
      };
    }
  );

  // chorus_get_available_ideas - Get claimable Ideas
  server.registerTool(
    "chorus_get_available_ideas",
    collectionToolConfig({
      description: "Get up to 50 compact Idea summaries available to claim in a project (status=open). This is a bounded discovery result, so total equals the returned candidate count.",
      inputSchema: z.object({
        projectUuid: z.string().describe("Project UUID"),
      }),
    }),
    async ({ projectUuid }) => {
      // Verify project exists
      const project = await projectService.getProjectByUuid(auth.companyUuid, projectUuid);
      if (!project) {
        return { content: [{ type: "text", text: "Project not found" }], isError: true };
      }

      const { ideas } = await assignmentService.getAvailableItems(
        auth.companyUuid,
        projectUuid,
        true,
        false
      );

      return {
        content: [{
          type: "text",
          text: serializePage(
            "ideas",
            ideas.slice(0, 100),
            ideas.length,
            1,
            100,
            ["uuid", "title", "status", "projectUuid", "parentUuid", "createdAt", "updatedAt"],
          ),
        }],
      };
    }
  );

  // chorus_get_available_tasks - Get claimable Tasks
  server.registerTool(
    "chorus_get_available_tasks",
    collectionToolConfig({
      description: "Get up to 50 compact Task summaries available to claim in a project (status=open). This is a bounded discovery result, so total equals the returned candidate count.",
      inputSchema: z.object({
        projectUuid: z.string().describe("Project UUID"),
        proposalUuids: zArray(z.string()).optional().describe("Filter tasks by proposal UUIDs"),
      }),
    }),
    async ({ projectUuid, proposalUuids }) => {
      // Verify project exists
      const project = await projectService.getProjectByUuid(auth.companyUuid, projectUuid);
      if (!project) {
        return { content: [{ type: "text", text: "Project not found" }], isError: true };
      }

      const { tasks } = await assignmentService.getAvailableItems(
        auth.companyUuid,
        projectUuid,
        false,
        true,
        proposalUuids
      );

      return {
        content: [{
          type: "text",
          text: serializePage(
            "tasks",
            tasks.slice(0, 100),
            tasks.length,
            1,
            100,
            ["uuid", "title", "status", "priority", "projectUuid", "proposalUuid", "storyPoints", "createdAt", "updatedAt"],
          ),
        }],
      };
    }
  );

  // chorus_get_idea - Get single Idea details
  server.registerTool(
    "chorus_get_idea",
    {
      description: "Get detailed information for a single Idea. Includes `reports[]` — full content of the idea's completion reports, newest first.",
      inputSchema: z.object({
        ideaUuid: z.string().describe("Idea UUID"),
      }),
    },
    async ({ ideaUuid }) => {
      const idea = await ideaService.getIdea(auth.companyUuid, ideaUuid);
      if (!idea) {
        return { content: [{ type: "text", text: "Idea not found" }], isError: true };
      }
      // Inline reference read path (q6=a): surface the idea's linked reference
      // artifacts so an authoring/review agent sees the evidence on the same
      // call. Additive + backward-compatible; mirrors get_task / get_proposal.
      const references = await referenceArtifactService.listReferences({
        companyUuid: auth.companyUuid,
        targetType: "idea",
        targetUuid: idea.uuid,
      });
      return {
        content: [{ type: "text", text: JSON.stringify({ ...idea, references }, null, 2) }],
      };
    }
  );

  // chorus_get_proposal - Get a single Proposal as a section-scoped view
  server.registerTool(
    "chorus_get_proposal",
    {
      description:
        "Get a single Proposal, sliced into one section to avoid oversized payloads. Start with the default `basic` view to see what exists, then drill into a heavier section using the same `proposalUuid`.",
      inputSchema: z.object({
        proposalUuid: z.string().describe("Proposal UUID"),
        section: z
          .enum(["basic", "documents", "tasks", "full"])
          .optional()
          .describe(
            "Which slice to return (default `basic`). `basic`: metadata + a lightweight index of document drafts (uuid, type, title, contentLength) and task drafts (uuid, title, priority, storyPoints, acceptanceCriteriaCount, dependsOnDraftUuids) — no content. `documents`: metadata + FULL document drafts (with content). `tasks`: metadata + FULL task drafts (descriptions + acceptance criteria). `full`: everything in one payload. Every response echoes the view in a `section` field."
          ),
      }),
    },
    async ({ proposalUuid, section }) => {
      const view = section ?? "basic";
      const proposal = await proposalService.getProposalSection(auth.companyUuid, proposalUuid, view);
      if (!proposal) {
        return { content: [{ type: "text", text: "Proposal not found" }], isError: true };
      }
      // Inline reference read path (q6=a): surface the proposal's linked
      // reference artifacts alongside every section view. Additive +
      // backward-compatible; no separate reference-read tool.
      const references = await referenceArtifactService.listReferences({
        companyUuid: auth.companyUuid,
        targetType: "proposal",
        targetUuid: proposal.uuid,
      });
      return {
        content: [{ type: "text", text: JSON.stringify({ ...proposal, references }, null, 2) }],
      };
    }
  );

  // chorus_get_unblocked_tasks - Get unblocked tasks (all dependencies resolved)
  server.registerTool(
    "chorus_get_unblocked_tasks",
    collectionToolConfig({
      description: "Get compact Task summaries that are ready to start. Use chorus_get_task for full details.",
      inputSchema: z.object({
        projectUuid: z.string().describe("Project UUID"),
        proposalUuids: zArray(z.string()).optional().describe("Filter tasks by proposal UUIDs"),
        page: collectionPageSchema,
        pageSize: collectionPageSizeSchema,
      }),
    }),
    async ({ projectUuid, proposalUuids, page = 1, pageSize = 20 }) => {
      // Verify project exists
      const project = await projectService.getProjectByUuid(auth.companyUuid, projectUuid);
      if (!project) {
        return { content: [{ type: "text", text: "Project not found" }], isError: true };
      }

      const { tasks, total } = await taskService.getUnblockedTasks({
        companyUuid: auth.companyUuid,
        projectUuid,
        proposalUuids,
        skip: (page - 1) * pageSize,
        take: pageSize,
      });

      return {
        content: [{
          type: "text",
          text: serializePage(
            "tasks",
            tasks,
            total,
            page,
            pageSize,
            ["uuid", "title", "status", "priority", "projectUuid", "proposalUuid", "storyPoints", "createdAt", "updatedAt"],
          ),
        }],
      };
    }
  );

  // chorus_get_comments - Get comments list
  server.registerTool(
    "chorus_get_comments",
    collectionToolConfig({
      description: "Get paginated comments, newest first. Comments have no separate single-resource get tool, so rows include content and author details.",
      inputSchema: z.object({
        targetType: z.enum(["idea", "proposal", "task", "document"]).describe("Target type"),
        targetUuid: z.string().describe("Target UUID"),
        page: collectionPageSchema,
        pageSize: collectionPageSizeSchema,
      }),
    }),
    async ({ targetType, targetUuid, page = 1, pageSize = 20 }) => {
      const skip = (page - 1) * pageSize;
      const { comments, total } = await commentService.listComments({
        companyUuid: auth.companyUuid,
        targetType,
        targetUuid,
        skip,
        take: pageSize,
      });

      return {
        content: [{
          type: "text",
          text: serializeAuthoritativePage(
            "comments",
            comments,
            total,
            page,
            pageSize,
          ),
        }],
      };
    }
  );

  // chorus_get_notifications - Get notifications for the current Agent
  server.registerTool(
    "chorus_get_notifications",
    collectionToolConfig({
      description: "Get the list of notifications for the current Agent. By default, fetching unread notifications automatically marks them as read. Set autoMarkRead=false to keep them unread.",
      inputSchema: z.object({
        status: z.enum(["unread", "read", "all"]).default("unread").optional().describe("Filter by status"),
        limit: collectionPageSizeSchema.optional().describe("Items per page"),
        offset: z.number().int().nonnegative().default(0).optional().describe("Offset"),
        autoMarkRead: z.boolean().default(true).optional().describe("Automatically mark fetched unread notifications as read (default: true)"),
      }),
    }),
    async (params) => {
      const statusValue = params.status ?? "unread";
      const result = await notificationService.list({
        companyUuid: auth.companyUuid,
        recipientType: auth.type,
        recipientUuid: auth.actorUuid,
        readFilter: statusValue === "unread" ? "unread" : statusValue === "read" ? "read" : "all",
        skip: params.offset ?? 0,
        take: params.limit ?? 20,
      });

      // Auto-mark fetched unread notifications as read
      if ((params.autoMarkRead ?? true) && statusValue === "unread" && result.notifications?.length > 0) {
        const unreadUuids = result.notifications
          .filter((n: { readAt?: string | null }) => !n.readAt)
          .map((n: { uuid: string }) => n.uuid);
        if (unreadUuids.length > 0) {
          await Promise.all(
            unreadUuids.map((uuid: string) =>
              notificationService.markRead(uuid, auth.companyUuid, auth.type, auth.actorUuid).catch(() => {})
            )
          );
        }
      }

      const limit = params.limit ?? 20;
      const offset = params.offset ?? 0;
      return {
        content: [{
          type: "text" as const,
          text: serializeAuthoritativePage(
            "notifications",
            result.notifications,
            result.total,
            Math.floor(offset / limit) + 1,
            limit,
            { unreadCount: result.unreadCount },
          ),
        }],
      };
    }
  );

  // chorus_mark_notification_read - Mark notification(s) as read
  server.registerTool(
    "chorus_mark_notification_read",
    {
      description: "Mark notification(s) as read (single or all)",
      inputSchema: z.object({
        notificationUuid: z.string().optional().describe("Single notification UUID"),
        all: z.boolean().default(false).optional().describe("Whether to mark all as read"),
      }),
    },
    async (params) => {
      if (params.all) {
        await notificationService.markAllRead(auth.companyUuid, auth.type, auth.actorUuid);
        return { content: [{ type: "text" as const, text: JSON.stringify({ success: true }, null, 2) }] };
      }
      if (!params.notificationUuid) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: "notificationUuid or all=true required" }) }], isError: true };
      }
      await notificationService.markRead(params.notificationUuid, auth.companyUuid, auth.type, auth.actorUuid);
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: true }, null, 2) }] };
    }
  );

  // ===== Elaboration Tools =====

  // chorus_answer_elaboration - Answer elaboration questions
  server.registerTool(
    "chorus_answer_elaboration",
    {
      description: "Answer elaboration questions for an Idea. Submits answers for an elaboration round. When roundUuid is omitted, the Idea's single active (pending_answers) round is located automatically. When all required questions are answered, the round moves to validation. Also use this to record decisions made outside the formal elaboration flow — if the user clarified requirements in conversation, capture those decisions here as answers so they are persisted to the Idea as an audit trail.",
      inputSchema: z.object({
        ideaUuid: z.string().describe("Idea UUID"),
        roundUuid: z.string().optional().describe("Elaboration round UUID (optional; when omitted, the active round is located automatically)"),
        answers: zArray(z.object({
          questionId: z.string().describe("Question ID to answer"),
          selectedOptionId: z.string().nullable().describe("Selected option ID. Set to null for free-text 'Other' answers."),
          customText: z.string().nullable().describe("Optional note when an option is selected, or REQUIRED free-text when selectedOptionId is null ('Other'). At least one of selectedOptionId or customText must be non-null."),
        })).describe("Answers to submit"),
      }),
    },
    async ({ ideaUuid, roundUuid, answers }) => {
      try {
        const round = await elaborationService.answerElaboration({
          companyUuid: auth.companyUuid,
          ideaUuid,
          roundUuid,
          actorUuid: auth.actorUuid,
          actorType: auth.type,
          answers,
        });

        return {
          content: [{ type: "text", text: JSON.stringify(round, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed to answer elaboration: ${error instanceof Error ? error.message : "Unknown error"}` }],
          isError: true,
        };
      }
    }
  );

  // chorus_get_elaboration - Get elaboration status and rounds for an Idea
  server.registerTool(
    "chorus_get_elaboration",
    {
      description: "Get the full elaboration state for an Idea, including all rounds, questions, answers, and a summary of progress.",
      inputSchema: z.object({
        ideaUuid: z.string().describe("Idea UUID"),
      }),
    },
    async ({ ideaUuid }) => {
      try {
        const elaboration = await elaborationService.getElaboration({
          companyUuid: auth.companyUuid,
          ideaUuid,
        });

        return {
          content: [{ type: "text", text: JSON.stringify(elaboration, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed to get elaboration: ${error instanceof Error ? error.message : "Unknown error"}` }],
          isError: true,
        };
      }
    }
  );

  // ===== Project Group Tools =====

  // chorus_get_project_groups - List all project groups
  server.registerTool(
    "chorus_get_project_groups",
    collectionToolConfig({
      description: "List compact project-group summaries.",
      inputSchema: z.object({
        page: collectionPageSchema,
        pageSize: collectionPageSizeSchema,
      }),
    }),
    async ({ page = 1, pageSize = 20 }) => {
      const result = await projectGroupService.listProjectGroups(auth.companyUuid);
      const skip = (page - 1) * pageSize;
      return {
        content: [{
          type: "text",
          text: serializePage(
            "groups",
            result.groups.slice(skip, skip + pageSize),
            result.total,
            page,
            pageSize,
            ["uuid", "name", "projectCount", "createdAt", "updatedAt"],
            undefined,
            { ungroupedCount: result.ungroupedCount },
          ),
        }],
      };
    }
  );

  // chorus_get_project_group - Get a single project group by UUID
  server.registerTool(
    "chorus_get_project_group",
    {
      description: "Get a single project group by UUID with its projects list.",
      inputSchema: z.object({
        groupUuid: z.string().describe("Project Group UUID"),
      }),
    },
    async ({ groupUuid }) => {
      const group = await projectGroupService.getProjectGroup(auth.companyUuid, groupUuid);
      if (!group) {
        return { content: [{ type: "text", text: "Project group not found" }], isError: true };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(group, null, 2) }],
      };
    }
  );

  // chorus_get_group_dashboard - Get aggregated dashboard stats for a project group
  server.registerTool(
    "chorus_get_group_dashboard",
    collectionToolConfig({
      description: "Get aggregated dashboard stats for a project group (project count, tasks, completion rate, ideas, proposals, activity stream).",
      inputSchema: z.object({
        groupUuid: z.string().describe("Project Group UUID"),
      }),
    }),
    async ({ groupUuid }) => {
      const dashboard = await projectGroupService.getGroupDashboard(auth.companyUuid, groupUuid);
      if (!dashboard) {
        return { content: [{ type: "text", text: "Project group not found" }], isError: true };
      }
      return {
        content: [{ type: "text", text: serializeBoundedAggregate(dashboard) }],
      };
    }
  );

  // chorus_search_mentionables - Search for @mentionable users and agents
  server.registerTool(
    "chorus_search_mentionables",
    collectionToolConfig({
      description: "Search for users and agents that can be @mentioned. Returns name, type, and UUID. Use the UUID to write mentions as @[Name](type:uuid) in comment/description text. For results of type \"agent\" the entry also carries `online` (boolean: true iff the agent currently has a live daemon connection) and `activeCount` (number of tasks/resources its daemon is running or has queued; 0 when offline). User results do not carry these fields.",
      inputSchema: z.object({
        query: z.string().describe("Name or keyword to search"),
        limit: z.number().int().positive().max(100).optional().default(10).describe("Max results to return (default 10, maximum 100)"),
      }),
    }),
    async ({ query, limit }) => {
      const results = await mentionService.searchMentionables({
        companyUuid: auth.companyUuid,
        query,
        actorType: auth.type,
        actorUuid: auth.actorUuid,
        ownerUuid: auth.ownerUuid,
        limit,
      });
      return {
        content: [{
          type: "text",
          text: serializePage(
            "results",
            results.slice(0, limit),
            results.length,
            1,
            limit,
            ["uuid", "name", "type", "online", "activeCount"],
          ),
        }],
      };
    }
  );

  // chorus_search - Search across all entity types
  server.registerTool(
    "chorus_search",
    collectionToolConfig({
      description: "Search compact summaries across tasks, ideas, proposals, documents, projects, and project groups. A canonical UUID query performs tenant-scoped exact lookup first; text search is the fallback. Prefer this tool for discovery, use paginated list tools only for browsing, and call the entity's single-resource get tool for full details.",
      inputSchema: z.object({
        query: z.string().describe("Canonical entity UUID for exact lookup, or text matching title, description, and content"),
        scope: z.enum(["global", "group", "project"]).optional().default("global").describe("Search scope"),
        scopeUuid: z.string().optional().describe("Project group UUID (scope=group) or project UUID (scope=project)"),
        entityTypes: zArray(z.enum(["task", "idea", "proposal", "document", "project", "project_group"])).optional().describe("Entity types to search (default: all). Example: [\"task\", \"idea\"]"),
      }),
    }),
    async ({ query, scope, scopeUuid, entityTypes }) => {
      const result = await searchService.search({
        companyUuid: auth.companyUuid,
        query,
        scope,
        scopeUuid,
        entityTypes,
        limit: 50,
      });
      const rows = result.results.map((row) => ({
        ...compactCollectionRow(
          row,
          ["entityType", "uuid", "title", "status", "projectUuid", "projectName", "updatedAt"],
          ["title", "projectName"],
        ),
        snippet: truncatePreviewText(row.snippet),
      }));
      return {
        content: [{
          type: "text",
          text: serializeBoundedCollection({
            collectionKey: "results",
            rows,
            total: Object.values(result.counts).reduce((sum, count) => sum + count, 0),
            page: 1,
            pageSize: 50,
            extra: { counts: result.counts },
          }),
        }],
      };
    }
  );

  // ===== Task Creation & Editing Tools =====

  // chorus_create_tasks - Batch create tasks (migrated from pm.ts, available to all roles)
  server.registerTool(
    "chorus_create_tasks",
    {
      description:
        "Batch-create tasks in a project — either Quick Task mode (omit proposalUuid) or linked to an approved proposal (pass proposalUuid). Every task must include at least one acceptance criterion, or the whole batch is rejected.",
      inputSchema: z.object({
        projectUuid: z.string().describe("Project UUID"),
        proposalUuid: z.string().optional().describe("Associated Proposal UUID. Omit for Quick Task mode (bug fixes, small features, post-delivery patches; flow: create → claim → execute → verify → done); pass it to link to an approved proposal in the traditional AI-DLC flow. Intra-batch dependencies use draftUuid + dependsOnDraftUuids; dependencies on existing tasks use dependsOnTaskUuids."),
        tasks: zArray(z.object({
          title: z.string().describe("Task title"),
          description: z.string().optional().describe("Task description"),
          priority: z.enum(["low", "medium", "high"]).optional().describe("Priority"),
          storyPoints: z.number().optional().describe("Effort estimate (agent hours)"),
          acceptanceCriteriaItems: zArray(z.object({
            description: z.string().describe("Criterion description"),
            required: z.boolean().optional().describe("Whether this criterion is required (default: true)"),
          })).optional().describe("Structured acceptance criteria items — REQUIRED: at least one item with a non-blank description per task"),
          draftUuid: z.string().optional().describe("Temporary UUID for intra-batch dependsOnDraftUuids references"),
          dependsOnDraftUuids: zArray(z.string()).optional().describe("Dependent draftUuid list within this batch"),
          dependsOnTaskUuids: zArray(z.string()).optional().describe("Dependent existing Task UUID list"),
          references: zArray(referenceInlineItemSchema).optional().describe("Optional reference artifacts to attach to this task (fail-soft per item)"),
        })).describe("Task list"),
      }),
    },
    async ({ projectUuid, proposalUuid, tasks }) => {
      if (!(await projectExists(auth.companyUuid, projectUuid))) {
        return { content: [{ type: "text", text: "Project not found" }], isError: true };
      }

      if (proposalUuid) {
        const proposal = await proposalService.getProposalByUuid(auth.companyUuid, proposalUuid);
        if (!proposal) {
          return { content: [{ type: "text", text: "Proposal not found" }], isError: true };
        }
      }

      // Acceptance criteria are mandatory. Pre-validate every task BEFORE creating
      // any, so a single AC-less task rejects the whole batch (no half-created set).
      for (const task of tasks) {
        if (!hasNonEmptyAcceptanceCriteria(task.acceptanceCriteriaItems)) {
          return {
            content: [{ type: "text", text: `Task "${task.title}": ${ACCEPTANCE_CRITERIA_REQUIRED_MESSAGE}` }],
            isError: true,
          };
        }
      }

      const createdTasks = await Promise.all(
        tasks.map(task =>
          taskService.createTask({
            companyUuid: auth.companyUuid,
            projectUuid,
            title: task.title,
            description: task.description || null,
            priority: task.priority,
            storyPoints: task.storyPoints ?? null,
            proposalUuid: proposalUuid || null,
            createdByUuid: auth.actorUuid,
          })
        )
      );

      const draftToTaskUuidMap: Record<string, string> = {};
      for (let i = 0; i < tasks.length; i++) {
        if (tasks[i].draftUuid) {
          draftToTaskUuidMap[tasks[i].draftUuid!] = createdTasks[i].uuid;
        }
      }

      const warnings: string[] = [];
      const referenceErrors: Array<Record<string, unknown>> = [];
      for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];
        const realUuid = createdTasks[i].uuid;

        if (task.dependsOnDraftUuids) {
          for (const draftUuid of task.dependsOnDraftUuids) {
            const depRealUuid = draftToTaskUuidMap[draftUuid];
            if (!depRealUuid) {
              warnings.push(`Task "${task.title}": draftUuid "${draftUuid}" not found in this batch`);
              continue;
            }
            try {
              await taskService.addTaskDependency(auth.companyUuid, realUuid, depRealUuid);
            } catch (error) {
              warnings.push(`Task "${task.title}" -> draftUuid "${draftUuid}": ${error instanceof Error ? error.message : "unknown error"}`);
            }
          }
        }

        if (task.dependsOnTaskUuids) {
          for (const depUuid of task.dependsOnTaskUuids) {
            try {
              await taskService.addTaskDependency(auth.companyUuid, realUuid, depUuid);
            } catch (error) {
              warnings.push(`Task "${task.title}" -> taskUuid "${depUuid}": ${error instanceof Error ? error.message : "unknown error"}`);
            }
          }
        }

        // AC presence was pre-validated above; normalize and persist via the service layer.
        const acItems = normalizeAcceptanceCriteria(task.acceptanceCriteriaItems);
        try {
          await taskService.createAcceptanceCriteria(realUuid, acItems);
        } catch (error) {
          warnings.push(`Task "${task.title}": failed to create acceptance criteria: ${error instanceof Error ? error.message : "unknown error"}`);
        }

        // Inline references (Thread C): attach AFTER the task row exists so
        // targetUuid is the real DB-generated uuid — same post-insert sequencing
        // as deps/AC above. Fail-soft — a bad ref is reported in referenceErrors,
        // never aborts task creation.
        if (task.references && task.references.length > 0) {
          const refResult = await referenceArtifactService.createReferences(
            auth.companyUuid,
            "task",
            realUuid,
            task.references,
            { type: "agent", uuid: auth.actorUuid }
          );
          for (const err of refResult.errors) {
            referenceErrors.push({ task: task.title, ...err });
          }
        }
      }

      // Log activity for each created task
      for (const created of createdTasks) {
        await activityService.createActivity({
          companyUuid: auth.companyUuid,
          projectUuid,
          targetType: "task",
          targetUuid: created.uuid,
          actorType: "agent",
          actorUuid: auth.actorUuid,
          action: "created",
          value: { title: created.title, ...(proposalUuid ? { proposalUuid } : { quickTask: true }) },
        });
      }

      const result: {
        tasks: { uuid: string; title: string }[];
        warnings?: string[];
        referenceErrors?: Array<Record<string, unknown>>;
      } = { tasks: createdTasks.map(t => ({ uuid: t.uuid, title: t.title })) };

      if (warnings.length > 0) {
        result.warnings = warnings;
      }

      if (referenceErrors.length > 0) {
        result.referenceErrors = referenceErrors;
      }

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // chorus_update_task - Full-featured task editing tool (migrated from developer.ts, enhanced)
  server.registerTool(
    "chorus_update_task",
    {
      description:
        "Update a task: edit fields (title, description, priority, storyPoints), manage dependencies, replace acceptance criteria, or change status. Field/AC/dependency edits are open to any role; status changes are assignee-only.",
      inputSchema: z.object({
        taskUuid: z.string().describe("Task UUID"),
        status: z.enum(["in_progress", "to_verify"]).optional().describe("New status (assignee only). `in_progress` requires all dependencies resolved; `to_verify` submits for verification."),
        sessionUuid: z.string().optional().describe("Session UUID for sub-agent identification"),
        title: z.string().optional().describe("New task title"),
        description: z.string().optional().describe("New task description (supports @mentions)"),
        priority: z.enum(["low", "medium", "high"]).optional().describe("New priority"),
        storyPoints: z.number().optional().describe("New effort estimate (agent hours)"),
        acceptanceCriteriaItems: zArray(z.object({
          description: z.string().describe("Criterion description"),
          required: z.boolean().optional().describe("Whether this criterion is required (default: true)"),
        })).optional().describe("Replace the task's acceptance criteria with this non-empty set. Omit to leave AC unchanged; cannot be used to clear AC (empty/all-blank is rejected). Replacing discards any prior dev/admin verification marks on the old criteria."),
        addDependsOn: zArray(z.string()).optional().describe("Task UUIDs to add as dependencies (incremental)"),
        removeDependsOn: zArray(z.string()).optional().describe("Task UUIDs to remove from dependencies (incremental)"),
      }),
    },
    async ({ taskUuid, status, sessionUuid, title, description, priority, storyPoints, acceptanceCriteriaItems, addDependsOn, removeDependsOn }) => {
      const task = await taskService.getTaskByUuid(auth.companyUuid, taskUuid);
      if (!task) {
        return { content: [{ type: "text", text: "Task not found" }], isError: true };
      }

      // If acceptance criteria are supplied, they must be non-empty — the field
      // replaces existing AC and cannot be used to clear them. Validate before
      // any mutation so a bad AC payload rejects the whole call cleanly.
      if (acceptanceCriteriaItems !== undefined && !hasNonEmptyAcceptanceCriteria(acceptanceCriteriaItems)) {
        return {
          content: [{ type: "text", text: ACCEPTANCE_CRITERIA_REQUIRED_MESSAGE }],
          isError: true,
        };
      }

      // Status update requires assignee check. The shared helper also passes an
      // `agent_instance` assignment owned by this agent.
      if (status) {
        const isAssignee = await isAssignmentOwnedByActor(auth, task.assigneeType, task.assigneeUuid);

        if (!isAssignee) {
          return { content: [{ type: "text", text: "Only the assignee can update task status" }], isError: true };
        }

        if (!taskService.isValidTaskStatusTransition(task.status, status)) {
          return {
            content: [{ type: "text", text: `Invalid status transition: ${task.status} -> ${status}` }],
            isError: true,
          };
        }

        if (status === "in_progress") {
          const depCheck = await taskService.checkDependenciesResolved(task.uuid);
          if (!depCheck.resolved) {
            const blockerLines = depCheck.blockers.map((b, i) => {
              const assigneeStr = b.assignee
                ? `${b.assignee.name} [${b.assignee.type}]`
                : "none";
              const sessionStr = b.sessionCheckin
                ? `session: ${b.sessionCheckin.sessionName}`
                : "no active session";
              return `${i + 1}. "${b.title}" (status: ${b.status}, assignee: ${assigneeStr}, ${sessionStr})`;
            });
            const msg = [
              `Cannot move to in_progress: ${depCheck.blockers.length} dependencies not resolved.`,
              "",
              "Blockers:",
              ...blockerLines,
              "",
              "Tip: Use chorus_get_unblocked_tasks to find tasks you can start now.",
            ].join("\n");
            return { content: [{ type: "text", text: msg }], isError: true };
          }
        }
      }

      // Resolve session info
      let sessionName: string | undefined;
      if (sessionUuid) {
        const session = await sessionService.getSession(auth.companyUuid, sessionUuid);
        if (session && session.agentUuid === auth.actorUuid) {
          sessionName = session.name;
          await sessionService.heartbeatSession(auth.companyUuid, sessionUuid);
        }
      }

      // Build update data for taskService.updateTask
      const updateData: taskService.TaskUpdateParams = {};
      if (status) updateData.status = status;
      if (title !== undefined) updateData.title = title;
      if (description !== undefined) updateData.description = description;
      if (priority !== undefined) updateData.priority = priority;
      if (storyPoints !== undefined) updateData.storyPoints = storyPoints;

      const hasFieldUpdates = title !== undefined || description !== undefined || priority !== undefined || storyPoints !== undefined || status !== undefined;

      let updatedStatus = task.status;
      if (hasFieldUpdates) {
        const updated = await taskService.updateTask(task.uuid, updateData, {
          actorType: auth.type,
          actorUuid: auth.actorUuid,
        });
        updatedStatus = updated.status;
      }

      const warnings: string[] = [];

      // Add dependencies
      if (addDependsOn) {
        for (const depUuid of addDependsOn) {
          try {
            await taskService.addTaskDependency(auth.companyUuid, task.uuid, depUuid);
          } catch (error) {
            warnings.push(`addDependsOn "${depUuid}": ${error instanceof Error ? error.message : "unknown error"}`);
          }
        }
      }

      // Remove dependencies
      if (removeDependsOn) {
        for (const depUuid of removeDependsOn) {
          try {
            await taskService.removeTaskDependency(auth.companyUuid, task.uuid, depUuid);
          } catch (error) {
            warnings.push(`removeDependsOn "${depUuid}": ${error instanceof Error ? error.message : "unknown error"}`);
          }
        }
      }

      // Replace acceptance criteria (validated non-empty above). The service
      // performs the delete + recreate atomically so a partial failure can't
      // leave the task with zero criteria; replacing discards prior dev/admin
      // verification marks, which is correct since the AC changed.
      let acReplaced = false;
      if (acceptanceCriteriaItems !== undefined) {
        await taskService.replaceAcceptanceCriteria(auth.companyUuid, task.uuid, acceptanceCriteriaItems);
        acReplaced = true;
      }

      // Log activity — merge all changes into a single record
      const activityValue: Record<string, unknown> = {};
      if (status) activityValue.status = status;
      if (title !== undefined) activityValue.title = title;
      if (description !== undefined) activityValue.descriptionUpdated = true;
      if (priority !== undefined) activityValue.priority = priority;
      if (storyPoints !== undefined) activityValue.storyPoints = storyPoints;
      if (acReplaced) activityValue.acceptanceCriteriaReplaced = true;
      if (addDependsOn) activityValue.addedDependencies = addDependsOn.length;
      if (removeDependsOn) activityValue.removedDependencies = removeDependsOn.length;

      const hasAnyChange = status || hasFieldUpdates || acReplaced || addDependsOn || removeDependsOn;
      if (hasAnyChange) {
        await activityService.createActivity({
          companyUuid: auth.companyUuid,
          projectUuid: task.projectUuid,
          targetType: "task",
          targetUuid: task.uuid,
          actorType: "agent",
          actorUuid: auth.actorUuid,
          action: status ? "status_changed" : "updated",
          value: activityValue,
          sessionUuid,
          sessionName,
        });
      }

      const result: Record<string, unknown> = { uuid: task.uuid, status: updatedStatus };
      if (warnings.length > 0) result.warnings = warnings;

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // chorus_create_report - Author an idea-completion summary Document.
  //
  // Public-namespaced (no pm_ prefix) but gated on document:write — see
  // add-idea-completion-report Tech Design §"MCP tool contract" and
  // spec delta `mcp-tool-surface`. The tool name encodes type="report"; the
  // service writes that label unconditionally so agents cannot mislabel reports.
  // The body is preserved byte-faithfully (modulo the Document.content write
  // path's existing trailing-newline normalization).
  registerPermissionedTool(
    server,
    auth,
    "document:write",
    "chorus_create_report",
    {
      description:
        "Persist an idea-completion summary as a Document (type=\"report\") under the given Proposal, once every Task in the Proposal is complete. Keep it short — a summary, not a write-up.",
      inputSchema: z.object({
        proposalUuid: z.string().uuid().describe("Proposal UUID whose tasks have all reached a terminal state"),
        title: z.string().min(1).max(200).describe("Report title (e.g. 'Idea X — completion report')"),
        content: z.string().min(1).describe(
          "Markdown body. MUST use these three top-level headers verbatim, in this order:\n" +
          "## Summary — 1-3 sentences on what shipped (plain prose, no bullets).\n" +
          "## Decisions — terse bullets: the key calls made during elaboration / proposal review and why this option not the alternative; skip trivial ones.\n" +
          "## Follow-ups — what's still open (link a new Idea / blog / doc-update if tracked elsewhere); write \"None\" if there are none.\n" +
          "Section bodies are free-form Markdown (links and inline code fine); the three headers are the contract."
        ),
        force: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Default false. When false, calls against a proposal that already has a report return an error and create nothing. Set force true only to deliberately add another report to the same proposal."
          ),
      }),
    },
    async ({ proposalUuid, title, content, force }) => {
      const proposal = await proposalService.getProposalByUuid(auth.companyUuid, proposalUuid);
      if (!proposal) {
        return { content: [{ type: "text", text: "Proposal not found" }], isError: true };
      }

      if (proposal.status !== "approved") {
        return {
          content: [{ type: "text", text: `Proposal status must be 'approved' to author a completion report (got '${proposal.status}')` }],
          isError: true,
        };
      }

      // Duplicate-report gate. By default a proposal carries at most one
      // type="report" Document — see spec `create-report-force`. Callers that
      // genuinely want a second report (re-author after a redo, separate-audience
      // cut) opt in via force=true.
      if (force !== true) {
        const existingReports = await documentService.listDocumentsByProposalUuids(
          auth.companyUuid,
          [proposalUuid],
          "report"
        );
        if (existingReports.length > 0) {
          return {
            content: [
              {
                type: "text",
                text: "A report already exists for this proposal. Pass force=true to add another report to the same proposal.",
              },
            ],
            isError: true,
          };
        }
      }

      const document = await documentService.createDocument({
        companyUuid: auth.companyUuid,
        projectUuid: proposal.projectUuid,
        type: "report",
        title,
        content,
        proposalUuid,
        createdByUuid: auth.actorUuid,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                documentUuid: document.uuid,
                projectUuid: proposal.projectUuid,
                version: document.version,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
