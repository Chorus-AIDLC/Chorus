"use server";

import { revalidatePath } from "next/cache";
import { getServerAuthContext } from "@/lib/auth-server";
import { markAcceptanceCriteria, reportCriteriaSelfCheck, resetAcceptanceCriterion, getTaskByUuid } from "@/services/task.service";

export async function markCriteriaAction(
  taskUuid: string,
  criteria: Array<{ uuid: string; status: "passed" | "failed"; evidence?: string }>,
) {
  const auth = await getServerAuthContext();
  if (!auth) {
    return { success: false, error: "Unauthorized" };
  }

  // Only users (admins) can verify criteria
  if (auth.type !== "user" && auth.type !== "super_admin") {
    return { success: false, error: "Only users can verify acceptance criteria" };
  }

  try {
    const task = await getTaskByUuid(auth.companyUuid, taskUuid);
    if (!task) {
      return { success: false, error: "Task not found" };
    }

    const result = await markAcceptanceCriteria(
      auth.companyUuid,
      taskUuid,
      criteria,
      { type: auth.type, actorUuid: auth.actorUuid },
    );

    revalidatePath(`/projects/${task.projectUuid}/tasks/${taskUuid}`);
    revalidatePath(`/projects/${task.projectUuid}/tasks`);

    return { success: true, data: result };
  } catch (error) {
    console.error("Failed to mark acceptance criteria:", error);
    return { success: false, error: "Failed to mark acceptance criteria" };
  }
}

export async function resetCriterionAction(
  taskUuid: string,
  criterionUuid: string,
) {
  const auth = await getServerAuthContext();
  if (!auth) {
    return { success: false, error: "Unauthorized" };
  }

  if (auth.type !== "user" && auth.type !== "super_admin") {
    return { success: false, error: "Only users can reset acceptance criteria" };
  }

  try {
    const task = await getTaskByUuid(auth.companyUuid, taskUuid);
    if (!task) {
      return { success: false, error: "Task not found" };
    }

    await resetAcceptanceCriterion(auth.companyUuid, taskUuid, criterionUuid);

    revalidatePath(`/projects/${task.projectUuid}/tasks/${taskUuid}`);
    revalidatePath(`/projects/${task.projectUuid}/tasks`);

    return { success: true };
  } catch (error) {
    console.error("Failed to reset acceptance criterion:", error);
    return { success: false, error: "Failed to reset acceptance criterion" };
  }
}

export async function selfCheckCriteriaAction(
  taskUuid: string,
  criteria: Array<{ uuid: string; devStatus: "passed" | "failed"; devEvidence?: string }>,
) {
  const auth = await getServerAuthContext();
  if (!auth) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const task = await getTaskByUuid(auth.companyUuid, taskUuid);
    if (!task) {
      return { success: false, error: "Task not found" };
    }

    const result = await reportCriteriaSelfCheck(
      auth.companyUuid,
      taskUuid,
      criteria,
      { type: auth.type, actorUuid: auth.actorUuid },
    );

    revalidatePath(`/projects/${task.projectUuid}/tasks/${taskUuid}`);
    revalidatePath(`/projects/${task.projectUuid}/tasks`);

    return { success: true, data: result };
  } catch (error) {
    console.error("Failed to self-check acceptance criteria:", error);
    return { success: false, error: "Failed to self-check acceptance criteria" };
  }
}
