// src/mcp/tools/developer.ts
// Developer Agent MCP Tools (ARCHITECTURE.md §5.2)
// UUID-Based Architecture: All operations use UUIDs

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AgentAuthContext } from "@/types/auth";
import * as taskService from "@/services/task.service";
import * as activityService from "@/services/activity.service";
import * as commentService from "@/services/comment.service";
import * as sessionService from "@/services/session.service";
import { AlreadyClaimedError, NotClaimedError } from "@/lib/errors";
import { zArray } from "./schema-utils";

export function registerDeveloperTools(server: McpServer, auth: AgentAuthContext) {
  // chorus_claim_task - Claim a Task
  server.registerTool(
    "chorus_claim_task",
    {
      description: "Claim a Task (open -> assigned)",
      inputSchema: z.object({
        taskUuid: z.string().describe("Task UUID"),
      }),
    },
    async ({ taskUuid }) => {
      const task = await taskService.getTaskByUuid(auth.companyUuid, taskUuid);
      if (!task) {
        return { content: [{ type: "text", text: "Task not found" }], isError: true };
      }

      try {
        await taskService.claimTask({
          taskUuid: task.uuid,
          companyUuid: auth.companyUuid,
          assigneeType: "agent",
          assigneeUuid: auth.actorUuid,
        });

        await activityService.createActivity({
          companyUuid: auth.companyUuid,
          projectUuid: task.projectUuid,
          targetType: "task",
          targetUuid: task.uuid,
          actorType: "agent",
          actorUuid: auth.actorUuid,
          action: "assigned",
          value: { assigneeType: "agent", assigneeUuid: auth.actorUuid },
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
            hints.push(`⚠ BLOCKED: This task depends on unfinished tasks: ${names}. They must be verified to done by an admin or human before you can proceed.`);
          }
        }
        if (fullTask?.dependedBy?.length) {
          const waiting = fullTask.dependedBy.filter(
            (d) => d.status !== "done" && d.status !== "closed"
          );
          if (waiting.length > 0) {
            const names = waiting.map((d) => `"${d.title}"`).join(", ");
            hints.push(`IMPORTANT: Downstream tasks are waiting on this one: ${names}. After you finish, an admin or human must verify this task to done to unblock them.`);
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
          return { content: [{ type: "text", text: "Can only claim tasks with open status" }], isError: true };
        }
        throw e;
      }
    }
  );

  // chorus_release_task - Release a claimed Task
  server.registerTool(
    "chorus_release_task",
    {
      description: "Release a claimed Task (assigned -> open)",
      inputSchema: z.object({
        taskUuid: z.string().describe("Task UUID"),
      }),
    },
    async ({ taskUuid }) => {
      const task = await taskService.getTaskByUuid(auth.companyUuid, taskUuid);
      if (!task) {
        return { content: [{ type: "text", text: "Task not found" }], isError: true };
      }

      // Check if the caller is the assignee (UUID comparison)
      const isAssignee =
        (task.assigneeType === "agent" && task.assigneeUuid === auth.actorUuid) ||
        (task.assigneeType === "user" && auth.ownerUuid && task.assigneeUuid === auth.ownerUuid);

      if (!isAssignee) {
        return { content: [{ type: "text", text: "Only the assignee can release a task" }], isError: true };
      }

      try {
        const updated = await taskService.releaseTask(task.uuid);

        await activityService.createActivity({
          companyUuid: auth.companyUuid,
          projectUuid: task.projectUuid,
          targetType: "task",
          targetUuid: task.uuid,
          actorType: "agent",
          actorUuid: auth.actorUuid,
          action: "released",
        });

        return {
          content: [{ type: "text", text: JSON.stringify({ uuid: updated.uuid, status: updated.status }, null, 2) }],
        };
      } catch (e) {
        if (e instanceof NotClaimedError) {
          return { content: [{ type: "text", text: "Can only release tasks with assigned status" }], isError: true };
        }
        throw e;
      }
    }
  );

  // chorus_update_task - Update task status
  server.registerTool(
    "chorus_update_task",
    {
      description: "Update task status (only the assignee can operate)",
      inputSchema: z.object({
        taskUuid: z.string().describe("Task UUID"),
        status: z.enum(["in_progress", "to_verify"]).describe("New status"),
        sessionUuid: z.string().optional().describe("Session UUID (for sub-agent identification)"),
      }),
    },
    async ({ taskUuid, status, sessionUuid }) => {
      const task = await taskService.getTaskByUuid(auth.companyUuid, taskUuid);
      if (!task) {
        return { content: [{ type: "text", text: "Task not found" }], isError: true };
      }

      // Check if the caller is the assignee (UUID comparison)
      const isAssignee =
        (task.assigneeType === "agent" && task.assigneeUuid === auth.actorUuid) ||
        (task.assigneeType === "user" && auth.ownerUuid && task.assigneeUuid === auth.ownerUuid);

      if (!isAssignee) {
        return { content: [{ type: "text", text: "Only the assignee can update task status" }], isError: true };
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

      // Validate status transition
      if (!taskService.isValidTaskStatusTransition(task.status, status)) {
        return {
          content: [{ type: "text", text: `Invalid status transition: ${task.status} -> ${status}` }],
          isError: true,
        };
      }

      // Check dependencies are resolved before moving to in_progress
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

      const updated = await taskService.updateTask(task.uuid, { status });

      await activityService.createActivity({
        companyUuid: auth.companyUuid,
        projectUuid: task.projectUuid,
        targetType: "task",
        targetUuid: task.uuid,
        actorType: "agent",
        actorUuid: auth.actorUuid,
        action: "status_changed",
        value: { status },
        sessionUuid,
        sessionName,
      });

      return {
        content: [{ type: "text", text: JSON.stringify({ uuid: updated.uuid, status: updated.status }, null, 2) }],
      };
    }
  );

  // chorus_submit_for_verify - Submit task for human verification
  server.registerTool(
    "chorus_submit_for_verify",
    {
      description: "Submit task for human verification (in_progress -> to_verify)",
      inputSchema: z.object({
        taskUuid: z.string().describe("Task UUID"),
        summary: z.string().optional().describe("Work summary"),
      }),
    },
    async ({ taskUuid, summary }) => {
      const task = await taskService.getTaskByUuid(auth.companyUuid, taskUuid);
      if (!task) {
        return { content: [{ type: "text", text: "Task not found" }], isError: true };
      }

      // Check if the caller is the assignee (UUID comparison)
      const isAssignee =
        (task.assigneeType === "agent" && task.assigneeUuid === auth.actorUuid) ||
        (task.assigneeType === "user" && auth.ownerUuid && task.assigneeUuid === auth.ownerUuid);

      if (!isAssignee) {
        return { content: [{ type: "text", text: "Only the assignee can submit for verification" }], isError: true };
      }

      if (task.status !== "in_progress") {
        return { content: [{ type: "text", text: "Can only submit for verification from in_progress status" }], isError: true };
      }

      const updated = await taskService.updateTask(task.uuid, { status: "to_verify" });

      // Log activity
      await activityService.createActivity({
        companyUuid: auth.companyUuid,
        projectUuid: task.projectUuid,
        targetType: "task",
        targetUuid: task.uuid,
        actorType: "agent",
        actorUuid: auth.actorUuid,
        action: "submitted",
        value: summary ? { summary } : undefined,
      });

      return {
        content: [{ type: "text", text: JSON.stringify({ uuid: updated.uuid, status: updated.status }, null, 2) }],
      };
    }
  );

  // chorus_report_criteria_self_check - Report self-check results on acceptance criteria
  server.registerTool(
    "chorus_report_criteria_self_check",
    {
      description: "Report self-check results on acceptance criteria for a task you're working on",
      inputSchema: z.object({
        taskUuid: z.string().describe("Task UUID"),
        criteria: zArray(z.object({
          uuid: z.string().describe("AcceptanceCriterion UUID"),
          devStatus: z.enum(["passed", "failed"]).describe("Self-check result"),
          devEvidence: z.string().optional().describe("Optional evidence/notes"),
        })).describe("Criteria self-check results"),
      }),
    },
    async ({ taskUuid, criteria }) => {
      // Verify caller is the assignee
      const task = await taskService.getTaskByUuid(auth.companyUuid, taskUuid);
      if (!task) return { content: [{ type: "text", text: "Task not found" }], isError: true };
      const isAssignee =
        (task.assigneeType === "agent" && task.assigneeUuid === auth.actorUuid) ||
        (task.assigneeType === "user" && auth.ownerUuid && task.assigneeUuid === auth.ownerUuid);
      if (!isAssignee) return { content: [{ type: "text", text: "Only the assignee can self-check acceptance criteria" }], isError: true };

      const result = await taskService.reportCriteriaSelfCheck(
        auth.companyUuid,
        taskUuid,
        criteria,
        { type: auth.type, actorUuid: auth.actorUuid },
      );
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // chorus_report_work - Report work progress or completion
  server.registerTool(
    "chorus_report_work",
    {
      description: "Report work progress or completion",
      inputSchema: z.object({
        taskUuid: z.string().describe("Task UUID"),
        report: z.string().describe("Work report content"),
        status: z.enum(["in_progress", "to_verify"]).optional().describe("Optional: update status at the same time"),
        sessionUuid: z.string().optional().describe("Session UUID (for sub-agent identification)"),
      }),
    },
    async ({ taskUuid, report, status, sessionUuid }) => {
      const task = await taskService.getTaskByUuid(auth.companyUuid, taskUuid);
      if (!task) {
        return { content: [{ type: "text", text: "Task not found" }], isError: true };
      }

      // Check if the caller is the assignee (UUID comparison)
      const isAssignee =
        (task.assigneeType === "agent" && task.assigneeUuid === auth.actorUuid) ||
        (task.assigneeType === "user" && auth.ownerUuid && task.assigneeUuid === auth.ownerUuid);

      if (!isAssignee) {
        return { content: [{ type: "text", text: "Only the assignee can report work" }], isError: true };
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

      // Update status if requested
      if (status && taskService.isValidTaskStatusTransition(task.status, status)) {
        await taskService.updateTask(task.uuid, { status });
      }

      // Write comment
      await commentService.createComment({
        companyUuid: auth.companyUuid,
        targetType: "task",
        targetUuid: task.uuid,
        content: report,
        authorType: "agent",
        authorUuid: auth.actorUuid,
      });

      // Log activity
      await activityService.createActivity({
        companyUuid: auth.companyUuid,
        projectUuid: task.projectUuid,
        targetType: "task",
        targetUuid: task.uuid,
        actorType: "agent",
        actorUuid: auth.actorUuid,
        action: "comment_added",
        value: { report, statusUpdated: status || null },
        sessionUuid,
        sessionName,
      });

      return {
        content: [{ type: "text", text: `Work report recorded: ${report}` }],
      };
    }
  );
}
