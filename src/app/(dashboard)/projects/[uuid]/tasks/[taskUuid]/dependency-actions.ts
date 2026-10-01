"use server";

import { getServerAuthContext } from "@/lib/auth-server";
import * as taskService from "@/services/task.service";
import { denyUnlessEntityAccess, denyUnlessProjectAccess } from "@/lib/project-access-action";

export async function getTaskDependenciesAction(taskUuid: string) {
  const auth = await getServerAuthContext();
  if (!auth) return { dependsOn: [], dependedBy: [] };
  if (await denyUnlessEntityAccess(auth, "task", taskUuid, "viewer")) {
    return { dependsOn: [], dependedBy: [] };
  }
  try {
    return await taskService.getTaskDependencies(auth.companyUuid, taskUuid);
  } catch {
    return { dependsOn: [], dependedBy: [] };
  }
}

export async function addTaskDependencyAction(taskUuid: string, dependsOnUuid: string) {
  const auth = await getServerAuthContext();
  if (!auth) return { success: false, error: "Unauthorized" };
  const denied =
    (await denyUnlessEntityAccess(auth, "task", taskUuid, "editor")) ??
    (await denyUnlessEntityAccess(auth, "task", dependsOnUuid, "viewer"));
  if (denied) return denied;
  try {
    await taskService.addTaskDependency(auth.companyUuid, taskUuid, dependsOnUuid);
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
  }
}

export async function removeTaskDependencyAction(taskUuid: string, dependsOnUuid: string) {
  const auth = await getServerAuthContext();
  if (!auth) return { success: false, error: "Unauthorized" };
  const denied =
    (await denyUnlessEntityAccess(auth, "task", taskUuid, "editor")) ??
    (await denyUnlessEntityAccess(auth, "task", dependsOnUuid, "viewer"));
  if (denied) return denied;
  try {
    await taskService.removeTaskDependency(auth.companyUuid, taskUuid, dependsOnUuid);
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
  }
}

export async function getProjectTasksForDependencyAction(projectUuid: string) {
  const auth = await getServerAuthContext();
  if (!auth) return { tasks: [] };
  if (await denyUnlessProjectAccess(auth, projectUuid, "viewer")) return { tasks: [] };
  try {
    const result = await taskService.listTasks({
      companyUuid: auth.companyUuid,
      projectUuid,
      skip: 0,
      take: 1000,
    });
    return { tasks: result.tasks.map(t => ({ uuid: t.uuid, title: t.title, status: t.status })) };
  } catch {
    return { tasks: [] };
  }
}
