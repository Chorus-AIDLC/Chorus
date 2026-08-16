"use server";

import { revalidatePath } from "next/cache";
import { getServerAuthContext } from "@/lib/auth-server";
import { claimTask, getTaskByUuid, updateTask, releaseTask, createTask, deleteTask, checkAcceptanceCriteriaGate, replaceAcceptanceCriteria } from "@/services/task.service";
import { getAssignableAgents, getCompanyUsers } from "@/services/agent.service";
import { listConnectionsForAgent } from "@/services/daemon-connection.service";
import {
  resolveProjectAgentCwdTarget,
  type ResolvedProjectAgentCwdTarget,
} from "@/services/project-agent-cwd.service";
import { createActivity } from "@/services/activity.service";
import type { AcceptanceCriteriaItemInput } from "@/lib/acceptance-criteria";
import type { InstanceCandidate } from "@/components/agent-presence/instance-picker";
import logger from "@/lib/logger";

export async function claimTaskAction(taskUuid: string) {
  const auth = await getServerAuthContext();
  if (!auth) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    // Validate task exists and belongs to this company
    const task = await getTaskByUuid(auth.companyUuid, taskUuid);
    if (!task) {
      return { success: false, error: "Task not found" };
    }

    // Only open or assigned tasks can be claimed/reassigned
    if (task.status !== "open" && task.status !== "assigned") {
      return { success: false, error: "Task is not available for claiming" };
    }

    await claimTask({
      taskUuid,
      companyUuid: auth.companyUuid,
      assigneeType: auth.type,
      assigneeUuid: auth.actorUuid,
      assignedByType: "user",
      assignedByUuid: auth.actorUuid,
    });

    // Record activity
    await createActivity({
      companyUuid: auth.companyUuid,
      projectUuid: task.projectUuid,
      targetType: "task",
      targetUuid: taskUuid,
      actorType: auth.type,
      actorUuid: auth.actorUuid,
      action: "assigned",
      value: { assigneeType: auth.type, assigneeUuid: auth.actorUuid },
    });

    revalidatePath(`/projects/${task.projectUuid}/tasks/${taskUuid}`);
    revalidatePath(`/projects/${task.projectUuid}/tasks`);

    return { success: true };
  } catch (error) {
    logger.error({ err: error }, "Failed to claim task");
    return { success: false, error: "Failed to claim task" };
  }
}

// Claim task to a specific agent, optionally pinning a DURABLE AgentInstance
// (the (agent, host, cwd) place) for the autonomous wake. When `instanceUuid` is
// given the row is persisted as assigneeType="agent_instance"/assigneeUuid=<that
// uuid> (validated company-scoped in claimTask); omitting it assigns the plain
// agent. The InstancePicker only offers ONLINE instances, so a pin is always to a
// reachable place; a fully-offline agent shows no picker and assigns plainly.
export async function claimTaskToAgentAction(
  taskUuid: string,
  agentUuid: string,
  instanceUuid?: string | null,
) {
  const auth = await getServerAuthContext();
  if (!auth || auth.type !== "user") {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const task = await getTaskByUuid(auth.companyUuid, taskUuid);
    if (!task) {
      return { success: false, error: "Task not found" };
    }

    if (task.status !== "open" && task.status !== "assigned") {
      return { success: false, error: "Task is not available for claiming" };
    }

    const target = await resolveProjectAgentCwdTarget({
      companyUuid: auth.companyUuid,
      actorUserUuid: auth.actorUuid,
      projectUuid: task.projectUuid,
      agentUuid,
    });
    const resolvedInstanceUuid =
      target.source === "project_fixed"
        ? target.agentInstanceUuid
        : instanceUuid;

    await claimTask({
      taskUuid,
      companyUuid: auth.companyUuid,
      assigneeType: "agent",
      assigneeUuid: agentUuid,
      assignedByType: "user",
      assignedByUuid: auth.actorUuid,
      // Thread the durable AgentInstance pin. claimTask validates it belongs to
      // the company and promotes the row to assigneeType="agent_instance"; with
      // no instanceUuid the assignment stays a plain agent (also the path that
      // reverts a prior instance pin back to the plain agent on re-assignment).
      instanceUuid: resolvedInstanceUuid ?? undefined,
      cwdSource: target.source === "project_fixed" ? target.source : null,
      cwdHost: target.source === "project_fixed" ? target.host : null,
      runtimeCwd: target.source === "project_fixed" ? target.cwd : null,
    });

    // Record activity
    await createActivity({
      companyUuid: auth.companyUuid,
      projectUuid: task.projectUuid,
      targetType: "task",
      targetUuid: taskUuid,
      actorType: auth.type,
      actorUuid: auth.actorUuid,
      action: "assigned",
      value: {
        assigneeType: "agent",
        assigneeUuid: agentUuid,
        // Record the durable instance pin in the activity value so the timeline
        // reflects which place was chosen (omitted when un-pinned).
        ...(resolvedInstanceUuid ? { instanceUuid: resolvedInstanceUuid } : {}),
        ...(target.source === "project_fixed"
          ? {
              resolvedCwdSource: target.source,
              resolvedCwdHost: target.host,
              resolvedRuntimeCwd: target.cwd,
            }
          : {}),
      },
    });

    revalidatePath(`/projects/${task.projectUuid}/tasks/${taskUuid}`);
    revalidatePath(`/projects/${task.projectUuid}/tasks`);

    return { success: true };
  } catch (error) {
    logger.error({ err: error }, "Failed to claim task to agent");
    return { success: false, error: "Failed to claim task" };
  }
}

