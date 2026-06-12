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
import { zArray } from "./schema-utils";
import { registerPermissionedTool, assertProjectAccess, assertProjectManageOrClaim, assertGroupAccess, assertGroupManageOrClaim } from "./register-helpers";

export function registerAdminTools(server: McpServer, auth: AgentAuthContext) {
  // chorus_admin_create_project - Create a new project
  registerPermissionedTool(
    server,
    auth,
    "project:write",
    "chorus_admin_create_project",
    {
      description: "Create a new project (Admin exclusive, acts on behalf of humans). Defaults to private visibility, owned by the calling actor (who is auto-added as a member). Pass visibility=\"shared\" to make it visible to everyone in the company, or supply memberUuids to grant other users/agents access to a private project. To assign to a project group, first call chorus_get_project_groups to list available groups, then pass the groupUuid.",
      inputSchema: z.object({
        name: z.string().describe("Project name"),
        description: z.string().optional().describe("Project description"),
        groupUuid: z.string().optional().describe("Optional project group UUID to assign this project to. Use chorus_get_project_groups to list available groups."),
        visibility: z.enum(["shared", "private"]).optional().describe("Project visibility. \"shared\" = visible to everyone in the company; \"private\" (default) = only the owner and explicit members."),
        memberUuids: zArray(z.object({
          memberType: z.enum(["user", "agent"]).describe("Member actor type"),
          memberUuid: z.string().describe("Member actor UUID"),
        })).optional().describe("Optional initial members (users/agents) to grant access to a private project. The owner is added automatically."),
      }),
    },
    async ({ name, description, groupUuid, visibility, memberUuids }) => {
      // MCP tools always run under an AgentAuthContext, so the calling actor is
      // the agent itself and becomes the project owner (auto-added as a member
      // by the service). The auth shape here is never super_admin.
      const project = await projectService.createProject({
        companyUuid: auth.companyUuid,
        name,
        description: description || null,
        groupUuid: groupUuid || null,
        visibility,
        ownerType: auth.type,
        ownerUuid: auth.actorUuid,
        memberUuids,
      });

      return {
        content: [{ type: "text", text: JSON.stringify({ uuid: project.uuid, name: project.name, groupUuid: project.groupUuid, visibility: project.visibility }) }],
      };
    }
  );

  // chorus_admin_create_idea moved to pm.ts as chorus_pm_create_idea

  // chorus_admin_approve_proposal - Approve a Proposal
  registerPermissionedTool(
    server,
    auth,
    "proposal:admin",
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
        reviewNote || null,
        auth
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

      const result: Record<string, unknown> = { uuid: updated.uuid, status: updated.status };
      if (updated.materializedTasks) result.materializedTasks = updated.materializedTasks;
      if (updated.materializedDocuments) result.materializedDocuments = updated.materializedDocuments;

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // chorus_admin_close_proposal - Close a Proposal (terminal state)
  registerPermissionedTool(
    server,
    auth,
    "proposal:admin",
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
        reviewNote,
        auth
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
  registerPermissionedTool(
    server,
    auth,
    "task:admin",
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

      const updated = await taskService.updateTask(task.uuid, { status: "done" }, auth);

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
  registerPermissionedTool(
    server,
    auth,
    "task:admin",
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

      const updated = await taskService.updateTask(task.uuid, { status: "in_progress" }, auth);

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
  registerPermissionedTool(
    server,
    auth,
    "task:admin",
    "chorus_mark_acceptance_criteria",
    {
      description: "Mark acceptance criteria as passed or failed (admin verification)",
      inputSchema: z.object({
        taskUuid: z.string().describe("Task UUID"),
        criteria: zArray(z.object({
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
        auth,
      );
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // chorus_admin_close_task - Close a Task (any -> closed)
  registerPermissionedTool(
    server,
    auth,
    "task:admin",
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

      const updated = await taskService.updateTask(task.uuid, { status: "closed" }, auth);

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
  registerPermissionedTool(
    server,
    auth,
    "idea:admin",
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

      await ideaService.deleteIdea(ideaUuid, auth);

      return {
        content: [{ type: "text", text: `Idea ${ideaUuid} deleted` }],
      };
    }
  );

  // chorus_admin_delete_task - Delete a Task
  registerPermissionedTool(
    server,
    auth,
    "task:admin",
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

      await taskService.deleteTask(taskUuid, auth);

      return {
        content: [{ type: "text", text: `Task ${taskUuid} deleted` }],
      };
    }
  );

  // chorus_admin_delete_document - Delete a Document
  registerPermissionedTool(
    server,
    auth,
    "document:admin",
    "chorus_admin_delete_document",
    {
      description: "Delete a Document (Admin exclusive, can delete any Document)",
      inputSchema: z.object({
        documentUuid: z.string().describe("Document UUID"),
      }),
    },
    async ({ documentUuid }) => {
      const doc = await documentService.getDocument(auth.companyUuid, documentUuid, auth);
      if (!doc) {
        return { content: [{ type: "text", text: "Document not found" }], isError: true };
      }

      await documentService.deleteDocument(documentUuid, auth);

      return {
        content: [{ type: "text", text: `Document ${documentUuid} deleted` }],
      };
    }
  );

  // ===== Project Group Admin Tools =====

  // chorus_admin_create_project_group - Create a new project group
  registerPermissionedTool(
    server,
    auth,
    "project:write",
    "chorus_admin_create_project_group",
    {
      description: "Create a new project group (Admin exclusive). Defaults to private visibility, owned by the calling actor (who is auto-added as a member). Pass visibility=\"shared\" to make it visible to everyone in the company, or supply memberUuids to grant other users/agents access to a private group.",
      inputSchema: z.object({
        name: z.string().describe("Project group name"),
        description: z.string().optional().describe("Project group description"),
        visibility: z.enum(["shared", "private"]).optional().describe("Group visibility. \"shared\" = visible to everyone in the company; \"private\" (default) = only the owner and explicit members."),
        memberUuids: zArray(z.object({
          memberType: z.enum(["user", "agent"]).describe("Member actor type"),
          memberUuid: z.string().describe("Member actor UUID"),
        })).optional().describe("Optional initial members (users/agents) to grant access to a private group. The owner is added automatically."),
      }),
    },
    async ({ name, description, visibility, memberUuids }) => {
      // MCP tools always run under an AgentAuthContext, so the calling actor is
      // the agent itself and becomes the group owner (auto-added as a member by
      // the service). The auth shape here is never super_admin.
      const group = await projectGroupService.createProjectGroup({
        companyUuid: auth.companyUuid,
        name,
        description: description || null,
        visibility,
        ownerType: auth.type,
        ownerUuid: auth.actorUuid,
        memberUuids,
      });

      return {
        content: [{ type: "text", text: JSON.stringify(group, null, 2) }],
      };
    }
  );

  // chorus_admin_update_project_group - Update a project group
  registerPermissionedTool(
    server,
    auth,
    "project:write",
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
      // Visibility guard: only the group owner (or super admin) may rename/retag
      // a group. assertGroupManage returns the same not-found-or-denied error for
      // an inaccessible group — no existence leak.
      const denied = await assertGroupManageOrClaim(auth, groupUuid);
      if (denied) return denied;

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
  registerPermissionedTool(
    server,
    auth,
    "project:write",
    "chorus_admin_delete_project_group",
    {
      description: "Delete a project group (Admin exclusive). Projects in the group become ungrouped.",
      inputSchema: z.object({
        groupUuid: z.string().describe("Project Group UUID"),
      }),
    },
    async ({ groupUuid }) => {
      // Visibility guard: only the group owner (or super admin) may delete it.
      const denied = await assertGroupManageOrClaim(auth, groupUuid);
      if (denied) return denied;

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
  registerPermissionedTool(
    server,
    auth,
    "project:write",
    "chorus_admin_move_project_to_group",
    {
      description: "Move a project to a different group or ungroup it (Admin exclusive). Set groupUuid to null to ungroup.",
      inputSchema: z.object({
        projectUuid: z.string().describe("Project UUID"),
        groupUuid: z.string().nullable().describe("Target Project Group UUID (null to ungroup)"),
      }),
    },
    async ({ projectUuid, groupUuid }) => {
      // Visibility guard: moving a project between groups is a structural change,
      // so require management rights (owner / super admin). Non-members get the
      // same not-found-or-denied error — no existence leak.
      const denied = await assertProjectManageOrClaim(auth, projectUuid);
      if (denied) return denied;

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

  // ===== Project Member Management (visibility feature, Tech Design §6) =====

  // chorus_list_project_members - List members of a project
  registerPermissionedTool(
    server,
    auth,
    "project:read",
    "chorus_list_project_members",
    {
      description: "List the members (users and agents) of a project. Requires access to the project.",
      inputSchema: z.object({
        projectUuid: z.string().describe("Project UUID"),
      }),
    },
    async ({ projectUuid }) => {
      const denied = await assertProjectAccess(auth, projectUuid);
      if (denied) return denied;

      const members = await projectService.listProjectMembers(auth.companyUuid, projectUuid);
      return {
        content: [{ type: "text", text: JSON.stringify({ members }, null, 2) }],
      };
    }
  );

  // chorus_admin_add_project_member - Add a member to a project
  registerPermissionedTool(
    server,
    auth,
    "project:admin",
    "chorus_admin_add_project_member",
    {
      description: "Add a member (user or agent) to a project, granting them access to a private project. Only the project owner (or super admin) can manage members.",
      inputSchema: z.object({
        projectUuid: z.string().describe("Project UUID"),
        memberType: z.enum(["user", "agent"]).describe("Member actor type"),
        memberUuid: z.string().describe("Member actor UUID"),
      }),
    },
    async ({ projectUuid, memberType, memberUuid }) => {
      const denied = await assertProjectManageOrClaim(auth, projectUuid);
      if (denied) return denied;

      const member = await projectService.addProjectMember(
        auth.companyUuid,
        projectUuid,
        memberType,
        memberUuid
      );
      if (!member) {
        return { content: [{ type: "text", text: "Project not found" }], isError: true };
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ member }, null, 2) }],
      };
    }
  );

  // chorus_admin_remove_project_member - Remove a member from a project
  registerPermissionedTool(
    server,
    auth,
    "project:admin",
    "chorus_admin_remove_project_member",
    {
      description: "Remove a member (user or agent) from a project. The owner cannot be removed. Only the project owner (or super admin) can manage members.",
      inputSchema: z.object({
        projectUuid: z.string().describe("Project UUID"),
        memberType: z.enum(["user", "agent"]).describe("Member actor type"),
        memberUuid: z.string().describe("Member actor UUID"),
      }),
    },
    async ({ projectUuid, memberType, memberUuid }) => {
      const denied = await assertProjectManageOrClaim(auth, projectUuid);
      if (denied) return denied;

      const removed = await projectService.removeProjectMember(
        auth.companyUuid,
        projectUuid,
        memberType,
        memberUuid
      );
      if (!removed) {
        return { content: [{ type: "text", text: "Member not found or cannot be removed (owner)" }], isError: true };
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ projectUuid, memberType, memberUuid, removed: true }, null, 2) }],
      };
    }
  );

  // ===== Project Group Member Management (visibility feature, Tech Design §6) =====

  // chorus_list_project_group_members - List members of a project group
  registerPermissionedTool(
    server,
    auth,
    "project:read",
    "chorus_list_project_group_members",
    {
      description: "List the members (users and agents) of a project group. Requires access to the group.",
      inputSchema: z.object({
        groupUuid: z.string().describe("Project Group UUID"),
      }),
    },
    async ({ groupUuid }) => {
      const denied = await assertGroupAccess(auth, groupUuid);
      if (denied) return denied;

      const members = await projectGroupService.listGroupMembers(auth.companyUuid, groupUuid);
      return {
        content: [{ type: "text", text: JSON.stringify({ members }, null, 2) }],
      };
    }
  );

  // chorus_admin_add_project_group_member - Add a member to a project group
  registerPermissionedTool(
    server,
    auth,
    "project:admin",
    "chorus_admin_add_project_group_member",
    {
      description: "Add a member (user or agent) to a project group, granting them access to a private group (and, by inheritance, its projects). Only the group owner (or super admin) can manage members.",
      inputSchema: z.object({
        groupUuid: z.string().describe("Project Group UUID"),
        memberType: z.enum(["user", "agent"]).describe("Member actor type"),
        memberUuid: z.string().describe("Member actor UUID"),
      }),
    },
    async ({ groupUuid, memberType, memberUuid }) => {
      const denied = await assertGroupManageOrClaim(auth, groupUuid);
      if (denied) return denied;

      const member = await projectGroupService.addGroupMember(
        auth.companyUuid,
        groupUuid,
        memberType,
        memberUuid
      );
      if (!member) {
        return { content: [{ type: "text", text: "Project group not found" }], isError: true };
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ member }, null, 2) }],
      };
    }
  );

  // chorus_admin_remove_project_group_member - Remove a member from a project group
  registerPermissionedTool(
    server,
    auth,
    "project:admin",
    "chorus_admin_remove_project_group_member",
    {
      description: "Remove a member (user or agent) from a project group. The owner cannot be removed. Only the group owner (or super admin) can manage members.",
      inputSchema: z.object({
        groupUuid: z.string().describe("Project Group UUID"),
        memberType: z.enum(["user", "agent"]).describe("Member actor type"),
        memberUuid: z.string().describe("Member actor UUID"),
      }),
    },
    async ({ groupUuid, memberType, memberUuid }) => {
      const denied = await assertGroupManageOrClaim(auth, groupUuid);
      if (denied) return denied;

      const removed = await projectGroupService.removeGroupMember(
        auth.companyUuid,
        groupUuid,
        memberType,
        memberUuid
      );
      if (!removed) {
        return { content: [{ type: "text", text: "Member not found or cannot be removed (owner)" }], isError: true };
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ groupUuid, memberType, memberUuid, removed: true }, null, 2) }],
      };
    }
  );
}
