// src/mcp/tools/public.ts
// Public MCP tools - available to all Agents (ARCHITECTURE.md §5.2)
// UUID-Based Architecture: All operations use UUIDs

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AgentAuthContext } from "@/types/auth";
import * as projectService from "@/services/project.service";
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
        proposalUuids: z.array(z.string()).optional().describe("Filter tasks by proposal UUIDs"),
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
      description: "Agent check-in. Returns agent identity (including owner/master info), roles, assigned work, and pending counts. Recommended at session start.",
      inputSchema: z.object({}),
    },
    async () => {
      // Update last active time and get Agent info (query by UUID)
      const agent = await prisma.agent.update({
        where: { uuid: auth.actorUuid },
        data: { lastActiveAt: new Date() },
        select: {
          uuid: true,
          name: true,
          roles: true,
          persona: true,
          systemPrompt: true,
          ownerUuid: true,
          owner: { select: { uuid: true, name: true, email: true } },
        },
      });

      // Get pending Ideas and Tasks
      const { ideas, tasks } = await assignmentService.getMyAssignments(auth, auth.projectUuids);

      // Get unread notification count
      const unreadNotificationCount = await notificationService.getUnreadCount(
        auth.companyUuid,
        auth.type,
        auth.actorUuid
      );

      // Build default persona (if no custom persona is set)
      const defaultPersonas: Record<string, string> = {
        pm: `你是一个经验丰富的产品经理 Agent。你的职责是：
- 分析用户需求，提炼核心问题
- 将模糊的想法转化为清晰的 PRD
- 合理拆分任务，估算工作量（以 Agent 小时为单位）
- 识别风险和依赖关系
- 与团队保持沟通，推动项目进展

工作风格：务实、注重细节、善于沟通`,
        developer: `你是一个专业的开发者 Agent。你的职责是：
- 理解任务需求，编写高质量代码
- 遵循项目的代码规范和架构约定
- 完成任务后及时报告进度
- 遇到问题主动沟通，不做假设

工作风格：严谨、高效、注重代码质量`,
      };

      // Determine the effective persona
      let effectivePersona = agent.persona;
      if (!effectivePersona && agent.roles.length > 0) {
        effectivePersona = defaultPersonas[agent.roles[0]] || null;
      }

      const result = {
        checkinTime: new Date().toISOString(),
        agent: {
          uuid: agent.uuid,
          name: agent.name,
          roles: agent.roles,
          persona: effectivePersona,
          systemPrompt: agent.systemPrompt,
          owner: agent.owner ? { uuid: agent.owner.uuid, name: agent.owner.name, email: agent.owner.email } : null,
        },
        assignments: {
          ideas: ideas.filter(i => ["assigned", "in_progress"].includes(i.status)),
          tasks: tasks.filter(t => ["assigned", "in_progress"].includes(t.status)),
        },
        pending: {
          ideasCount: ideas.length,
          tasksCount: tasks.length,
        },
        notifications: {
          unreadCount: unreadNotificationCount,
        },
      };

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
        proposalUuids: z.array(z.string()).optional().describe("Filter tasks by proposal UUIDs"),
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
        proposalUuids: z.array(z.string()).optional().describe("Filter tasks by proposal UUIDs"),
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
}