// Pin a task's assignee to a specific DURABLE AgentInstance WITHOUT waking the
// agent (pin-cwd-before-wake, D2). This is the non-waking sibling of
// `claimTaskToAgentAction`: it calls the same non-waking `claimTask` service
// (which promotes the row to assigneeType="agent_instance" via
// resolveTaskAssigneeFields and emits only emitChange('updated')) but
// DELIBERATELY omits the `createActivity({action:"assigned"})` call — that
// activity is what triggers the wake today. The result is a durably-pinned task
// that has NOT been woken; the caller (the pin-then-wake button flow) fires the
// wake as a separate step. `instanceUuid` MUST be one of the agent's own
// AgentInstance uuids; claimTask validates it belongs to the company and throws
// otherwise, which we surface as a clean error result without mutating the
// assignee.
export async function reassignTaskInstanceNoWakeAction(
  taskUuid: string,
  agentUuid: string,
  instanceUuid: string,
) {
  const auth = await getServerAuthContext();
  if (!auth || auth.type !== "user") {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const task = await getTaskByUuid(auth.companyUuid, taskUuid);
    if (!task) {
      return { success: false, error: "Task not found" };
    }

    if (task.status !== "open" && task.status !== "assigned") {
      return { success: false, error: "Task is not available for claiming" };
    }

    // Promote to agent_instance via the non-waking service primitive. A foreign
    // or missing instance is rejected inside claimTask (resolveTaskAssigneeFields
    // throws) BEFORE any assignee write, so the assignee is left unchanged.
    await claimTask({
      taskUuid,
      companyUuid: auth.companyUuid,
      assigneeType: "agent",
      assigneeUuid: agentUuid,
      assignedByType: "user",
      assignedByUuid: auth.actorUuid,
      instanceUuid,
    });

    // NO createActivity({action:"assigned"}) here — that activity is what wakes
    // the daemon today. This action pins only; the wake is a separate step.

    revalidatePath(`/projects/${task.projectUuid}/tasks/${taskUuid}`);
    revalidatePath(`/projects/${task.projectUuid}/tasks`);

    return { success: true };
  } catch (error) {
    logger.error({ err: error }, "Failed to reassign task instance (no wake)");
    return { success: false, error: "Failed to reassign task" };
  }
}

export async function releaseTaskAction(taskUuid: string) {
  const auth = await getServerAuthContext();
  if (!auth) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    // Validate task exists and belongs to this company
    const task = await getTaskByUuid(auth.companyUuid, taskUuid);
    if (!task) {
      return { success: false, error: "Task not found" };
    }

    // Only assigned or in_progress tasks can be released
    if (task.status !== "assigned" && task.status !== "in_progress") {
      return { success: false, error: "Task is not in assigned status" };
    }

    // Release task
    await releaseTask(taskUuid);

    // Record activity
    await createActivity({
      companyUuid: auth.companyUuid,
      projectUuid: task.projectUuid,
      targetType: "task",
      targetUuid: taskUuid,
      actorType: auth.type,
      actorUuid: auth.actorUuid,
      action: "released",
    });

    revalidatePath(`/projects/${task.projectUuid}/tasks/${taskUuid}`);
    revalidatePath(`/projects/${task.projectUuid}/tasks`);

    return { success: true };
  } catch (error) {
    logger.error({ err: error }, "Failed to release task");
    return { success: false, error: "Failed to release task" };
  }
}

