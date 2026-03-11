// src/mcp/tools/admin.ts
// Admin Agent exclusive MCP tools (ARCHITECTURE.md S5.2)
// Admin Agent acts on behalf of humans for approvals, verification, and project management
// UUID-Based Architecture: All operations use UUIDs

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AgentAuthContext } from "@/types/auth";
import * as projectService from "@/services/project.service";
import * as proposalService from "@/services/proposal.service";
import * as taskService from "@/services/task.service";
import * as ideaService from "@/services/idea.service";
import * as documentService from "@/services/document.service";
import * as activityService from "@/services/activity.service";
import * as projectGroupService from "@/services/project-group.service";

export function registerAdminTools(server: McpServer, auth: AgentAuthContext) {
  // chorus_admin_create_project - Create a new project
  server.registerTool(
    "chorus_admin_create_project",
    {
      description: "Create a new project (Admin exclusive, acts on behalf of humans). To assign to a project group, first call chorus_get_project_groups to list available groups, then pass the groupUuid.",
      inputSchema: z.object({
        name: z.string().describe("Project name"),
        description: z.string().optional().describe("Project description"),
        groupUuid: z.string().optional().describe("Optional project group UUID to assign this project to. Use chorus_get_project_groups to list available groups."),
      }),
    },
    async ({ name, description, groupUuid }) => {
      const project = await projectService.createProject({
        companyUuid: auth.companyUuid,
        name,
        description: description || null,
        groupUuid: groupUuid || null,
      });

      return {
        content: [{ type: "text", text: JSON.stringify({ uuid: project.uuid, name: project.name, groupUuid: project.groupUuid }) }],
      };
    }
  );

  // chorus_admin_create_idea moved to pm.ts as chorus_pm_create_idea

  // chorus_admin_approve_proposal - Approve a Proposal
  server.registerTool(
    "chorus_admin_approve_proposal",
    {
      description: "Approve a Proposal (Admin exclusive, acts on behalf of humans). On approval, documentDrafts and taskDrafts in the Proposal are automatically materialized into real Document and Task entities -- no need to manually call create_document/create_tasks.",
      inputSchema: z.object({
        proposalUuid: z.string().describe("Proposal UUID"),
        reviewNote: z.string().optional().describe("Review note"),
      }),
    },
    async ({ proposalUuid, reviewNote }) => {
      const proposal = await proposalService.getProposalByUuid(auth.companyUuid, proposalUuid);
      if (!proposal) {
        return { content: [{ type: "text", text: "Proposal not found" }], isError: true };
      }

      if (proposal.status !== "pending") {
        return { content: [{ type: "text", text: `Can only approve pending Proposals, current status: ${proposal.status}` }], isError: true };
      }

      const updated = await proposalService.approveProposal(
        proposalUuid,
        auth.companyUuid,
        auth.actorUuid,  // Admin Agent as reviewer
        reviewNote || null
      );

      await activityService.createActivity({
        companyUuid: auth.companyUuid,
        projectUuid: proposal.projectUuid,
        targetType: "proposal",
        targetUuid: proposalUuid,
        actorType: "agent",
        actorUuid: auth.actorUuid,
        action: "approved",
        value: reviewNote ? { reviewNote } : undefined,
      });

      return {
        content: [{ type: "text", text: JSON.stringify({ uuid: updated.uuid, status: updated.status }) }],
      };
    }
  );

  // chorus_admin_reject_proposal - Reject a Proposal (returns to draft for re-editing)
  server.registerTool(
    "chorus_admin_reject_proposal",
    {
      description: "Reject a Proposal (Admin exclusive, acts on behalf of humans). After rejection, the Proposal returns to draft status and can be re-edited and resubmitted. The reviewNote is preserved as reference for revisions.",
      inputSchema: z.object({
        proposalUuid: z.string().describe("Proposal UUID"),
        reviewNote: z.string().describe("Rejection reason (required, serves as revision reference)"),
      }),
    },
    async ({ proposalUuid, reviewNote }) => {
      const proposal = await proposalService.getProposalByUuid(auth.companyUuid, proposalUuid);
      if (!proposal) {
        return { content: [{ type: "text", text: "Proposal not found" }], isError: true };
      }

      if (proposal.status !== "pending") {
        return { content: [{ type: "text", text: `Can only reject pending Proposals, current status: ${proposal.status}` }], isError: true };
      }

      const updated = await proposalService.rejectProposal(
        proposalUuid,
        auth.actorUuid,  // Admin Agent as reviewer
        reviewNote
      );

      await activityService.createActivity({
        companyUuid: auth.companyUuid,
        projectUuid: proposal.projectUuid,
        targetType: "proposal",
        targetUuid: proposalUuid,
        actorType: "agent",
        actorUuid: auth.actorUuid,
        action: "rejected_to_draft",
        value: { reviewNote },
      });

      return {
        content: [{ type: "text", text: JSON.stringify({ uuid: updated.uuid, status: updated.status }) }],
      };
    }
  );

  // chorus_admin_close_proposal - Close a Proposal (terminal state)
  server.registerTool(
    "chorus_admin_close_proposal",
    {
      description: "Close a Proposal (Admin exclusive, permanently closes the proposal). After closing, the Proposal enters the closed terminal state and cannot be edited.",
      inputSchema: z.object({
        proposalUuid: z.string().describe("Proposal UUID"),
        reviewNote: z.string().describe("Reason for closing (required)"),
      }),
    },
    async ({ proposalUuid, reviewNote }) => {
      const proposal = await proposalService.getProposalByUuid(auth.companyUuid, proposalUuid);
      if (!proposal) {
        return { content: [{ type: "text", text: "Proposal not found" }], isError: true };
      }

      if (proposal.status !== "pending") {
        return { content: [{ type: "text", text: `Can only close pending Proposals, current status: ${proposal.status}` }], isError: true };
      }

      const updated = await proposalService.closeProposal(
        proposalUuid,
        auth.actorUuid,
        reviewNote
      );

      await activityService.createActivity({
        companyUuid: auth.companyUuid,
        projectUuid: proposal.projectUuid,
        targetType: "proposal",
        targetUuid: proposalUuid,
        actorType: "agent",
        actorUuid: auth.actorUuid,
        action: "closed",
        value: { reviewNote },
      });

      return {
        content: [{ type: "text", text: JSON.stringify({ uuid: updated.uuid, status: updated.status }) }],
      };
    }
  );

  // chorus_admin_verify_task - Verify a Task (to_verify -> done)
  server.registerTool(
    "chorus_admin_verify_task",
    {
      description: "Verify a Task (to_verify -> done, Admin exclusive, acts on behalf of humans)",
      inputSchema: z.object({
        taskUuid: z.string().describe("Task UUID"),
      }),
    },
    async ({ taskUuid }) => {
      const task = await taskService.getTaskByUuid(auth.companyUuid, taskUuid);
      if (!task) {
        return { content: [{ type: "text", text: "Task not found" }], isError: true };
      }

      if (task.status !== "to_verify") {
        return { content: [{ type: "text", text: `Can only verify Tasks in to_verify status, current status: ${task.status}` }], isError: true };
      }

      // Check acceptance criteria gate
      const gate = await taskService.checkAcceptanceCriteriaGate(task.uuid);
      if (!gate.allowed) {
        return { content: [{ type: "text", text: `Cannot verify task: ${gate.reason}` }], isError: true };
      }

      const updated = await taskService.updateTask(task.uuid, { status: "done" });

      await activityService.createActivity({
        companyUuid: auth.companyUuid,
        projectUuid: task.projectUuid,
        targetType: "task",
        targetUuid: task.uuid,
        actorType: "agent",
        actorUuid: auth.actorUuid,
        action: "verified",
      });

      return {
        content: [{ type: "text", text: JSON.stringify({ uuid: updated.uuid, status: updated.status }) }],
      };
    }
  );

  // chorus_admin_reopen_task - Reopen a Task (to_verify -> in_progress)
  server.registerTool(
    "chorus_admin_reopen_task",
    {
      description: "Reopen a Task (to_verify -> in_progress, used when verification fails). If the task has unresolved dependencies, use force=true to bypass the dependency check.",
      inputSchema: z.object({
        taskUuid: z.string().describe("Task UUID"),
        force: z.boolean().optional().describe("Force status change, bypassing dependency check"),
      }),
    },
    async ({ taskUuid, force }) => {
      const task = await taskService.getTaskByUuid(auth.companyUuid, taskUuid);
      if (!task) {
        return { content: [{ type: "text", text: "Task not found" }], isError: true };
      }

      if (task.status !== "to_verify") {
        return { content: [{ type: "text", text: `Can only reopen Tasks in to_verify status, current status: ${task.status}` }], isError: true };
      }

      // Check dependencies unless force is true
      if (force !== true) {
        const depCheck = await taskService.checkDependenciesResolved(task.uuid);
        if (!depCheck.resolved) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                error: "blocked_by_dependencies",
                message: `Task is blocked by ${depCheck.blockers.length} unresolved dependency(ies). Use force=true to bypass.`,
                blockers: depCheck.blockers,
              }),
            }],
            isError: true,
          };
        }
      }

      const updated = await taskService.updateTask(task.uuid, { status: "in_progress" });

      // Log force_status_change activity when force is used
      if (force === true) {
        await activityService.createActivity({
          companyUuid: auth.companyUuid,
          projectUuid: task.projectUuid,
          targetType: "task",
          targetUuid: task.uuid,
          actorType: "agent",
          actorUuid: auth.actorUuid,
          action: "force_status_change",
          value: { status: "in_progress", force: true },
        });
      }

      await activityService.createActivity({
        companyUuid: auth.companyUuid,
        projectUuid: task.projectUuid,
        targetType: "task",
        targetUuid: task.uuid,
        actorType: "agent",
        actorUuid: auth.actorUuid,
        action: "reopened",
      });

      return {
        content: [{ type: "text", text: JSON.stringify({ uuid: updated.uuid, status: updated.status }) }],
      };
    }
  );

  // chorus_mark_acceptance_criteria - Mark acceptance criteria as passed or failed
  server.registerTool(
    "chorus_mark_acceptance_criteria",
    {
      description: "Mark acceptance criteria as passed or failed (admin verification)",
      inputSchema: z.object({
        taskUuid: z.string().describe("Task UUID"),
        criteria: z.array(z.object({
          uuid: z.string().describe("AcceptanceCriterion UUID"),
          status: z.enum(["passed", "failed"]).describe("Verification result"),
          evidence: z.string().optional().describe("Optional evidence/notes"),
        })).describe("Criteria verification results (batch)"),
      }),
    },
    async ({ taskUuid, criteria }) => {
      const result = await taskService.markAcceptanceCriteria(
        auth.companyUuid,
        taskUuid,
        criteria,
        { type: auth.type, actorUuid: auth.actorUuid },
      );
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // chorus_admin_close_task - Close a Task (any -> closed)
  server.registerTool(
    "chorus_admin_close_task",
    {
      description: "Close a Task (any status -> closed, Admin exclusive)",
      inputSchema: z.object({
        taskUuid: z.string().describe("Task UUID"),
      }),
    },
    async ({ taskUuid }) => {
      const task = await taskService.getTaskByUuid(auth.companyUuid, taskUuid);
      if (!task) {
        return { content: [{ type: "text", text: "Task not found" }], isError: true };
      }

      if (task.status === "closed") {
        return { content: [{ type: "text", text: "Task is already in closed status" }], isError: true };
      }

      const updated = await taskService.updateTask(task.uuid, { status: "closed" });

      await activityService.createActivity({
        companyUuid: auth.companyUuid,
        projectUuid: task.projectUuid,
        targetType: "task",
        targetUuid: task.uuid,
        actorType: "agent",
        actorUuid: auth.actorUuid,
        action: "closed",
      });

      return {
        content: [{ type: "text", text: JSON.stringify({ uuid: updated.uuid, status: updated.status }) }],
      };
    }
  );

  // chorus_admin_delete_idea - Delete an Idea
  server.registerTool(
    "chorus_admin_delete_idea",
    {
      description: "Delete an Idea (Admin exclusive, can delete any Idea)",
      inputSchema: z.object({
        ideaUuid: z.string().describe("Idea UUID"),
      }),
    },
    async ({ ideaUuid }) => {
      const idea = await ideaService.getIdeaByUuid(auth.companyUuid, ideaUuid);
      if (!idea) {
        return { content: [{ type: "text", text: "Idea not found" }], isError: true };
      }

      await ideaService.deleteIdea(ideaUuid);

      return {
        content: [{ type: "text", text: `Idea ${ideaUuid} deleted` }],
      };
    }
  );

  // chorus_admin_delete_task - Delete a Task
  server.registerTool(
    "chorus_admin_delete_task",
    {
      description: "Delete a Task (Admin exclusive, can delete any Task)",
      inputSchema: z.object({
        taskUuid: z.string().describe("Task UUID"),
      }),
    },
    async ({ taskUuid }) => {
      const task = await taskService.getTaskByUuid(auth.companyUuid, taskUuid);
      if (!task) {
        return { content: [{ type: "text", text: "Task not found" }], isError: true };
      }

      await taskService.deleteTask(taskUuid);

      return {
        content: [{ type: "text", text: `Task ${taskUuid} deleted` }],
      };
    }
  );

  // chorus_admin_delete_document - Delete a Document
  server.registerTool(
    "chorus_admin_delete_document",
    {
      description: "Delete a Document (Admin exclusive, can delete any Document)",
      inputSchema: z.object({
        documentUuid: z.string().describe("Document UUID"),
      }),
    },
    async ({ documentUuid }) => {
      const doc = await documentService.getDocument(auth.companyUuid, documentUuid);
      if (!doc) {
        return { content: [{ type: "text", text: "Document not found" }], isError: true };
      }

      await documentService.deleteDocument(documentUuid);

      return {
        content: [{ type: "text", text: `Document ${documentUuid} deleted` }],
      };
    }
  );

  // chorus_admin_close_idea - Close an Idea (any -> closed)
  server.registerTool(
    "chorus_admin_close_idea",
    {
      description: "Close an Idea (any status -> closed, Admin exclusive)",
      inputSchema: z.object({
        ideaUuid: z.string().describe("Idea UUID"),
      }),
    },
    async ({ ideaUuid }) => {
      const idea = await ideaService.getIdeaByUuid(auth.companyUuid, ideaUuid);
      if (!idea) {
        return { content: [{ type: "text", text: "Idea not found" }], isError: true };
      }

      if (idea.status === "closed") {
        return { content: [{ type: "text", text: "Idea is already in closed status" }], isError: true };
      }

      const updated = await ideaService.updateIdea(ideaUuid, auth.companyUuid, { status: "closed" });

      await activityService.createActivity({
        companyUuid: auth.companyUuid,
        projectUuid: idea.projectUuid,
        targetType: "idea",
        targetUuid: ideaUuid,
        actorType: "agent",
        actorUuid: auth.actorUuid,
        action: "closed",
      });

      return {
        content: [{ type: "text", text: JSON.stringify({ uuid: updated.uuid, status: updated.status }) }],
      };
    }
  );

  // ===== Project Group Admin Tools =====

  // chorus_admin_create_project_group - Create a new project group
  server.registerTool(
    "chorus_admin_create_project_group",
    {
      description: "Create a new project group (Admin exclusive)",
      inputSchema: z.object({
        name: z.string().describe("Project group name"),
        description: z.string().optional().describe("Project group description"),
      }),
    },
    async ({ name, description }) => {
      const group = await projectGroupService.createProjectGroup({
        companyUuid: auth.companyUuid,
        name,
        description: description || null,
      });

      return {
        content: [{ type: "text", text: JSON.stringify(group, null, 2) }],
      };
    }
  );

  // chorus_admin_update_project_group - Update a project group
  server.registerTool(
    "chorus_admin_update_project_group",
    {
      description: "Update a project group (Admin exclusive)",
      inputSchema: z.object({
        groupUuid: z.string().describe("Project Group UUID"),
        name: z.string().optional().describe("New group name"),
        description: z.string().optional().describe("New group description"),
      }),
    },
    async ({ groupUuid, name, description }) => {
      const group = await projectGroupService.updateProjectGroup({
        companyUuid: auth.companyUuid,
        groupUuid,
        name,
        description,
      });

      if (!group) {
        return { content: [{ type: "text", text: "Project group not found" }], isError: true };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(group, null, 2) }],
      };
    }
  );

  // chorus_admin_delete_project_group - Delete a project group
  server.registerTool(
    "chorus_admin_delete_project_group",
    {
      description: "Delete a project group (Admin exclusive). Projects in the group become ungrouped.",
      inputSchema: z.object({
        groupUuid: z.string().describe("Project Group UUID"),
      }),
    },
    async ({ groupUuid }) => {
      const deleted = await projectGroupService.deleteProjectGroup(auth.companyUuid, groupUuid);

      if (!deleted) {
        return { content: [{ type: "text", text: "Project group not found" }], isError: true };
      }

      return {
        content: [{ type: "text", text: `Project group ${groupUuid} deleted` }],
      };
    }
  );

  // chorus_admin_move_project_to_group - Move a project to a group or ungroup it
  server.registerTool(
    "chorus_admin_move_project_to_group",
    {
      description: "Move a project to a different group or ungroup it (Admin exclusive). Set groupUuid to null to ungroup.",
      inputSchema: z.object({
        projectUuid: z.string().describe("Project UUID"),
        groupUuid: z.string().nullable().describe("Target Project Group UUID (null to ungroup)"),
      }),
    },
    async ({ projectUuid, groupUuid }) => {
      const result = await projectGroupService.moveProjectToGroup(
        auth.companyUuid,
        projectUuid,
        groupUuid
      );

      if (!result) {
        return { content: [{ type: "text", text: "Project or project group not found" }], isError: true };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}
