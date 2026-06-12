"use server";

import { getServerAuthContext } from "@/lib/auth-server";
import * as taskService from "@/services/task.service";

export async function getTaskDependenciesAction(taskUuid: string) {
  const auth = await getServerAuthContext();
  if (!auth) return { dependsOn: [], dependedBy: [] };
  try {
    return await taskService.getTaskDependencies(auth.companyUuid, taskUuid, auth);
  } catch {
    return { dependsOn: [], dependedBy: [] };
  }
}

export async function addTaskDependencyAction(taskUuid: string, dependsOnUuid: string) {
  const auth = await getServerAuthContext();
  if (!auth) return { success: false, error: "Unauthorized" };
  try {
    await taskService.addTaskDependency(auth.companyUuid, taskUuid, dependsOnUuid, auth);
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
  }
}

export async function removeTaskDependencyAction(taskUuid: string, dependsOnUuid: string) {
  const auth = await getServerAuthContext();
  if (!auth) return { success: false, error: "Unauthorized" };
  try {
    await taskService.removeTaskDependency(auth.companyUuid, taskUuid, dependsOnUuid, auth);
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
  }
}

export async function getProjectTasksForDependencyAction(projectUuid: string) {
  const auth = await getServerAuthContext();
  if (!auth) return { tasks: [] };
  try {
    const result = await taskService.listTasks({
      companyUuid: auth.companyUuid,
      projectUuid,
      skip: 0,
      take: 1000,
      auth,
    });
    return { tasks: result.tasks.map(t => ({ uuid: t.uuid, title: t.title, status: t.status })) };
  } catch {
    return { tasks: [] };
  }
}