export async function updateTaskStatusAction(taskUuid: string, newStatus: string) {
  const auth = await getServerAuthContext();
  if (!auth) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    // Validate task exists and belongs to this company
    const task = await getTaskByUuid(auth.companyUuid, taskUuid);
    if (!task) {
      return { success: false, error: "Task not found" };
    }

    await updateTask(taskUuid, { status: newStatus });

    // Record activity
    await createActivity({
      companyUuid: auth.companyUuid,
      projectUuid: task.projectUuid,
      targetType: "task",
      targetUuid: taskUuid,
      actorType: auth.type,
      actorUuid: auth.actorUuid,
      action: "status_changed",
      value: { status: newStatus },
    });

    revalidatePath(`/projects/${task.projectUuid}/tasks/${taskUuid}`);
    revalidatePath(`/projects/${task.projectUuid}/tasks`);

    return { success: true };
  } catch (error) {
    logger.error({ err: error }, "Failed to update task status");
    return { success: false, error: "Failed to update task status" };
  }
}

// Verify task (to_verify -> done) - Human only
export async function verifyTaskAction(taskUuid: string) {
  const auth = await getServerAuthContext();
  if (!auth || auth.type !== "user") {
    return { success: false, error: "Only humans can verify tasks" };
  }

  try {
    const task = await getTaskByUuid(auth.companyUuid, taskUuid);
    if (!task) {
      return { success: false, error: "Task not found" };
    }

    if (task.status !== "to_verify") {
      return { success: false, error: "Task is not in to_verify status" };
    }

    // Check acceptance criteria gate
    const gate = await checkAcceptanceCriteriaGate(taskUuid);
    if (!gate.allowed) {
      return { success: false, error: gate.reason || "Not all required acceptance criteria are passed" };
    }

    await updateTask(taskUuid, { status: "done" });

    revalidatePath(`/projects/${task.projectUuid}/tasks/${taskUuid}`);
    revalidatePath(`/projects/${task.projectUuid}/tasks`);

    return { success: true };
  } catch (error) {
    logger.error({ err: error }, "Failed to verify task");
    return { success: false, error: "Failed to verify task" };
  }
}

// Assign task to another user
export async function claimTaskToUserAction(taskUuid: string, userUuid: string) {
  const auth = await getServerAuthContext();
  if (!auth || auth.type !== "user") {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const task = await getTaskByUuid(auth.companyUuid, taskUuid);
    if (!task) {
      return { success: false, error: "Task not found" };
    }

    if (task.status !== "open" && task.status !== "assigned") {
      return { success: false, error: "Task is not available for assigning" };
    }

    await claimTask({
      taskUuid,
      companyUuid: auth.companyUuid,
      assigneeType: "user",
      assigneeUuid: userUuid,
      assignedByType: "user",
      assignedByUuid: auth.actorUuid,
    });

    // Record activity
    await createActivity({
      companyUuid: auth.companyUuid,
      projectUuid: task.projectUuid,
      targetType: "task",
      targetUuid: taskUuid,
      actorType: auth.type,
      actorUuid: auth.actorUuid,
      action: "assigned",
      value: { assigneeType: "user", assigneeUuid: userUuid },
    });

    revalidatePath(`/projects/${task.projectUuid}/tasks/${taskUuid}`);
    revalidatePath(`/projects/${task.projectUuid}/tasks`);

    return { success: true };
  } catch (error) {
    logger.error({ err: error }, "Failed to assign task to user");
    return { success: false, error: "Failed to assign task" };
  }
}

// Create a new task
interface CreateTaskInput {
  projectUuid: string;
  title: string;
  description?: string;
  priority?: string;
  storyPoints?: number | null;
  acceptanceCriteria?: string | null;
}

export async function createTaskAction(input: CreateTaskInput) {
  const auth = await getServerAuthContext();
  if (!auth) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const task = await createTask({
      companyUuid: auth.companyUuid,
      projectUuid: input.projectUuid,
      title: input.title,
      description: input.description || null,
      priority: input.priority || "medium",
      storyPoints: input.storyPoints,
      acceptanceCriteria: input.acceptanceCriteria,
      createdByUuid: auth.actorUuid,
    });

    // Record activity
    await createActivity({
      companyUuid: auth.companyUuid,
      projectUuid: input.projectUuid,
      targetType: "task",
      targetUuid: task.uuid,
      actorType: auth.type,
      actorUuid: auth.actorUuid,
      action: "task_created",
    });

    revalidatePath(`/projects/${input.projectUuid}/tasks`);
    return { success: true, taskUuid: task.uuid };
  } catch (error) {
    logger.error({ err: error }, "Failed to create task");
    return { success: false, error: "Failed to create task" };
  }
}

