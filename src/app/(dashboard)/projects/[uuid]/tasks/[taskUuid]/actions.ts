"use server";

import { revalidatePath } from "next/cache";
import { getServerAuthContext } from "@/lib/auth-server";
import { claimTask, getTaskByUuid, updateTask, releaseTask, createTask, deleteTask, checkAcceptanceCriteriaGate, replaceAcceptanceCriteria } from "@/services/task.service";
import { getAssignableAgents, getCompanyUsers } from "@/services/agent.service";
import { listConnectionsForAgent } from "@/services/daemon-connection.service";
import { createActivity } from "@/services/activity.service";
import type { AcceptanceCriteriaItemInput } from "@/lib/acceptance-criteria";
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

// Claim task to a specific agent, optionally pinning a (host, cwd) daemon
// instance for the autonomous wake (cwd-addressable instances, T4). The pin is a
// durable "place" — an offline instance is a valid pin (the turn queues and
// backfills on reconnect), so this path does NOT gate on the instance being
// online. `targetHost`/`targetCwd` are both omitted for an un-pinned assignment.
export async function claimTaskToAgentAction(
  taskUuid: string,
  agentUuid: string,
  pin?: { targetHost: string | null; targetCwd: string | null },
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

    await claimTask({
      taskUuid,
      companyUuid: auth.companyUuid,
      assigneeType: "agent",
      assigneeUuid: agentUuid,
      assignedByUuid: auth.actorUuid,
      targetHost: pin?.targetHost ?? null,
      targetCwd: pin?.targetCwd ?? null,
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
        // Record the pin in the activity value so the timeline reflects which
        // (host, cwd) place was chosen (omitted when un-pinned).
        ...(pin?.targetCwd !== undefined || pin?.targetHost !== undefined
          ? { targetHost: pin?.targetHost ?? null, targetCwd: pin?.targetCwd ?? null }
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

// One selectable daemon instance for the assign-task cwd picker (cwd-addressable
// instances) — the structural subset the shared InstancePicker renders. Both
// online AND offline instances are returned here (each carries effectiveStatus);
// the modal filters to ONLINE before showing the picker, since an offline
// instance is not a wake target. A fully-offline agent yields no online
// instances → no picker → the task is assigned plainly with no pin.
export interface AgentInstanceCandidate {
  connectionUuid: string;
  host: string;
  cwd: string | null;
  effectiveStatus: "online" | "offline";
}

// Get one agent's daemon instances (online + offline, each with effectiveStatus)
// so the assign-task modal can let the owner pin which ONLINE (host, cwd) place
// runs the task. The modal filters to online before rendering the picker.
// Company-scoped read; returns [] for any non-user caller or on error (the picker
// then shows its own "no instances" empty state — never a silent throw).
export async function getAgentInstancesAction(
  agentUuid: string,
): Promise<{ instances: AgentInstanceCandidate[] }> {
  const auth = await getServerAuthContext();
  if (!auth || auth.type !== "user") {
    return { instances: [] };
  }

  try {
    const connections = await listConnectionsForAgent(auth.companyUuid, agentUuid);
    return {
      instances: connections.map((c) => ({
        connectionUuid: c.uuid,
        host: c.host,
        cwd: c.cwd,
        effectiveStatus: c.effectiveStatus,
      })),
    };
  } catch (error) {
    logger.error({ err: error }, "Failed to get agent instances");
    return { instances: [] };
  }
}
