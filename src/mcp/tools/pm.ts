// src/mcp/tools/pm.ts
// PM Agent MCP Tools (ARCHITECTURE.md §5.2)
// UUID-Based Architecture: All operations use UUIDs

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AgentAuthContext } from "@/types/auth";
import { projectExists } from "@/services/project.service";
import * as ideaService from "@/services/idea.service";
import * as proposalService from "@/services/proposal.service";
import * as documentService from "@/services/document.service";
import * as taskService from "@/services/task.service";
import * as referenceArtifactService from "@/services/reference-artifact.service";
import {
  REFERENCE_TYPES,
  REFERENCE_TARGET_TYPES,
} from "@/services/reference-artifact.service";
import * as activityService from "@/services/activity.service";
import * as elaborationService from "@/services/elaboration.service";
import { getAgentByUuid } from "@/services/agent.service";
import { getUserByUuid } from "@/services/user.service";
import { AlreadyClaimedError, NotClaimedError } from "@/lib/errors";
import {
  isAssignmentOwnedByActor,
  resolveAssigneeAgentUuid,
} from "@/lib/uuid-resolver";
import { zArray } from "./schema-utils";
import { registerPermissionedTool } from "./register-helpers";
import { hasPermission } from "@/lib/auth";
import { computeEffectivePermissions } from "@/lib/authz/permissions";
import { enforceToolClassification } from "./collection-contract";
import { resolveProjectAgentCwdTarget } from "@/services/project-agent-cwd.service";

