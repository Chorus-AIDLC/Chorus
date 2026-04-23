// src/mcp/tools/pm.ts
// PM Agent MCP Tools (ARCHITECTURE.md §5.2)
// UUID-Based Architecture: All operations use UUIDs

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AgentAuthContext } from "@/types/auth";
import { prisma } from "@/lib/prisma";
import { projectExists } from "@/services/project.service";
import * as ideaService from "@/services/idea.service";
import * as proposalService from "@/services/proposal.service";
import * as documentService from "@/services/document.service";
import * as taskService from "@/services/task.service";
import * as activityService from "@/services/activity.service";
import * as elaborationService from "@/services/elaboration.service";
import { getAgentByUuid } from "@/services/agent.service";
import { AlreadyClaimedError, NotClaimedError } from "@/lib/errors";
import { zArray } from "./schema-utils";

export function registerPmTools(server: McpServer, auth: AgentAuthContext) {
  // chorus_claim_idea - Claim an Idea
  server.registerTool(
    "chorus_claim_idea",
    {
      description: "Claim an Idea (open -> elaborating). Claiming automatically transitions the Idea to 'elaborating' status. After claiming, start elaboration with chorus_pm_start_elaboration or skip with chorus_pm_skip_elaboration.",
      inputSchema: z.object({
        ideaUuid: z.string().describe("Idea UUID"),
      }),
    },
    async ({ ideaUuid }) => {
      const idea = await ideaService.getIdeaByUuid(auth.companyUuid, ideaUuid);
      if (!idea) {
        return { content: [{ type: "text", text: "Idea not found" }], isError: true };
      }

      try {
        const updated = await ideaService.claimIdea({
          ideaUuid: idea.uuid,
          companyUuid: auth.companyUuid,
          assigneeType: "agent",
          assigneeUuid: auth.actorUuid,
        });

        await activityService.createActivity({
          companyUuid: auth.companyUuid,
          projectUuid: idea.projectUuid,
          targetType: "idea",
          targetUuid: idea.uuid,
          actorType: "agent",
          actorUuid: auth.actorUuid,
          action: "assigned",
          value: { assigneeType: "agent", assigneeUuid: auth.actorUuid },
        });

        return {
          content: [{ type: "text", text: JSON.stringify({ uuid: updated.uuid, status: updated.status }, null, 2) }],
        };
      } catch (e) {
        if (e instanceof AlreadyClaimedError) {
          return { content: [{ type: "text", text: "Can only claim Ideas with open status" }], isError: true };
        }
        throw e;
      }
    }
  );

  // chorus_release_idea - Release a claimed Idea
  server.registerTool(
    "chorus_release_idea",
    {
      description: "Release a claimed Idea (assigned -> open)",
      inputSchema: z.object({
        ideaUuid: z.string().describe("Idea UUID"),
      }),
    },
    async ({ ideaUuid }) => {
      const idea = await ideaService.getIdeaByUuid(auth.companyUuid, ideaUuid);
      if (!idea) {
        return { content: [{ type: "text", text: "Idea not found" }], isError: true };
      }

      // Check if the caller is the assignee (UUID comparison)
      const isAssignee =
        (idea.assigneeType === "agent" && idea.assigneeUuid === auth.actorUuid) ||
        (idea.assigneeType === "user" && auth.ownerUuid && idea.assigneeUuid === auth.ownerUuid);

      if (!isAssignee) {
        return { content: [{ type: "text", text: "Only the assignee can release a claimed Idea" }], isError: true };
      }

      try {
        const updated = await ideaService.releaseIdea(idea.uuid);

        await activityService.createActivity({
          companyUuid: auth.companyUuid,
          projectUuid: idea.projectUuid,
          targetType: "idea",
          targetUuid: idea.uuid,
          actorType: "agent",
          actorUuid: auth.actorUuid,
          action: "released",
        });

        return {
          content: [{ type: "text", text: JSON.stringify({ uuid: updated.uuid, status: updated.status }, null, 2) }],
        };
      } catch (e) {
        if (e instanceof NotClaimedError) {
          return { content: [{ type: "text", text: "Can only release Ideas with assigned status" }], isError: true };
        }
        throw e;
      }
    }
  );

  // chorus_pm_create_proposal - Create a Proposal (container model)
  server.registerTool(
    "chorus_pm_create_proposal",
    {
      description: "Create an empty Proposal container. Use chorus_pm_add_document_draft and chorus_pm_add_task_draft to populate it afterwards.",
      inputSchema: z.object({
        projectUuid: z.string().describe("Project UUID"),
        title: z.string().describe("Proposal title"),
        description: z.string().optional().describe("Proposal description"),
        inputType: z.enum(["idea", "document"]).describe("Input source type"),
        inputUuids: zArray(z.string()).describe("Input UUID list"),
      }),
    },
    async ({ projectUuid, title, description, inputType, inputUuids }) => {
      // Validate project exists
      if (!(await projectExists(auth.companyUuid, projectUuid))) {
        return { content: [{ type: "text", text: "Project not found" }], isError: true };
      }

      // If input type is idea, validate assignee
      let reusedWarning = "";
      if (inputType === "idea") {
        const assigneeCheck = await proposalService.checkIdeasAssignee(
          auth.companyUuid,
          inputUuids,
          auth.actorUuid,
          "agent"
        );
        if (!assigneeCheck.valid) {
          return {
            content: [{ type: "text", text: "Can only create Proposals based on Ideas you have claimed" }],
            isError: true,
          };
        }

        // Check if ideas are already used by other proposals (informational only, not blocking)
        const availabilityCheck = await proposalService.checkIdeasAvailability(
          auth.companyUuid,
          inputUuids
        );
        reusedWarning = !availabilityCheck.available
          ? `\nNote: Idea is also referenced by existing Proposal(s): ${availabilityCheck.usedIdeas.map(u => `"${u.proposalTitle}"`).join(", ")}`
          : "";
      }

      const proposal = await proposalService.createProposal({
        companyUuid: auth.companyUuid,
        projectUuid,
        title,
        description,
        inputType,
        inputUuids,
        createdByUuid: auth.actorUuid,
        createdByType: "agent",
      });

      return {
        content: [{ type: "text", text: JSON.stringify({ uuid: proposal.uuid, title: proposal.title, status: proposal.status }, null, 2) + reusedWarning }],
      };
    }
  );

  // chorus_pm_validate_proposal - Validate Proposal completeness
  server.registerTool(
    "chorus_pm_validate_proposal",
    {
      description: "Validate a Proposal's completeness before submission. Returns errors (block submission), warnings (advisory), and info (hints). Call this before chorus_pm_submit_proposal to preview issues.",
      inputSchema: z.object({
        proposalUuid: z.string().describe("Proposal UUID to validate"),
      }),
    },
    async ({ proposalUuid }) => {
      try {
        const result = await proposalService.validateProposal(
          auth.companyUuid,
          proposalUuid
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed to validate Proposal: ${error instanceof Error ? error.message : "Unknown error"}` }],
          isError: true,
        };
      }
    }
  );

  // chorus_pm_submit_proposal - Submit Proposal for approval
  server.registerTool(
    "chorus_pm_submit_proposal",
    {
      description: "Submit a Proposal for approval (draft -> pending). Requires all input Ideas to have elaborationStatus = 'resolved'. Call chorus_pm_start_elaboration or chorus_pm_skip_elaboration first to resolve elaboration before submitting.",
      inputSchema: z.object({
        proposalUuid: z.string().describe("Proposal UUID"),
      }),
    },
    async ({ proposalUuid }) => {
      try {
        const proposal = await proposalService.submitProposal(
          proposalUuid,
          auth.companyUuid
        );
        return {
          content: [{ type: "text", text: JSON.stringify({ uuid: proposal.uuid, status: proposal.status }, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed to submit Proposal: ${error instanceof Error ? error.message : "Unknown error"}` }],
          isError: true,
        };
      }
    }
  );

  // chorus_pm_create_document - Create a document
  server.registerTool(
    "chorus_pm_create_document",
    {
      description: "Create a document (PRD, tech design, ADR, etc.)",
      inputSchema: z.object({
        projectUuid: z.string().describe("Project UUID"),
        type: z.enum(["prd", "tech_design", "adr", "spec", "guide"]).describe("Document type"),
        title: z.string().describe("Document title"),
        content: z.string().optional().describe("Document content (Markdown)"),
        proposalUuid: z.string().optional().describe("Associated Proposal UUID (optional)"),
      }),
    },
    async ({ projectUuid, type, title, content, proposalUuid }) => {
      // Validate project exists
      if (!(await projectExists(auth.companyUuid, projectUuid))) {
        return { content: [{ type: "text", text: "Project not found" }], isError: true };
      }

      // Validate Proposal exists (if provided)
      if (proposalUuid) {
        const proposal = await proposalService.getProposalByUuid(auth.companyUuid, proposalUuid);
        if (!proposal) {
          return { content: [{ type: "text", text: "Proposal not found" }], isError: true };
        }
      }

      const document = await documentService.createDocument({
        companyUuid: auth.companyUuid,
        projectUuid,
        type,
        title,
        content: content || null,
        proposalUuid: proposalUuid || null,
        createdByUuid: auth.actorUuid,
      });

      return {
        content: [{ type: "text", text: JSON.stringify({ uuid: document.uuid, title: document.title, type: document.type }, null, 2) }],
      };
    }
  );

  // chorus_pm_create_tasks - Deprecated alias for chorus_create_tasks (now in public.ts)
  // Kept for backward compatibility with existing agents that reference the old name.
  server.registerTool(
    "chorus_pm_create_tasks",
    {
      description: "[Deprecated — use chorus_create_tasks instead] Batch create tasks (can associate with a Proposal, supports intra-batch dependencies)",
      inputSchema: z.object({
        projectUuid: z.string().describe("Project UUID"),
        proposalUuid: z.string().optional().describe("Associated Proposal UUID (optional)"),
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

  // chorus_pm_update_document - Update document content
  server.registerTool(
    "chorus_pm_update_document",
    {
      description: "Update document content (increments version number)",
      inputSchema: z.object({
        documentUuid: z.string().describe("Document UUID"),
        title: z.string().optional().describe("New title"),
        content: z.string().optional().describe("New content (Markdown)"),
      }),
    },
    async ({ documentUuid, title, content }) => {
      const doc = await documentService.getDocument(auth.companyUuid, documentUuid);
      if (!doc) {
        return { content: [{ type: "text", text: "Document not found" }], isError: true };
      }

      const updated = await documentService.updateDocument(documentUuid, {
        title,
        content,
        incrementVersion: true,
      });

      return {
        content: [{ type: "text", text: JSON.stringify({ uuid: updated.uuid, version: updated.version }, null, 2) }],
      };
    }
  );

  // ===== Proposal Draft Management Tools =====

  // chorus_pm_add_document_draft - Add document draft to Proposal
  server.registerTool(
    "chorus_pm_add_document_draft",
    {
      description: "Add a document draft to a pending Proposal container",
      inputSchema: z.object({
        proposalUuid: z.string().describe("Proposal UUID"),
        type: z.string().describe("Document type (prd, tech_design, adr, spec, guide)"),
        title: z.string().describe("Document title"),
        content: z.string().describe("Document content (Markdown)"),
      }),
    },
    async ({ proposalUuid, type, title, content }) => {
      try {
        const proposal = await proposalService.addDocumentDraft(
          proposalUuid,
          auth.companyUuid,
          { type, title, content }
        );
        const documentDrafts = proposal.documentDrafts as Array<{ uuid: string; title: string }> | null;
        const newDraft = documentDrafts?.[documentDrafts.length - 1];
        return {
          content: [{ type: "text", text: JSON.stringify({ proposalUuid: proposal.uuid, action: "document_draft_added", draftUuid: newDraft?.uuid, draftTitle: newDraft?.title }, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed to add document draft: ${error instanceof Error ? error.message : "Unknown error"}` }],
          isError: true,
        };
      }
    }
  );

  // chorus_pm_add_task_draft - Add task draft to Proposal
  server.registerTool(
    "chorus_pm_add_task_draft",
    {
      description: "Add a task draft to a pending Proposal container",
      inputSchema: z.object({
        proposalUuid: z.string().describe("Proposal UUID"),
        title: z.string().describe("Task title"),
        description: z.string().optional().describe("Task description"),
        storyPoints: z.number().optional().describe("Effort estimate (agent hours)"),
        priority: z.enum(["low", "medium", "high"]).optional().describe("Priority"),
        acceptanceCriteriaItems: zArray(z.object({
          description: z.string().describe("Criterion description"),
          required: z.boolean().optional().describe("Whether this criterion is required (default: true)"),
        })).optional().describe("Structured acceptance criteria items (materialized on approval)"),
        dependsOnDraftUuids: zArray(z.string()).optional().describe("Dependent taskDraft UUID list"),
      }),
    },
    async ({ proposalUuid, title, description, storyPoints, priority, acceptanceCriteriaItems, dependsOnDraftUuids }) => {
      try {
        const proposal = await proposalService.addTaskDraft(
          proposalUuid,
          auth.companyUuid,
          { title, description, storyPoints, priority, acceptanceCriteriaItems, dependsOnDraftUuids }
        );
        const taskDrafts = proposal.taskDrafts as Array<{ uuid: string; title: string }> | null;
        const newDraft = taskDrafts?.[taskDrafts.length - 1];
        return {
          content: [{ type: "text", text: JSON.stringify({ proposalUuid: proposal.uuid, action: "task_draft_added", draftUuid: newDraft?.uuid, draftTitle: newDraft?.title }, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed to add task draft: ${error instanceof Error ? error.message : "Unknown error"}` }],
          isError: true,
        };
      }
    }
  );

  // chorus_pm_update_document_draft - Update document draft
  server.registerTool(
    "chorus_pm_update_document_draft",
    {
      description: "Update a document draft in a Proposal",
      inputSchema: z.object({
        proposalUuid: z.string().describe("Proposal UUID"),
        draftUuid: z.string().describe("Document draft UUID"),
        type: z.string().optional().describe("Document type"),
        title: z.string().optional().describe("Document title"),
        content: z.string().optional().describe("Document content (Markdown)"),
      }),
    },
    async ({ proposalUuid, draftUuid, type, title, content }) => {
      try {
        const updates: { type?: string; title?: string; content?: string } = {};
        if (type !== undefined) updates.type = type;
        if (title !== undefined) updates.title = title;
        if (content !== undefined) updates.content = content;

        const proposal = await proposalService.updateDocumentDraft(
          proposalUuid,
          auth.companyUuid,
          draftUuid,
          updates
        );
        return {
          content: [{ type: "text", text: JSON.stringify({ proposalUuid: proposal.uuid, draftUuid, action: "document_draft_updated" }, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed to update document draft: ${error instanceof Error ? error.message : "Unknown error"}` }],
          isError: true,
        };
      }
    }
  );

  // chorus_pm_update_task_draft - Update task draft
  server.registerTool(
    "chorus_pm_update_task_draft",
    {
      description: "Update a task draft in a Proposal",
      inputSchema: z.object({
        proposalUuid: z.string().describe("Proposal UUID"),
        draftUuid: z.string().describe("Task draft UUID"),
        title: z.string().optional().describe("Task title"),
        description: z.string().optional().describe("Task description"),
        storyPoints: z.number().optional().describe("Effort estimate (agent hours)"),
        priority: z.enum(["low", "medium", "high"]).optional().describe("Priority"),
        acceptanceCriteriaItems: zArray(z.object({
          description: z.string().describe("Criterion description"),
          required: z.boolean().optional().describe("Whether this criterion is required (default: true)"),
        })).optional().describe("Structured acceptance criteria items (replaces existing items)"),
        dependsOnDraftUuids: zArray(z.string()).optional().describe("Dependent taskDraft UUID list"),
      }),
    },
    async ({ proposalUuid, draftUuid, title, description, storyPoints, priority, acceptanceCriteriaItems, dependsOnDraftUuids }) => {
      try {
        const updates: { title?: string; description?: string; storyPoints?: number; priority?: string; acceptanceCriteriaItems?: Array<{ description: string; required?: boolean }>; dependsOnDraftUuids?: string[] } = {};
        if (title !== undefined) updates.title = title;
        if (description !== undefined) updates.description = description;
        if (storyPoints !== undefined) updates.storyPoints = storyPoints;
        if (priority !== undefined) updates.priority = priority;
        if (acceptanceCriteriaItems !== undefined) updates.acceptanceCriteriaItems = acceptanceCriteriaItems;
        if (dependsOnDraftUuids !== undefined) updates.dependsOnDraftUuids = dependsOnDraftUuids;

        const proposal = await proposalService.updateTaskDraft(
          proposalUuid,
          auth.companyUuid,
          draftUuid,
          updates
        );
        return {
          content: [{ type: "text", text: JSON.stringify({ proposalUuid: proposal.uuid, draftUuid, action: "task_draft_updated" }, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed to update task draft: ${error instanceof Error ? error.message : "Unknown error"}` }],
          isError: true,
        };
      }
    }
  );

  // chorus_pm_remove_document_draft - Remove document draft
  server.registerTool(
    "chorus_pm_remove_document_draft",
    {
      description: "Remove a document draft from a Proposal",
      inputSchema: z.object({
        proposalUuid: z.string().describe("Proposal UUID"),
        draftUuid: z.string().describe("Document draft UUID"),
      }),
    },
    async ({ proposalUuid, draftUuid }) => {
      try {
        const proposal = await proposalService.removeDocumentDraft(
          proposalUuid,
          auth.companyUuid,
          draftUuid
        );
        return {
          content: [{ type: "text", text: JSON.stringify({ proposalUuid: proposal.uuid, draftUuid, action: "document_draft_removed" }, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed to remove document draft: ${error instanceof Error ? error.message : "Unknown error"}` }],
          isError: true,
        };
      }
    }
  );

  // chorus_pm_remove_task_draft - Remove task draft
  server.registerTool(
    "chorus_pm_remove_task_draft",
    {
      description: "Remove a task draft from a Proposal",
      inputSchema: z.object({
        proposalUuid: z.string().describe("Proposal UUID"),
        draftUuid: z.string().describe("Task draft UUID"),
      }),
    },
    async ({ proposalUuid, draftUuid }) => {
      try {
        const proposal = await proposalService.removeTaskDraft(
          proposalUuid,
          auth.companyUuid,
          draftUuid
        );
        return {
          content: [{ type: "text", text: JSON.stringify({ proposalUuid: proposal.uuid, draftUuid, action: "task_draft_removed" }, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed to remove task draft: ${error instanceof Error ? error.message : "Unknown error"}` }],
          isError: true,
        };
      }
    }
  );

  // chorus_add_task_dependency - Add task dependency
  server.registerTool(
    "chorus_add_task_dependency",
    {
      description: "Add a task dependency (taskUuid depends on dependsOnTaskUuid). Includes same-project validation, self-dependency check, and cycle detection.",
      inputSchema: z.object({
        taskUuid: z.string().describe("Task UUID (downstream task)"),
        dependsOnTaskUuid: z.string().describe("Dependent Task UUID (upstream task)"),
      }),
    },
    async ({ taskUuid, dependsOnTaskUuid }) => {
      try {
        const dep = await taskService.addTaskDependency(auth.companyUuid, taskUuid, dependsOnTaskUuid);
        return {
          content: [{ type: "text", text: JSON.stringify(dep, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed to add dependency: ${error instanceof Error ? error.message : "Unknown error"}` }],
          isError: true,
        };
      }
    }
  );

  // chorus_remove_task_dependency - Remove task dependency
  server.registerTool(
    "chorus_remove_task_dependency",
    {
      description: "Remove a task dependency",
      inputSchema: z.object({
        taskUuid: z.string().describe("Task UUID"),
        dependsOnTaskUuid: z.string().describe("Dependent Task UUID to remove"),
      }),
    },
    async ({ taskUuid, dependsOnTaskUuid }) => {
      try {
        await taskService.removeTaskDependency(auth.companyUuid, taskUuid, dependsOnTaskUuid);
        return {
          content: [{ type: "text", text: JSON.stringify({ success: true, taskUuid, dependsOnTaskUuid }, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed to remove dependency: ${error instanceof Error ? error.message : "Unknown error"}` }],
          isError: true,
        };
      }
    }
  );

  // chorus_pm_assign_task - Assign task to a Developer Agent
  server.registerTool(
    "chorus_pm_assign_task",
    {
      description: "Assign a task to a specified Developer Agent (task must be in open or assigned status)",
      inputSchema: z.object({
        taskUuid: z.string().describe("Task UUID"),
        agentUuid: z.string().describe("Target Developer Agent UUID"),
      }),
    },
    async ({ taskUuid, agentUuid }) => {
      // Validate task exists
      const task = await taskService.getTaskByUuid(auth.companyUuid, taskUuid);
      if (!task) {
        return { content: [{ type: "text", text: "Task not found" }], isError: true };
      }

      // Validate task status
      if (task.status !== "open" && task.status !== "assigned") {
        return {
          content: [{ type: "text", text: `Can only assign tasks with open or assigned status, current status: ${task.status}` }],
          isError: true,
        };
      }

      // Validate target agent exists and belongs to the same company
      const targetAgent = await getAgentByUuid(auth.companyUuid, agentUuid);
      if (!targetAgent) {
        return { content: [{ type: "text", text: "Target Agent not found" }], isError: true };
      }

      // Validate target agent has the developer role
      const hasDeveloperRole = targetAgent.roles.some(
        (r: string) => r === "developer" || r === "developer_agent"
      );
      if (!hasDeveloperRole) {
        return {
          content: [{ type: "text", text: `Agent "${targetAgent.name}" does not have the developer role` }],
          isError: true,
        };
      }

      // Execute assignment
      try {
        await taskService.claimTask({
          taskUuid: task.uuid,
          companyUuid: auth.companyUuid,
          assigneeType: "agent",
          assigneeUuid: agentUuid,
          assignedByUuid: auth.actorUuid,
        });

        // Log activity
        await activityService.createActivity({
          companyUuid: auth.companyUuid,
          projectUuid: task.projectUuid,
          targetType: "task",
          targetUuid: task.uuid,
          actorType: "agent",
          actorUuid: auth.actorUuid,
          action: "assigned",
          value: { assigneeType: "agent", assigneeUuid: agentUuid, assignedBy: auth.actorUuid },
        });

        // Fetch full task details with dependencies
        const fullTask = await taskService.getTask(auth.companyUuid, task.uuid);

        // Build compact response with only essential fields
        const compact: Record<string, unknown> = {
          uuid: fullTask?.uuid,
          title: fullTask?.title,
          description: fullTask?.description,
          status: fullTask?.status,
          acceptanceCriteriaItems: fullTask?.acceptanceCriteriaItems?.length
            ? fullTask.acceptanceCriteriaItems
            : undefined,
          dependsOn: fullTask?.dependsOn?.length ? fullTask.dependsOn : undefined,
          dependedBy: fullTask?.dependedBy?.length ? fullTask.dependedBy : undefined,
        };

        // Build blocking hints
        const hints: string[] = [];
        if (fullTask?.dependsOn?.length) {
          const unresolved = fullTask.dependsOn.filter(
            (d) => d.status !== "done" && d.status !== "closed"
          );
          if (unresolved.length > 0) {
            const names = unresolved.map((d) => `"${d.title}" (${d.status})`).join(", ");
            hints.push(`⚠ BLOCKED: This task depends on unfinished tasks: ${names}. They must be verified to done by an admin or human before work can proceed.`);
          }
        }
        if (fullTask?.dependedBy?.length) {
          const waiting = fullTask.dependedBy.filter(
            (d) => d.status !== "done" && d.status !== "closed"
          );
          if (waiting.length > 0) {
            const names = waiting.map((d) => `"${d.title}"`).join(", ");
            hints.push(`IMPORTANT: Downstream tasks are waiting on this one: ${names}. After completion, an admin or human must verify this task to done to unblock them.`);
          }
        }

        if (hints.length > 0) {
          compact._hints = hints;
        }

        return {
          content: [{ type: "text", text: JSON.stringify(compact, null, 2) }],
        };
      } catch (e) {
        if (e instanceof AlreadyClaimedError) {
          return {
            content: [{ type: "text", text: "Task is already claimed and cannot be assigned" }],
            isError: true,
          };
        }
        throw e;
      }
    }
  );

  // ===== Elaboration Tools =====

  // chorus_pm_start_elaboration - Start elaboration for an Idea
  server.registerTool(
    "chorus_pm_start_elaboration",
    {
      description: "Start an elaboration round for an Idea. Creates structured questions for the Idea creator/stakeholder to answer, clarifying requirements before proposal creation. Recommended for every Idea. Structured elaboration improves Proposal quality and reduces rejection cycles. IMPORTANT: After this tool returns pending_answers, you MUST use an interactive prompt tool (e.g., AskUserQuestion in Claude Code) to present the questions to the user — do NOT display questions as plain text. Collect answers interactively, then call chorus_answer_elaboration. IMPORTANT: Even if the user discusses requirements with you outside of elaboration (e.g., in chat), you should still record key decisions and clarifications as elaboration rounds so they are persisted to the Idea as an audit trail. Do NOT include an 'Other' option — the UI automatically adds a free-text 'Other' option to every question.",
      inputSchema: z.object({
        ideaUuid: z.string().describe("Idea UUID"),
        depth: z.enum(["minimal", "standard", "comprehensive"]).describe("Elaboration depth level"),
        questions: zArray(z.object({
          id: z.string().describe("Unique question identifier"),
          text: z.string().describe("Question text"),
          category: z.enum(["functional", "non_functional", "business_context", "technical_context", "user_scenario", "scope"]).describe("Question category"),
          options: zArray(z.object({
            id: z.string().describe("Option identifier"),
            label: z.string().describe("Option label"),
            description: z.string().optional().describe("Option description"),
          })).describe("Answer options (2-5). Do NOT include 'Other' — the UI adds it automatically."),
          required: z.boolean().optional().describe("Whether the question is required (default: true)"),
        })).describe("Questions to ask (1-15 per round)"),
      }),
    },
    async ({ ideaUuid, depth, questions }) => {
      try {
        const round = await elaborationService.startElaboration({
          companyUuid: auth.companyUuid,
          ideaUuid,
          actorUuid: auth.actorUuid,
          actorType: "agent",
          depth,
          questions,
        });

        return {
          content: [{ type: "text", text: JSON.stringify(round, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed to start elaboration: ${error instanceof Error ? error.message : "Unknown error"}` }],
          isError: true,
        };
      }
    }
  );

  // chorus_pm_validate_elaboration - Validate answers from an elaboration round
  server.registerTool(
    "chorus_pm_validate_elaboration",
    {
      description: "Validate answers from an elaboration round. If no issues are found, the elaboration is marked as resolved. If issues exist, optionally provide follow-up questions for a new round. IMPORTANT: Before resolving (empty issues), always confirm with the user that they have no remaining concerns or topics to discuss.",
      inputSchema: z.object({
        ideaUuid: z.string().describe("Idea UUID"),
        roundUuid: z.string().describe("Elaboration round UUID"),
        issues: zArray(z.object({
          questionId: z.string().describe("Question ID with the issue"),
          type: z.enum(["contradiction", "ambiguity", "incomplete"]).describe("Issue type"),
          description: z.string().describe("Issue description"),
        })).describe("List of issues found (empty array = all valid)"),
        followUpQuestions: zArray(z.object({
          id: z.string().describe("Unique question identifier"),
          text: z.string().describe("Question text"),
          category: z.enum(["functional", "non_functional", "business_context", "technical_context", "user_scenario", "scope"]).describe("Question category"),
          options: zArray(z.object({
            id: z.string().describe("Option identifier"),
            label: z.string().describe("Option label"),
            description: z.string().optional().describe("Option description"),
          })).describe("Answer options (2-5). Do NOT include 'Other' — the UI adds it automatically."),
          required: z.boolean().optional().describe("Whether the question is required (default: true)"),
        })).optional().describe("Follow-up questions for next round (only when issues exist)"),
      }),
    },
    async ({ ideaUuid, roundUuid, issues, followUpQuestions }) => {
      try {
        const result = await elaborationService.validateElaboration({
          companyUuid: auth.companyUuid,
          ideaUuid,
          roundUuid,
          actorUuid: auth.actorUuid,
          actorType: "agent",
          issues,
          followUpQuestions,
        });

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed to validate elaboration: ${error instanceof Error ? error.message : "Unknown error"}` }],
          isError: true,
        };
      }
    }
  );

  // chorus_pm_skip_elaboration - Skip elaboration for an Idea
  server.registerTool(
    "chorus_pm_skip_elaboration",
    {
      description: "Skip elaboration for an Idea (marks as resolved with minimal depth). Use only for trivially clear Ideas (e.g., bug fixes with clear reproduction steps). A reason is required and logged in the activity stream. IMPORTANT: You MUST ask the user for permission before skipping — never skip on your own judgment alone. Prefer chorus_pm_start_elaboration for most Ideas.",
      inputSchema: z.object({
        ideaUuid: z.string().describe("Idea UUID"),
        reason: z.string().describe("Reason for skipping elaboration"),
      }),
    },
    async ({ ideaUuid, reason }) => {
      try {
        await elaborationService.skipElaboration({
          companyUuid: auth.companyUuid,
          ideaUuid,
          actorUuid: auth.actorUuid,
          actorType: "agent",
          reason,
        });

        return {
          content: [{ type: "text", text: JSON.stringify({ ideaUuid, action: "elaboration_skipped", reason }, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed to skip elaboration: ${error instanceof Error ? error.message : "Unknown error"}` }],
          isError: true,
        };
      }
    }
  );

  // chorus_move_idea - Move an Idea to a different project
  server.registerTool(
    "chorus_move_idea",
    {
      description: "Move an Idea to a different project within the same company. Also moves linked draft/pending Proposals.",
      inputSchema: z.object({
        ideaUuid: z.string().describe("Idea UUID"),
        targetProjectUuid: z.string().describe("Target Project UUID"),
      }),
    },
    async ({ ideaUuid, targetProjectUuid }) => {
      try {
        const updated = await ideaService.moveIdea(
          auth.companyUuid,
          ideaUuid,
          targetProjectUuid,
          auth.actorUuid,
          auth.type
        );

        return {
          content: [{ type: "text", text: JSON.stringify({ uuid: updated.uuid, project: updated.project }, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed to move Idea: ${error instanceof Error ? error.message : "Unknown error"}` }],
          isError: true,
        };
      }
    }
  );

  const hasAdminRole = auth.roles.some(r => r === "admin" || r === "admin_agent");

  // chorus_pm_reject_proposal - Reject a pending proposal (pending -> draft)
  server.registerTool(
    "chorus_pm_reject_proposal",
    {
      description: "Reject a Proposal (pending -> draft). PM agents can only reject their own proposals; admin agents can reject any proposal. After rejection, the Proposal returns to draft status for revision.",
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

      if (!hasAdminRole && proposal.createdByUuid !== auth.actorUuid) {
        return { content: [{ type: "text", text: "You can only reject your own proposals" }], isError: true };
      }

      if (proposal.status !== "pending") {
        return { content: [{ type: "text", text: `Can only reject pending Proposals, current status: ${proposal.status}` }], isError: true };
      }

      const updated = await proposalService.rejectProposal(
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
        action: "rejected_to_draft",
        value: { reviewNote },
      });

      return {
        content: [{ type: "text", text: JSON.stringify({ uuid: updated.uuid, status: updated.status }) }],
      };
    }
  );

  // chorus_pm_revoke_proposal - Revoke an approved proposal (approved -> draft)
  server.registerTool(
    "chorus_pm_revoke_proposal",
    {
      description: "Revoke an approved Proposal (approved -> draft). PM agents can only revoke their own proposals; admin agents can revoke any proposal. Cascade-closes all materialized Tasks and deletes all materialized Documents.",
      inputSchema: z.object({
        proposalUuid: z.string().describe("Proposal UUID"),
        reviewNote: z.string().optional().describe("Reason for revoking (optional)"),
      }),
    },
    async ({ proposalUuid, reviewNote }) => {
      const proposal = await proposalService.getProposalByUuid(auth.companyUuid, proposalUuid);
      if (!proposal) {
        return { content: [{ type: "text", text: "Proposal not found" }], isError: true };
      }

      if (!hasAdminRole && proposal.createdByUuid !== auth.actorUuid) {
        return { content: [{ type: "text", text: "You can only revoke your own proposals" }], isError: true };
      }

      if (proposal.status !== "approved") {
        return { content: [{ type: "text", text: `Can only revoke approved Proposals, current status: ${proposal.status}` }], isError: true };
      }

      const result = await proposalService.revokeProposal(
        proposal.uuid,
        auth.companyUuid,
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
        action: "revoked",
        value: {
          reviewNote,
          closedTaskCount: result.closedTasks.length,
          deletedDocumentCount: result.deletedDocuments.length,
        },
      });

      return {
        content: [{ type: "text", text: JSON.stringify({
          uuid: result.proposalUuid,
          status: "draft",
          closedTasks: result.closedTasks,
          deletedDocuments: result.deletedDocuments,
        }, null, 2) }],
      };
    }
  );

  // chorus_pm_create_idea - Create an Idea
  server.registerTool(
    "chorus_pm_create_idea",
    {
      description: "Create an Idea (submits requirements on behalf of humans)",
      inputSchema: z.object({
        projectUuid: z.string().describe("Project UUID"),
        title: z.string().describe("Idea title"),
        content: z.string().optional().describe("Idea detailed description"),
      }),
    },
    async ({ projectUuid, title, content }) => {
      const exists = await projectExists(auth.companyUuid, projectUuid);
      if (!exists) {
        return { content: [{ type: "text", text: "Project not found" }], isError: true };
      }

      const idea = await ideaService.createIdea({
        companyUuid: auth.companyUuid,
        projectUuid,
        title,
        content: content || null,
        createdByUuid: auth.actorUuid,
      });

      return {
        content: [{ type: "text", text: JSON.stringify({ uuid: idea.uuid, title: idea.title }) }],
      };
    }
  );
}
