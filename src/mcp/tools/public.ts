// src/mcp/tools/public.ts
// Public MCP tools - available to all Agents (ARCHITECTURE.md §5.2)
// UUID-Based Architecture: All operations use UUIDs

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AgentAuthContext } from "@/types/auth";
import * as projectService from "@/services/project.service";
import { projectExists } from "@/services/project.service";
import * as ideaService from "@/services/idea.service";
import * as documentService from "@/services/document.service";
import * as taskService from "@/services/task.service";
import * as proposalService from "@/services/proposal.service";
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
import { prisma } from "@/lib/prisma";

export function registerPublicTools(server: McpServer, auth: AgentAuthContext) {
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
    {
      description: "List all projects for the current company. Returns projects with counts of ideas, documents, tasks, and proposals.",
      inputSchema: z.object({
        page: z.number().default(1).describe("Page number"),
        pageSize: z.number().default(20).describe("Items per page"),
      }),
    },
    async ({ page, pageSize }) => {
      const skip = (page - 1) * pageSize;
      const result = await projectService.listProjects({
        companyUuid: auth.companyUuid,
        skip,
        take: pageSize,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // chorus_get_ideas - Get Ideas list
  server.registerTool(
    "chorus_get_ideas",
    {
      description: "Get the list of Ideas for a project",
      inputSchema: z.object({
        projectUuid: z.string().describe("Project UUID"),
        status: z.string().optional().describe("Filter by status: open, elaborating, proposal_created, completed, closed"),
        page: z.number().optional().default(1).describe("Page number"),
        pageSize: z.number().optional().default(20).describe("Items per page"),
      }),
    },
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
        content: [{ type: "text", text: JSON.stringify({ ideas, total, page, pageSize }, null, 2) }],
      };
    }
  );

  // chorus_get_documents - Get Documents list
  server.registerTool(
    "chorus_get_documents",
    {
      description: "Get the list of Documents for a project",
      inputSchema: z.object({
        projectUuid: z.string().describe("Project UUID"),
        type: z.string().optional().describe("Filter by type: prd, tech_design, adr, etc."),
        page: z.number().optional().default(1),
        pageSize: z.number().optional().default(20),
      }),
    },
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
        content: [{ type: "text", text: JSON.stringify({ documents, total, page, pageSize }, null, 2) }],
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
    {
      description: "Get the list of Proposals and their statuses for a project",
      inputSchema: z.object({
        projectUuid: z.string().describe("Project UUID"),
        status: z.string().optional().describe("Filter by status: pending, approved, rejected, revised"),
        page: z.number().optional().default(1),
        pageSize: z.number().optional().default(20),
      }),
    },
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
        content: [{ type: "text", text: JSON.stringify({ proposals, total, page, pageSize }, null, 2) }],
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
      return {
        content: [{ type: "text", text: JSON.stringify(task, null, 2) }],
      };
    }
  );

  // chorus_list_tasks - List Tasks
  server.registerTool(
    "chorus_list_tasks",
    {
      description: "List Tasks for a project",
      inputSchema: z.object({
        projectUuid: z.string().describe("Project UUID"),
        status: z.string().optional().describe("Filter by status: open, assigned, in_progress, to_verify, done, closed"),
        priority: z.string().optional().describe("Filter by priority: low, medium, high"),
        proposalUuids: zArray(z.string()).optional().describe("Filter tasks by proposal UUIDs"),
        page: z.number().optional().default(1),
        pageSize: z.number().optional().default(20),
      }),
    },
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
        content: [{ type: "text", text: JSON.stringify({ tasks, total, page, pageSize }, null, 2) }],
      };
    }
  );

  // chorus_get_activity - Get project activity stream
  server.registerTool(
    "chorus_get_activity",
    {
      description: "Get the activity stream for a project",
      inputSchema: z.object({
        projectUuid: z.string().describe("Project UUID"),
        page: z.number().optional().default(1),
        pageSize: z.number().optional().default(50),
      }),
    },
    async ({ projectUuid, page = 1, pageSize = 50 }) => {
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
        content: [{ type: "text", text: JSON.stringify({ activities, total, page, pageSize }, null, 2) }],
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
    {
      description:
        "Agent check-in. Returns agent identity (owner, roles, persona), a project-grouped idea tracker with derived statuses and proposal/task counts, and up to 5 recent unread notifications (auto-marked read). Recommended at session start.",
      inputSchema: z.object({}),
    },
    async () => {
      const result = await checkinService.buildCheckinResponse(auth);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // chorus_get_my_assignments - Get own claimed Ideas + Tasks
  server.registerTool(
    "chorus_get_my_assignments",
    {
      description: "Get all Ideas and Tasks claimed by the current Agent",
      inputSchema: z.object({}),
    },
    async () => {
      const { ideas, tasks } = await assignmentService.getMyAssignments(auth, auth.projectUuids);

      return {
        content: [{ type: "text", text: JSON.stringify({ ideas, tasks }, null, 2) }],
      };
    }
  );

  // chorus_get_available_ideas - Get claimable Ideas
  server.registerTool(
    "chorus_get_available_ideas",
    {
      description: "Get Ideas available to claim in a project (status=open)",
      inputSchema: z.object({
        projectUuid: z.string().describe("Project UUID"),
      }),
    },
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
        content: [{ type: "text", text: JSON.stringify({ ideas }, null, 2) }],
      };
    }
  );

  // chorus_get_available_tasks - Get claimable Tasks
  server.registerTool(
    "chorus_get_available_tasks",
    {
      description: "Get Tasks available to claim in a project (status=open)",
      inputSchema: z.object({
        projectUuid: z.string().describe("Project UUID"),
        proposalUuids: zArray(z.string()).optional().describe("Filter tasks by proposal UUIDs"),
      }),
    },
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
        content: [{ type: "text", text: JSON.stringify({ tasks }, null, 2) }],
      };
    }
  );

  // chorus_get_idea - Get single Idea details
  server.registerTool(
    "chorus_get_idea",
    {
      description: "Get detailed information for a single Idea",
      inputSchema: z.object({
        ideaUuid: z.string().describe("Idea UUID"),
      }),
    },
    async ({ ideaUuid }) => {
      const idea = await ideaService.getIdea(auth.companyUuid, ideaUuid);
      if (!idea) {
        return { content: [{ type: "text", text: "Idea not found" }], isError: true };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(idea, null, 2) }],
      };
    }
  );

  // chorus_get_proposal - Get single Proposal details (including drafts)
  server.registerTool(
    "chorus_get_proposal",
    {
      description: "Get detailed information for a single Proposal, including document drafts and task drafts",
      inputSchema: z.object({
        proposalUuid: z.string().describe("Proposal UUID"),
      }),
    },
    async ({ proposalUuid }) => {
      // Use getProposal to return the full formatted response, including drafts
      const proposal = await proposalService.getProposal(auth.companyUuid, proposalUuid);
      if (!proposal) {
        return { content: [{ type: "text", text: "Proposal not found" }], isError: true };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(proposal, null, 2) }],
      };
    }
  );

  // chorus_get_unblocked_tasks - Get unblocked tasks (all dependencies resolved)
  server.registerTool(
    "chorus_get_unblocked_tasks",
    {
      description: "Get tasks that are ready to start — status is open/assigned and all dependencies are resolved (done/to_verify). Useful for discovering what work can begin next after a task completes.",
      inputSchema: z.object({
        projectUuid: z.string().describe("Project UUID"),
        proposalUuids: zArray(z.string()).optional().describe("Filter tasks by proposal UUIDs"),
      }),
    },
    async ({ projectUuid, proposalUuids }) => {
      // Verify project exists
      const project = await projectService.getProjectByUuid(auth.companyUuid, projectUuid);
      if (!project) {
        return { content: [{ type: "text", text: "Project not found" }], isError: true };
      }

      const { tasks, total } = await taskService.getUnblockedTasks({
        companyUuid: auth.companyUuid,
        projectUuid,
        proposalUuids,
      });

      return {
        content: [{ type: "text", text: JSON.stringify({ tasks, total }, null, 2) }],
      };
    }
  );

  // chorus_get_comments - Get comments list
  server.registerTool(
    "chorus_get_comments",
    {
      description: "Get the list of comments for an Idea/Proposal/Task/Document",
      inputSchema: z.object({
        targetType: z.enum(["idea", "proposal", "task", "document"]).describe("Target type"),
        targetUuid: z.string().describe("Target UUID"),
        page: z.number().optional().default(1).describe("Page number"),
        pageSize: z.number().optional().default(20).describe("Items per page"),
      }),
    },
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
        content: [{ type: "text", text: JSON.stringify({ comments, total, page, pageSize }, null, 2) }],
      };
    }
  );

  // chorus_get_notifications - Get notifications for the current Agent
  server.registerTool(
    "chorus_get_notifications",
    {
      description: "Get the list of notifications for the current Agent. By default, fetching unread notifications automatically marks them as read. Set autoMarkRead=false to keep them unread.",
      inputSchema: z.object({
        status: z.enum(["unread", "read", "all"]).default("unread").optional().describe("Filter by status"),
        limit: z.number().default(20).optional().describe("Items per page"),
        offset: z.number().default(0).optional().describe("Offset"),
        autoMarkRead: z.boolean().default(true).optional().describe("Automatically mark fetched unread notifications as read (default: true)"),
      }),
    },
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

      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
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
      description: "Answer elaboration questions for an Idea. Submits answers for a specific elaboration round. When all required questions are answered, the round moves to validation. Also use this to record decisions made outside the formal elaboration flow — if the user clarified requirements in conversation, capture those decisions here as answers so they are persisted to the Idea as an audit trail.",
      inputSchema: z.object({
        ideaUuid: z.string().describe("Idea UUID"),
        roundUuid: z.string().describe("Elaboration round UUID"),
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
    {
      description: "List all project groups for the current company. Returns groups with project counts.",
      inputSchema: z.object({}),
    },
    async () => {
      const result = await projectGroupService.listProjectGroups(auth.companyUuid);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
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
    {
      description: "Get aggregated dashboard stats for a project group (project count, tasks, completion rate, ideas, proposals, activity stream).",
      inputSchema: z.object({
        groupUuid: z.string().describe("Project Group UUID"),
      }),
    },
    async ({ groupUuid }) => {
      const dashboard = await projectGroupService.getGroupDashboard(auth.companyUuid, groupUuid);
      if (!dashboard) {
        return { content: [{ type: "text", text: "Project group not found" }], isError: true };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(dashboard, null, 2) }],
      };
    }
  );

  // chorus_search_mentionables - Search for @mentionable users and agents
  server.registerTool(
    "chorus_search_mentionables",
    {
      description: "Search for users and agents that can be @mentioned. Returns name, type, and UUID. Use the UUID to write mentions as @[Name](type:uuid) in comment/description text.",
      inputSchema: z.object({
        query: z.string().describe("Name or keyword to search"),
        limit: z.number().optional().default(10).describe("Max results to return (default 10)"),
      }),
    },
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
        content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
      };
    }
  );

  // chorus_search - Search across all entity types
  server.registerTool(
    "chorus_search",
    {
      description: "Search across tasks, ideas, proposals, documents, projects, and project groups. Supports scoping to project groups or specific projects.",
      inputSchema: z.object({
        query: z.string().describe("Search query (matches title, description, content)"),
        scope: z.enum(["global", "group", "project"]).optional().default("global").describe("Search scope"),
        scopeUuid: z.string().optional().describe("Project group UUID (scope=group) or project UUID (scope=project)"),
        entityTypes: zArray(z.enum(["task", "idea", "proposal", "document", "project", "project_group"])).optional().describe("Entity types to search (default: all). Example: [\"task\", \"idea\"]"),
      }),
    },
    async ({ query, scope, scopeUuid, entityTypes }) => {
      const result = await searchService.search({
        companyUuid: auth.companyUuid,
        query,
        scope,
        scopeUuid,
        entityTypes,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // ===== Task Creation & Editing Tools =====

  // chorus_create_tasks - Batch create tasks (migrated from pm.ts, available to all roles)
  server.registerTool(
    "chorus_create_tasks",
    {
      description:
        "Batch create tasks in a project. Two modes:\n\n" +
        "**Quick Task** (skip Idea→Proposal): omit proposalUuid. Ideal for bug fixes, small features, post-delivery patches. Flow: create → claim → execute → verify → done.\n\n" +
        "**Proposal-linked** (traditional AI-DLC): pass proposalUuid to associate with an approved proposal.\n\n" +
        "Supports batch creation with intra-batch dependencies (draftUuid + dependsOnDraftUuids) and dependencies on existing tasks (dependsOnTaskUuids).",
      inputSchema: z.object({
        projectUuid: z.string().describe("Project UUID"),
        proposalUuid: z.string().optional().describe("Associated Proposal UUID (optional — omit for Quick Task mode)"),
        tasks: zArray(z.object({
          title: z.string().describe("Task title"),
          description: z.string().optional().describe("Task description"),
          priority: z.enum(["low", "medium", "high"]).optional().describe("Priority"),
          storyPoints: z.number().optional().describe("Effort estimate (agent hours)"),
          acceptanceCriteriaItems: zArray(z.object({
            description: z.string().describe("Criterion description"),
            required: z.boolean().optional().describe("Whether this criterion is required (default: true)"),
          })).optional().describe("Structured acceptance criteria items"),
          draftUuid: z.string().optional().describe("Temporary UUID for intra-batch dependsOnDraftUuids references"),
          dependsOnDraftUuids: zArray(z.string()).optional().describe("Dependent draftUuid list within this batch"),
          dependsOnTaskUuids: zArray(z.string()).optional().describe("Dependent existing Task UUID list"),
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

        if (task.acceptanceCriteriaItems && task.acceptanceCriteriaItems.length > 0) {
          const validItems = task.acceptanceCriteriaItems.filter(
            (item) => item.description && item.description.trim().length > 0
          );
          if (validItems.length > 0) {
            try {
              await prisma.acceptanceCriterion.createMany({
                data: validItems.map((item, index) => ({
                  taskUuid: realUuid,
                  description: item.description.trim(),
                  required: item.required ?? true,
                  sortOrder: index,
                })),
              });
            } catch (error) {
              warnings.push(`Task "${task.title}": failed to create acceptance criteria: ${error instanceof Error ? error.message : "unknown error"}`);
            }
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
      } = { tasks: createdTasks.map(t => ({ uuid: t.uuid, title: t.title })) };

      if (warnings.length > 0) {
        result.warnings = warnings;
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
        "Update a task — edit fields, manage dependencies, or change status.\n\n" +
        "**Field editing** (any role): title, description, priority, storyPoints, addDependsOn/removeDependsOn (incremental dependency management).\n\n" +
        "**Status update** (assignee only): in_progress (requires all dependencies resolved), to_verify.\n\n" +
        "For Quick Tasks: create → claim → edit details → execute → verify → done.",
      inputSchema: z.object({
        taskUuid: z.string().describe("Task UUID"),
        status: z.enum(["in_progress", "to_verify"]).optional().describe("New status (assignee only)"),
        sessionUuid: z.string().optional().describe("Session UUID for sub-agent identification"),
        title: z.string().optional().describe("New task title"),
        description: z.string().optional().describe("New task description (supports @mentions)"),
        priority: z.enum(["low", "medium", "high"]).optional().describe("New priority"),
        storyPoints: z.number().optional().describe("New effort estimate (agent hours)"),
        addDependsOn: zArray(z.string()).optional().describe("Task UUIDs to add as dependencies"),
        removeDependsOn: zArray(z.string()).optional().describe("Task UUIDs to remove from dependencies"),
      }),
    },
    async ({ taskUuid, status, sessionUuid, title, description, priority, storyPoints, addDependsOn, removeDependsOn }) => {
      const task = await taskService.getTaskByUuid(auth.companyUuid, taskUuid);
      if (!task) {
        return { content: [{ type: "text", text: "Task not found" }], isError: true };
      }

      // Status update requires assignee check
      if (status) {
        const isAssignee =
          (task.assigneeType === "agent" && task.assigneeUuid === auth.actorUuid) ||
          (task.assigneeType === "user" && auth.ownerUuid && task.assigneeUuid === auth.ownerUuid);

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

      // Log activity — merge all changes into a single record
      const activityValue: Record<string, unknown> = {};
      if (status) activityValue.status = status;
      if (title !== undefined) activityValue.title = title;
      if (description !== undefined) activityValue.descriptionUpdated = true;
      if (priority !== undefined) activityValue.priority = priority;
      if (storyPoints !== undefined) activityValue.storyPoints = storyPoints;
      if (addDependsOn) activityValue.addedDependencies = addDependsOn.length;
      if (removeDependsOn) activityValue.removedDependencies = removeDependsOn.length;

      const hasAnyChange = status || hasFieldUpdates || addDependsOn || removeDependsOn;
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
}