export function registerPmTools(server: McpServer, auth: AgentAuthContext) {
  server = enforceToolClassification(server);
  // Zod enums derived from the service's allowed sets so the tool schema and the
  // service validation never drift. z.enum needs a non-empty tuple. Declared at
  // the top of the function (not beside the reference write tools) so the create
  // tools registered above them can reuse `referenceTypeEnum` for the inline
  // `references[]` param without a temporal-dead-zone reference.
  const referenceTypeEnum = z.enum(
    REFERENCE_TYPES as unknown as [string, ...string[]]
  );
  const referenceTargetTypeEnum = z.enum(
    REFERENCE_TARGET_TYPES as unknown as [string, ...string[]]
  );

  // Inline reference item shape (Thread C) reused by chorus_pm_create_idea and
  // chorus_pm_create_proposal. Matches the createReferences helper's
  // ReferenceCreateItem ({ type, url, title, notes? }).
  const referenceInlineItemSchema = z.object({
    type: referenceTypeEnum.describe("Reference type: docs, repo, issue_pr, or paper_blog"),
    url: z.string().describe("Web URL (http:// or https://)"),
    title: z.string().describe("Reference title"),
    notes: z.string().optional().describe("Optional one-line summary of why this reference is relevant — keep it to a single concise sentence (~200 chars, ≤2 lines); the UI clamps the display to 2 lines. Stored verbatim; no fetch."),
  });

  // chorus_claim_idea - Claim an Idea
  registerPermissionedTool(
    server,
    auth,
    "idea:write",
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
  registerPermissionedTool(
    server,
    auth,
    "idea:write",
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

      // Check if the caller is the assignee. Routes through the shared helper so
      // an `agent_instance` assignment owned by this agent also passes (its
      // assigneeUuid is an instance uuid, resolved back to the agent first).
      const isAssignee = await isAssignmentOwnedByActor(auth, idea.assigneeType, idea.assigneeUuid);

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
  registerPermissionedTool(
    server,
    auth,
    "proposal:write",
    "chorus_pm_create_proposal",
    {
      description: "Create an empty Proposal container. Use chorus_pm_add_document_draft and chorus_pm_add_task_draft to populate it afterwards. Optional `references[]` attaches reference artifacts (external evidence — web link + optional notes) to the new proposal inline; a bad reference is skipped and reported in `referenceErrors` without failing proposal creation.",
      inputSchema: z.object({
        projectUuid: z.string().describe("Project UUID"),
        title: z.string().describe("Proposal title"),
        description: z.string().optional().describe("Proposal description"),
        inputType: z.enum(["idea", "document"]).describe("Input source type"),
        inputUuids: zArray(z.string()).describe("Input UUID list"),
        references: zArray(referenceInlineItemSchema).optional().describe("Optional reference artifacts to attach to the new proposal (fail-soft per item)"),
      }),
    },
    async ({ projectUuid, title, description, inputType, inputUuids, references }) => {
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

      // Inline references (Thread C): materialize AFTER the proposal row exists
      // so targetUuid is the real DB-generated uuid. Fail-soft — a bad ref is
      // reported, never aborts proposal creation.
      const refResult = await referenceArtifactService.createReferences(
        auth.companyUuid,
        "proposal",
        proposal.uuid,
        references,
        { type: "agent", uuid: auth.actorUuid }
      );

      const payload: Record<string, unknown> = {
        uuid: proposal.uuid,
        title: proposal.title,
        status: proposal.status,
      };
      if (refResult.errors.length > 0) payload.referenceErrors = refResult.errors;

      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) + reusedWarning }],
      };
    }
  );

  // chorus_pm_validate_proposal - Validate Proposal completeness
  registerPermissionedTool(
    server,
    auth,
    "proposal:write",
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
  registerPermissionedTool(
    server,
    auth,
    "proposal:write",
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
  registerPermissionedTool(
    server,
    auth,
    "document:write",
    "chorus_pm_create_document",
    {
      description: "Create a document (type is one of: prd, tech_design, adr, spec, guide). Idea-completion reports use a dedicated tool (`chorus_create_report`) and are not creatable here.",
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

  // chorus_pm_update_document - Update document content
  registerPermissionedTool(
    server,
    auth,
    "document:write",
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

  // ===== Reference Artifact Tools =====
  //
  // First-class external evidence (GH #399 point 2) linked to an idea/proposal/task.
  // Write-only surface — there is deliberately NO standalone read tool (q6=a);
  // agents read references inline via the `references` array on
  // chorus_get_idea / chorus_get_proposal / chorus_get_task. All three reuse the
  // `document` bits (document:write) — no new permission resource, matching
  // chorus_create_report. The referenceTypeEnum / referenceTargetTypeEnum /
  // referenceInlineItemSchema helpers are declared at the top of registerPmTools
  // (shared with the inline references[] param on the create tools).

  // chorus_add_reference - Attach a reference artifact to an idea, proposal, or task
  registerPermissionedTool(
    server,
    auth,
    "document:write",
    "chorus_add_reference",
    {
      description:
        "Attach external evidence (a web link + optional notes) to an idea, proposal, or task, for post-hoc attach. Prefer the inline `references[]` param on chorus_pm_create_idea / chorus_pm_create_proposal / chorus_create_tasks when attaching at creation time; references are read back inline via chorus_get_idea / _get_proposal / _get_task (no separate read tool).",
      inputSchema: z.object({
        targetType: referenceTargetTypeEnum.describe("Target type: idea, proposal, or task"),
        targetUuid: z.string().describe("UUID of the idea, proposal, or task to attach to"),
        type: referenceTypeEnum.describe("Reference type: docs (official documentation), repo (reference implementation), issue_pr (issue/PR thread), or paper_blog (paper/blog post)"),
        url: z.string().describe("Web URL (http:// or https://; no local files — never fetched)"),
        title: z.string().describe("Reference title"),
        notes: z.string().optional().describe("Optional one-line summary of why this reference is relevant — keep it to a single concise sentence (~200 chars, ≤2 lines); the UI clamps the display to 2 lines. Stored verbatim; no fetch."),
      }),
    },
    async ({ targetType, targetUuid, type, url, title, notes }) => {
      try {
        const reference = await referenceArtifactService.createReference({
          companyUuid: auth.companyUuid,
          targetType,
          targetUuid,
          type,
          url,
          title,
          notes: notes ?? null,
          createdByType: "agent",
          createdByUuid: auth.actorUuid,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(reference, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed to add reference: ${error instanceof Error ? error.message : "Unknown error"}` }],
          isError: true,
        };
      }
    }
  );

  // chorus_update_reference - Edit a reference artifact's type/url/title/notes
  registerPermissionedTool(
    server,
    auth,
    "document:write",
    "chorus_update_reference",
    {
      description:
        "Update a reference artifact. Provide the reference `uuid` plus any of type/url/title/notes to change; omitted fields are left unchanged. type and url are re-validated when present.",
      inputSchema: z.object({
        uuid: z.string().describe("Reference artifact UUID"),
        type: referenceTypeEnum.optional().describe("New reference type"),
        url: z.string().optional().describe("New web URL (http:// or https://)"),
        title: z.string().optional().describe("New title"),
        notes: z.string().nullable().optional().describe("New notes — one concise sentence (~200 chars, ≤2 lines; the UI clamps the display to 2 lines). null clears; omit to leave unchanged."),
      }),
    },
    async ({ uuid, type, url, title, notes }) => {
      try {
        const reference = await referenceArtifactService.updateReference(
          auth.companyUuid,
          uuid,
          {
            ...(type !== undefined ? { type } : {}),
            ...(url !== undefined ? { url } : {}),
            ...(title !== undefined ? { title } : {}),
            ...(notes !== undefined ? { notes } : {}),
          }
        );
        return {
          content: [{ type: "text", text: JSON.stringify(reference, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed to update reference: ${error instanceof Error ? error.message : "Unknown error"}` }],
          isError: true,
        };
      }
    }
  );

  // chorus_remove_reference - Detach/delete a reference artifact
  registerPermissionedTool(
    server,
    auth,
    "document:write",
    "chorus_remove_reference",
    {
      description: "Remove (detach and delete) a reference artifact by its UUID.",
      inputSchema: z.object({
        uuid: z.string().describe("Reference artifact UUID"),
      }),
    },
    async ({ uuid }) => {
      try {
        await referenceArtifactService.deleteReference(auth.companyUuid, uuid);
        return {
          content: [{ type: "text", text: JSON.stringify({ uuid, action: "reference_removed" }, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed to remove reference: ${error instanceof Error ? error.message : "Unknown error"}` }],
          isError: true,
        };
      }
    }
  );

  // ===== Proposal Draft Management Tools =====

  // chorus_pm_add_document_draft - Add document draft to Proposal
  registerPermissionedTool(
    server,
    auth,
    "proposal:write",
    "chorus_pm_add_document_draft",
    {
      description: "Add a document draft to a pending Proposal container",
      inputSchema: z.object({
        proposalUuid: z.string().describe("Proposal UUID"),
        type: z.enum(["prd", "tech_design", "adr", "spec", "guide", "report"]).describe("Document type"),
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
  registerPermissionedTool(
    server,
    auth,
    "proposal:write",
    "chorus_pm_add_task_draft",
    {
      description: "Add a task draft to a pending Proposal container. Acceptance criteria are required: acceptanceCriteriaItems must contain at least one item with a non-blank description.",
      inputSchema: z.object({
        proposalUuid: z.string().describe("Proposal UUID"),
        title: z.string().describe("Task title"),
        description: z.string().optional().describe("Task description"),
        storyPoints: z.number().optional().describe("Effort estimate (agent hours)"),
        priority: z.enum(["low", "medium", "high"]).optional().describe("Priority"),
        acceptanceCriteriaItems: zArray(z.object({
          description: z.string().describe("Criterion description"),
          required: z.boolean().optional().describe("Whether this criterion is required (default: true)"),
        })).optional().describe("Structured acceptance criteria items (materialized on approval) — REQUIRED: at least one item with a non-blank description, or the call is rejected"),
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
  registerPermissionedTool(
    server,
    auth,
    "proposal:write",
    "chorus_pm_update_document_draft",
    {
      description: "Update a document draft in a Proposal",
      inputSchema: z.object({
        proposalUuid: z.string().describe("Proposal UUID"),
        draftUuid: z.string().describe("Document draft UUID"),
        type: z.enum(["prd", "tech_design", "adr", "spec", "guide", "report"]).optional().describe("Document type"),
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
  registerPermissionedTool(
    server,
    auth,
    "proposal:write",
    "chorus_pm_update_task_draft",
    {
      description: "Update a task draft in a Proposal. Partial-update semantics: omit acceptanceCriteriaItems to leave existing criteria unchanged; if provided it replaces them and must be non-empty (cannot clear acceptance criteria).",
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
        })).optional().describe("Structured acceptance criteria items. If provided, replaces existing items and must be non-empty (at least one non-blank description); if omitted, existing items are preserved. Cannot be used to clear acceptance criteria."),
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
  registerPermissionedTool(
    server,
    auth,
    "proposal:write",
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
  registerPermissionedTool(
    server,
    auth,
    "proposal:write",
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

  // chorus_pm_assign_task - Assign task to a Developer Agent
  registerPermissionedTool(
    server,
    auth,
    "proposal:write",
    "chorus_pm_assign_task",
    {
      description: "Assign a task to an agent that has task:write permission; the task must be in open or assigned status. Optionally pin it to a specific AgentInstance via `instanceUuid`.",
      inputSchema: z.object({
        taskUuid: z.string().describe("Task UUID"),
        agentUuid: z.string().describe("Target Agent UUID (must have task:write permission)"),
        instanceUuid: z
          .string()
          .nullish()
          .describe("Optional AgentInstance UUID — the durable (agent, host, cwd) identity from chorus presence/daemon tools. When provided the task is assigned as `agent_instance` and the autonomous wake targets that instance; omit for a plain `agent` assignment whose wake-time instance is inherited from the root idea. The instance must belong to the target agent's company, else the call is rejected."),
      }),
    },
    async ({ taskUuid, agentUuid, instanceUuid }) => {
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

      // Validate target agent exists and belongs to the same company.
      const targetAgent = await getAgentByUuid(auth.companyUuid, agentUuid);
      if (!targetAgent) {
        return { content: [{ type: "text", text: "Target Agent not found" }], isError: true };
      }

      // Gate by permission, not by legacy role preset name — custom-
      // configured agents that hold task:write are eligible too.
      const targetPerms = computeEffectivePermissions(
        targetAgent.roles,
        targetAgent.permissions,
      );
      if (!targetPerms.has("task:write")) {
        return {
          content: [{ type: "text", text: `Agent "${targetAgent.name}" does not have task:write permission` }],
          isError: true,
        };
      }

      // Execute assignment. When an instanceUuid is supplied, claimTask validates
      // it belongs to this company and persists the task as an `agent_instance`
      // assignment (assigneeUuid = the instance uuid); when omitted the task is a
      // plain `agent` assignment, byte-identical to before this change. Pass the
      // field only when set so an un-pinned assignment's args are unchanged.
      try {
        await taskService.claimTask({
          taskUuid: task.uuid,
          companyUuid: auth.companyUuid,
          assigneeType: "agent",
          assigneeUuid: agentUuid,
          assignedByType: "agent",
          assignedByUuid: auth.actorUuid,
          ...(instanceUuid != null ? { instanceUuid } : {}),
        });

        // Log activity. Record the resolved assignee type and the pinned instance
        // uuid (when any) so the timeline reflects the agent_instance assignment.
        await activityService.createActivity({
          companyUuid: auth.companyUuid,
          projectUuid: task.projectUuid,
          targetType: "task",
          targetUuid: task.uuid,
          actorType: "agent",
          actorUuid: auth.actorUuid,
          action: "assigned",
          value: {
            assigneeType: instanceUuid != null ? "agent_instance" : "agent",
            assigneeUuid: instanceUuid != null ? instanceUuid : agentUuid,
            agentUuid,
            assignedBy: auth.actorUuid,
            ...(instanceUuid != null ? { instanceUuid } : {}),
          },
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
        // A non-existent / foreign-company instance pin is rejected by the
        // service with a plain Error; surface it as a tool error, not a throw.
        if (e instanceof Error && e.message === "Agent instance not found") {
          return {
            content: [{ type: "text", text: "Agent instance not found" }],
            isError: true,
          };
        }
        throw e;
      }
    }
  );

  // chorus_pm_assign_idea - Assign an Idea to an agent or user (MCP surface over
  // the human assign-idea action). Reuses ideaService.assignIdea (reassign-safe
  // silent takeover; open→elaborating else status preserved) and — CRITICALLY —
  // emits the actor-bearing `assigned` Activity that drives the existing
  // idea_claimed wake. This is NOT new wake plumbing: it mirrors
  // claimIdeaToAgentAction (actions.ts:107-127) with actorType:"agent".
  registerPermissionedTool(
    server,
    auth,
    "idea:admin",
    "chorus_pm_assign_idea",
    {
      description: "Assign an Idea to an agent (must hold idea:write) or a user, on a human's behalf. Silently takes over any existing assignee; an `open` Idea moves to `elaborating`, any other status is preserved. Agent assignments automatically pin to the caller owner's project-fixed cwd target when configured, overriding `instanceUuid`; otherwise an optional `instanceUuid` persists an `agent_instance` pin. A new logical agent assignee requests a wake; assigning the same agent again may update its pin/cwd but is deduplicated and does not request another wake. Assigning to a user sets the assignee and notifies the user with no daemon wake.",
      inputSchema: z.object({
        ideaUuid: z.string().describe("Idea UUID"),
        assigneeType: z.enum(["agent", "user"]).describe("Assignee type: agent or user"),
        assigneeUuid: z.string().describe("Target Agent UUID or User UUID, per assigneeType"),
        instanceUuid: z
          .string()
          .nullish()
          .describe("Optional AgentInstance UUID — only valid when assigneeType=\"agent\". A configured project-fixed cwd target takes precedence and supplies the effective instance automatically; otherwise this pins the Idea to that durable (agent, host, cwd) instance. When used, the instance must belong to the target agent's company, else the call is rejected. Rejected if supplied with assigneeType=\"user\"."),
      }),
    },
    async ({ ideaUuid, assigneeType, assigneeUuid, instanceUuid }) => {
      // Validate the idea exists in this company (clear 404 vs a raw Prisma error).
      const idea = await ideaService.getIdeaByUuid(auth.companyUuid, ideaUuid);
      if (!idea) {
        return { content: [{ type: "text", text: "Idea not found" }], isError: true };
      }

      // Validate the target per assigneeType.
      if (assigneeType === "agent") {
        // Target agent must exist in this company AND hold idea:write. Reuse the
        // same effective-permission gate the human claim route uses
        // (route.ts:80-88) — gate by permission, not by legacy role preset name,
        // so a custom agent that holds idea:write directly is eligible too.
        const targetAgent = await getAgentByUuid(auth.companyUuid, assigneeUuid);
        if (!targetAgent) {
          return { content: [{ type: "text", text: "Target Agent not found" }], isError: true };
        }
        const targetPerms = computeEffectivePermissions(
          targetAgent.roles,
          targetAgent.permissions,
        );
        if (!targetPerms.has("idea:write")) {
          return {
            content: [{ type: "text", text: `Agent "${targetAgent.name}" does not have idea:write permission` }],
            isError: true,
          };
        }
      } else {
        // User target — must belong to this company. `instanceUuid` is only
        // meaningful for an agent target; reject it here rather than let it
        // silently promote the row to agent_instance (resolveAssigneeFields
        // ignores assigneeType when a pin is present).
        if (instanceUuid != null) {
          return {
            content: [{ type: "text", text: "instanceUuid is only valid when assigneeType is \"agent\"" }],
            isError: true,
          };
        }
        const targetUser = await getUserByUuid(assigneeUuid);
        if (!targetUser || targetUser.companyUuid !== auth.companyUuid) {
          return { content: [{ type: "text", text: "Target User not found" }], isError: true };
        }
      }

      // Resolve the same immutable project target snapshot as the UI action. A
      // project-fixed owner preference deliberately wins over a caller-supplied
      // instance so MCP and UI cannot route the same project to different roots.
      const resolvedTarget =
        assigneeType === "agent" && auth.ownerUuid
          ? await resolveProjectAgentCwdTarget({
              companyUuid: auth.companyUuid,
              actorUserUuid: auth.ownerUuid,
              projectUuid: idea.projectUuid,
              agentUuid: assigneeUuid,
            })
          : null;
      const usesProjectFixedTarget =
        resolvedTarget?.source === "project_fixed";
      const effectiveInstanceUuid =
        assigneeType === "agent"
          ? usesProjectFixedTarget
            ? resolvedTarget.agentInstanceUuid
            : instanceUuid
          : null;
      const currentAssigneeAgentUuid =
        assigneeType === "agent"
          ? await resolveAssigneeAgentUuid(
              auth.companyUuid,
              idea.assigneeType,
              idea.assigneeUuid,
            )
          : null;
      const isSameLogicalAgentAssignee =
        assigneeType === "agent" &&
        currentAssigneeAgentUuid === assigneeUuid;
      const shouldEmitAssignedActivity =
        assigneeType !== "agent" || !isSameLogicalAgentAssignee;

      // Execute the assignment. assignIdea is reassign-safe (silent takeover;
      // open→elaborating else status preserved) and applies the effective instance
      // pin via resolveAssigneeFields (validates company ownership → agent_instance).
      try {
        const updated = await ideaService.assignIdea({
          ideaUuid: idea.uuid,
          companyUuid: auth.companyUuid,
          assigneeType,
          assigneeUuid,
          assignedByType: "agent",
          assignedByUuid: auth.actorUuid,
          ...(effectiveInstanceUuid != null
            ? { instanceUuid: effectiveInstanceUuid }
            : {}),
          cwdSource: usesProjectFixedTarget ? resolvedTarget.source : null,
          cwdHost: usesProjectFixedTarget ? resolvedTarget.host : null,
          runtimeCwd: usesProjectFixedTarget ? resolvedTarget.cwd : null,
        });

        // The actor-bearing `assigned` Activity triggers the idea_claimed wake
        // (agent) / assignment notification (user). Keep that side effect for a
        // newly responsible agent, but deduplicate same-owning-agent re-pins:
        // assignIdea still persists the effective target while no second daemon
        // turn is born merely because its instance/cwd changed.
        if (shouldEmitAssignedActivity) {
          await activityService.createActivity({
            companyUuid: auth.companyUuid,
            projectUuid: idea.projectUuid,
            targetType: "idea",
            targetUuid: idea.uuid,
            actorType: "agent",
            actorUuid: auth.actorUuid,
            action: "assigned",
            value: {
              assigneeType,
              assigneeUuid,
              ...(effectiveInstanceUuid != null
                ? { instanceUuid: effectiveInstanceUuid }
                : {}),
              ...(usesProjectFixedTarget
                ? {
                    resolvedCwdSource: resolvedTarget.source,
                    resolvedCwdHost: resolvedTarget.host,
                    resolvedRuntimeCwd: resolvedTarget.cwd,
                  }
                : {}),
            },
          });
        }

        return {
          content: [{ type: "text", text: JSON.stringify({
            uuid: updated.uuid,
            status: updated.status,
            assignee: updated.assignee
              ? { type: updated.assignee.type, uuid: updated.assignee.uuid }
              : null,
            wakeRequested:
              assigneeType === "agent" && shouldEmitAssignedActivity,
            target: assigneeType === "agent"
              ? {
                  instanceUuid: effectiveInstanceUuid ?? null,
                  resolvedCwdSource: usesProjectFixedTarget
                    ? resolvedTarget.source
                    : null,
                  resolvedCwdHost: usesProjectFixedTarget
                    ? resolvedTarget.host
                    : null,
                  resolvedRuntimeCwd: usesProjectFixedTarget
                    ? resolvedTarget.cwd
                    : null,
                }
              : null,
          }, null, 2) }],
        };
      } catch (e) {
        // A non-existent / foreign-company instance pin is rejected by the service
        // with a plain Error; surface it as a tool error, not a throw.
        if (e instanceof Error && e.message === "Agent instance not found") {
          return { content: [{ type: "text", text: "Agent instance not found" }], isError: true };
        }
        throw e;
      }
    }
  );

  // ===== Elaboration Tools =====

  // chorus_pm_start_elaboration - Start elaboration for an Idea
  registerPermissionedTool(
    server,
    auth,
    "idea:write",
    "chorus_pm_start_elaboration",
    {
      description: "Open a round of structured questions on an Idea to clarify requirements before a proposal is written; recommended for every Idea. Record decisions here even when requirements were discussed outside the tool (chat) — this round is the persisted audit trail.",
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
          })).describe("Answer options (2-5). Do NOT include an 'Other' option — the UI adds a free-text 'Other' to every question automatically."),
          required: z.boolean().optional().describe("Whether the question is required (default: true)"),
        })).describe("Questions to ask (1-15 per round). Present these to the user via an interactive prompt (not plain text), then submit their answers with chorus_answer_elaboration."),
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

  // chorus_pm_validate_elaboration - Mark an Idea's whole elaboration complete.
  // Idea-level resolve: it does not target a single round (the backing service
  // fn is resolveElaboration). Requires every round to be answered.
  registerPermissionedTool(
    server,
    auth,
    "idea:admin",
    "chorus_pm_validate_elaboration",
    {
      description: "Mark an Idea's elaboration complete (Idea -> elaborated, elaborationStatus -> resolved). Operates on the whole Idea — takes only ideaUuid. Requires every elaboration round to be answered. Requires human confirmation before calling (except in YOLO mode). The caller may be the Idea's assignee (logs elaboration_resolved) OR a non-assignee idea:admin gateway resolving an Idea assigned to another agent — the gateway path wakes the assignee to write the proposal (MCP parity with the UI Verify-Elaborate handoff).",
      inputSchema: z.object({
        ideaUuid: z.string().describe("Idea UUID"),
      }),
    },
    async ({ ideaUuid }) => {
      try {
        const result = await elaborationService.resolveElaboration({
          companyUuid: auth.companyUuid,
          ideaUuid,
          actorUuid: auth.actorUuid,
          actorType: "agent",
          actorIsIdeaAdmin: hasPermission(auth, "idea:admin"),
        });

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed to resolve elaboration: ${error instanceof Error ? error.message : "Unknown error"}` }],
          isError: true,
        };
      }
    }
  );

  // chorus_pm_skip_elaboration - Skip elaboration for an Idea
  registerPermissionedTool(
    server,
    auth,
    "idea:write",
    "chorus_pm_skip_elaboration",
    {
      description: "Skip elaboration for an Idea (marks as resolved with minimal depth). Use only for trivially clear Ideas (e.g., bug fixes with clear reproduction steps). A reason is required and logged in the activity stream. IMPORTANT: You MUST ask the user for permission before skipping — never skip on your own judgment alone. Prefer chorus_pm_start_elaboration for most Ideas. The caller may be the Idea's assignee, OR a non-assignee holding idea:admin skipping an Idea assigned to another agent — the gateway path wakes the assignee to write the proposal (parity with the gateway resolve path).",
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
          actorIsIdeaAdmin: hasPermission(auth, "idea:admin"),
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
  registerPermissionedTool(
    server,
    auth,
    "idea:write",
    "chorus_move_idea",
    {
      description: "Move an Idea to another project, cascading its full lineage subtree (all descendant Ideas) plus every moved Idea's Proposals/Documents/Tasks/Activities. The moved root detaches from any parent left behind. Returns the updated Idea + `moved: { ideas, proposals, documents, tasks, activities }` counts.",
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

        // Surface both the updated idea identity and the cascade counts so
        // calling agents can render a human-readable summary without a second
        // round-trip. `moved` is the authoritative count from the transaction.
        return {
          content: [{ type: "text", text: JSON.stringify({ uuid: updated.uuid, project: updated.project, moved: updated.moved }, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed to move Idea: ${error instanceof Error ? error.message : "Unknown error"}` }],
          isError: true,
        };
      }
    }
  );

  // Proposal admin can reject/revoke any proposal; otherwise PM agents can only
  // touch their own. `proposal:admin` aligns with chorus_admin_approve_proposal
  // and avoids conflating bypass-power with the `admin_agent` preset.
  const canAdminAnyProposal = hasPermission(auth, "proposal:admin");

  // chorus_pm_reject_proposal - Reject a pending proposal (pending -> draft)
  registerPermissionedTool(
    server,
    auth,
    "proposal:write",
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

      if (!canAdminAnyProposal && proposal.createdByUuid !== auth.actorUuid) {
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
  registerPermissionedTool(
    server,
    auth,
    "proposal:write",
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

      if (!canAdminAnyProposal && proposal.createdByUuid !== auth.actorUuid) {
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
  registerPermissionedTool(
    server,
    auth,
    "idea:write",
    "chorus_pm_create_idea",
    {
      description: "Create an Idea (submits requirements on behalf of humans). Optional parentUuid derives it from an existing same-project idea (single-parent lineage). Optional isContainer marks it as a theme (groups derived children; may elaborate but cannot create a proposal). Optional `references[]` attaches reference artifacts (external evidence — web link + optional notes) to the new idea inline; a bad reference is skipped and reported in `referenceErrors` without failing idea creation.",
      inputSchema: z.object({
        projectUuid: z.string().describe("Project UUID"),
        title: z.string().describe("Idea title"),
        content: z.string().optional().describe("Idea detailed description"),
        parentUuid: z.string().optional().describe("Same-project parent Idea to derive from (single-parent lineage)"),
        isContainer: z.boolean().optional().describe("Mark as a theme (groups derived children; may elaborate but MUST NOT create a proposal). Defaults to false."),
        references: zArray(referenceInlineItemSchema).optional().describe("Optional reference artifacts to attach to the new idea (fail-soft per item)"),
      }),
    },
    async ({ projectUuid, title, content, parentUuid, isContainer, references }) => {
      const exists = await projectExists(auth.companyUuid, projectUuid);
      if (!exists) {
        return { content: [{ type: "text", text: "Project not found" }], isError: true };
      }

      try {
        const idea = await ideaService.createIdea({
          companyUuid: auth.companyUuid,
          projectUuid,
          title,
          content: content || null,
          createdByUuid: auth.actorUuid,
          parentUuid: parentUuid ?? null,
          isContainer,
        });

        // Inline references (Thread C): materialize AFTER the idea row exists so
        // targetUuid is the real DB-generated uuid. Fail-soft — a bad ref is
        // reported, never aborts idea creation.
        const refResult = await referenceArtifactService.createReferences(
          auth.companyUuid,
          "idea",
          idea.uuid,
          references,
          { type: "agent", uuid: auth.actorUuid }
        );

        const payload: Record<string, unknown> = {
          uuid: idea.uuid,
          title: idea.title,
          parentUuid: idea.parentUuid ?? null,
        };
        if (refResult.errors.length > 0) payload.referenceErrors = refResult.errors;

        return {
          content: [{ type: "text", text: JSON.stringify(payload) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed to create Idea: ${error instanceof Error ? error.message : "Unknown error"}` }],
          isError: true,
        };
      }
    }
  );

  // chorus_edit_idea - Edit an Idea's title, content, and/or lineage parent.
  //
  // Implementation note (not exposed to callers): a parent change is applied
  // first via the cycle-checked setIdeaParent, then the title/content edit via
  // updateIdea. These are two independent writes (not one transaction), so a
  // rare partial failure could persist the reparent while the title/content
  // edit fails. Acceptable given they're independent edits; kept out of the
  // tool description to avoid burning tokens on every tool-list load.
  registerPermissionedTool(
    server,
    auth,
    "idea:write",
    "chorus_edit_idea",
    {
      description: "Edit an existing Idea's title, description (content), lineage parent (`parentUuid`), and/or theme flag (`isContainer`). Provide at least one field. Does not change status.",
      inputSchema: z.object({
        ideaUuid: z.string().describe("Idea UUID to edit"),
        title: z.string().optional().describe("New title (omit to leave unchanged)"),
        content: z.string().optional().describe("New description (omit to leave unchanged)"),
        parentUuid: z.string().nullable().optional().describe("Same-project parent Idea to reparent under; null detaches to top-level; omit to leave unchanged"),
        isContainer: z.boolean().optional().describe("Mark/unmark as a theme (groups derived children; may elaborate but MUST NOT create a proposal). Freely reversible; omit to leave unchanged."),
      }),
    },
    async ({ ideaUuid, title, content, parentUuid, isContainer }) => {
      if (title === undefined && content === undefined && parentUuid === undefined && isContainer === undefined) {
        return {
          content: [{ type: "text", text: "Provide at least one of title, content, parentUuid, or isContainer to edit." }],
          isError: true,
        };
      }
      // Confirm the idea exists in this company before editing (clear 404 vs a
      // raw Prisma error on a bad uuid).
      const existing = await ideaService.getIdeaByUuid(auth.companyUuid, ideaUuid);
      if (!existing) {
        return { content: [{ type: "text", text: "Idea not found" }], isError: true };
      }
      try {
        // Lineage parent change goes through setIdeaParent so the cycle +
        // same-project guards apply (a bare update would let a cyclic edge in).
        // Only invoked when parentUuid is explicitly present (null = detach).
        let resolvedParentUuid = existing.parentUuid ?? null;
        if (parentUuid !== undefined) {
          const reparented = await ideaService.setIdeaParent(ideaUuid, parentUuid ?? null, auth.companyUuid, { actorType: "agent", actorUuid: auth.actorUuid });
          resolvedParentUuid = reparented.parentUuid ?? null;
        }

        // Title/content/container edit (title/content changes record the
        // "edited" activity). Skipped when only the parent changed.
        let title_ = existing.title;
        if (title !== undefined || content !== undefined || isContainer !== undefined) {
          const updated = await ideaService.updateIdea(
            ideaUuid,
            auth.companyUuid,
            {
              ...(title !== undefined ? { title } : {}),
              ...(content !== undefined ? { content: content || null } : {}),
              ...(isContainer !== undefined ? { isContainer } : {}),
            },
            { actorType: "agent", actorUuid: auth.actorUuid },
          );
          title_ = updated.title;
        }

        return {
          content: [{ type: "text", text: JSON.stringify({ uuid: ideaUuid, title: title_, parentUuid: resolvedParentUuid }) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed to edit Idea: ${error instanceof Error ? error.message : "Unknown error"}` }],
          isError: true,
        };
      }
    }
  );
}