// Update task editable fields
interface UpdateTaskFieldsInput {
  taskUuid: string;
  projectUuid: string;
  title: string;
  description?: string | null;
  priority?: string;
  storyPoints?: number | null;
  acceptanceCriteria?: string | null;
  acceptanceCriteriaItems?: AcceptanceCriteriaItemInput[];
}

export async function updateTaskFieldsAction(input: UpdateTaskFieldsInput) {
  const auth = await getServerAuthContext();
  if (!auth) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const task = await getTaskByUuid(auth.companyUuid, input.taskUuid);
    if (!task) {
      return { success: false, error: "Task not found" };
    }

    await updateTask(input.taskUuid, {
      title: input.title,
      description: input.description,
      priority: input.priority,
      storyPoints: input.storyPoints,
      acceptanceCriteria: input.acceptanceCriteria,
    });

    // Only replace structured acceptance criteria when the client explicitly
    // sends them (i.e. they actually changed). Omitting the field leaves the
    // existing criteria — and their dev/admin verification marks — untouched.
    if (input.acceptanceCriteriaItems !== undefined) {
      await replaceAcceptanceCriteria(auth.companyUuid, input.taskUuid, input.acceptanceCriteriaItems);
    }

    revalidatePath(`/projects/${input.projectUuid}/tasks`);
    return { success: true };
  } catch (error) {
    logger.error({ err: error }, "Failed to update task");
    return { success: false, error: error instanceof Error ? error.message : "Failed to update task" };
  }
}

// Delete a task
export async function deleteTaskAction(taskUuid: string, projectUuid: string) {
  const auth = await getServerAuthContext();
  if (!auth) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const task = await getTaskByUuid(auth.companyUuid, taskUuid);
    if (!task) {
      return { success: false, error: "Task not found" };
    }

    await deleteTask(taskUuid);
    revalidatePath(`/projects/${projectUuid}/tasks`);
    return { success: true };
  } catch (error) {
    logger.error({ err: error }, "Failed to delete task");
    return { success: false, error: "Failed to delete task" };
  }
}

// Get assignable agents and users (for assign modal).
// Returns every agent in the company — no role gating. The agent's
// permission set still gates what it can actually do once assigned.
export async function getDeveloperAgentsAction() {
  const auth = await getServerAuthContext();
  if (!auth || auth.type !== "user") {
    return { agents: [], users: [] };
  }

  try {
    const [agents, users] = await Promise.all([
      getAssignableAgents(auth.companyUuid, "task:write", auth.actorUuid),
      getCompanyUsers(auth.companyUuid),
    ]);
    return {
      agents,
      users,
      currentUserUuid: auth.actorUuid,
    };
  } catch (error) {
    logger.error({ err: error }, "Failed to get assignable agents");
    return { agents: [], users: [] };
  }
}

// Get one agent's daemon instances (online + offline, each with effectiveStatus)
// so the assign-task modal can let the owner pin which ONLINE (host, cwd) place
// runs the task. The modal filters to online before rendering the picker.
// Company-scoped read; returns [] for any non-user caller or on error (the picker
// then shows its own "no instances" empty state — never a silent throw).
//
// Each candidate carries the durable `agentInstanceUuid` (the stable pin pointer
// the modal threads into claimTaskToAgentAction), alongside the connectionUuid
// (the picker's selection key). The two shapes that previously diverged
// (InstanceCandidate / AgentInstanceCandidate) are now the single InstanceCandidate.
export async function getAgentInstancesAction(
  agentUuid: string,
  projectUuid?: string,
): Promise<{
  instances: InstanceCandidate[];
  resolvedTarget: ResolvedProjectAgentCwdTarget | null;
}> {
  const auth = await getServerAuthContext();
  if (!auth || auth.type !== "user") {
    return { instances: [], resolvedTarget: null };
  }

  try {
    const [connections, resolvedTarget] = await Promise.all([
      listConnectionsForAgent(auth.companyUuid, agentUuid),
      projectUuid
        ? resolveProjectAgentCwdTarget({
            companyUuid: auth.companyUuid,
            actorUserUuid: auth.actorUuid,
            projectUuid,
            agentUuid,
          })
        : null,
    ]);
    return {
      instances: connections.map((c) => ({
        connectionUuid: c.uuid,
        agentInstanceUuid: c.agentInstanceUuid,
        host: c.host,
        cwd: c.cwd,
        effectiveStatus: c.effectiveStatus,
      })),
      resolvedTarget,
    };
  } catch (error) {
    logger.error({ err: error }, "Failed to get agent instances");
    return { instances: [], resolvedTarget: null };
  }
}
