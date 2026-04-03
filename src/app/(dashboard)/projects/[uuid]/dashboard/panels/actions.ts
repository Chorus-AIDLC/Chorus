"use server";

import { getServerAuthContext } from "@/lib/auth-server";
import { prisma } from "@/lib/prisma";
import { computeAcceptanceStatus } from "@/services/task.service";

// Types for verify view
export interface VerifyTaskData {
  uuid: string;
  title: string;
  status: string;
  acceptanceCriteriaItems: Array<{
    uuid: string;
    description: string;
    required: boolean;
    status: string;
    devStatus: string;
  }>;
  acceptanceSummary: {
    total: number;
    passed: number;
    failed: number;
    pending: number;
  };
}

export interface VerifyViewData {
  tasks: VerifyTaskData[];
  overallProgress: { verified: number; total: number };
  proposalTitle: string | null;
}

// Types for PRD expanded view
export interface PrdDocumentData {
  uuid: string;
  type: string;
  title: string;
  content: string | null;
}

export interface PrdTaskData {
  uuid: string;
  title: string;
  status: string;
  priority: string;
  proposalUuid: string | null;
}

export interface PrdDagEdge {
  from: string;
  to: string;
}

export interface PrdExpandedViewData {
  documents: PrdDocumentData[];
  tasks: PrdTaskData[];
  edges: PrdDagEdge[];
  proposalTitle: string | null;
}

// Fetch data for Verify view
export async function getVerifyViewDataAction(
  ideaUuid: string,
  projectUuid: string
): Promise<{ success: boolean; data?: VerifyViewData; error?: string }> {
  const auth = await getServerAuthContext();
  if (!auth) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    // Find approved proposals that reference this idea
    const proposals = await prisma.proposal.findMany({
      where: {
        companyUuid: auth.companyUuid,
        projectUuid,
        status: "approved",
        inputType: "idea",
      },
      select: {
        uuid: true,
        title: true,
        inputUuids: true,
      },
    });

    // Filter to proposals that include this idea
    const matchingProposals = proposals.filter((p) => {
      const inputs = p.inputUuids as string[];
      return inputs && inputs.includes(ideaUuid);
    });

    if (matchingProposals.length === 0) {
      return {
        success: true,
        data: {
          tasks: [],
          overallProgress: { verified: 0, total: 0 },
          proposalTitle: null,
        },
      };
    }

    const proposalUuids = matchingProposals.map((p) => p.uuid);
    const proposalTitle = matchingProposals[0].title;

    // Get tasks from these proposals
    const rawTasks = await prisma.task.findMany({
      where: {
        companyUuid: auth.companyUuid,
        projectUuid,
        proposalUuid: { in: proposalUuids },
      },
      select: {
        uuid: true,
        title: true,
        status: true,
      },
      orderBy: { createdAt: "asc" },
    });

    // Get acceptance criteria for all tasks
    const taskUuids = rawTasks.map((t) => t.uuid);
    const criteria = await prisma.acceptanceCriterion.findMany({
      where: { taskUuid: { in: taskUuids } },
      select: {
        uuid: true,
        taskUuid: true,
        description: true,
        required: true,
        status: true,
        devStatus: true,
        sortOrder: true,
      },
      orderBy: { sortOrder: "asc" },
    });

    // Group criteria by task
    const criteriaByTask = new Map<string, typeof criteria>();
    for (const c of criteria) {
      const existing = criteriaByTask.get(c.taskUuid) || [];
      existing.push(c);
      criteriaByTask.set(c.taskUuid, existing);
    }

    let totalCriteria = 0;
    let verifiedCriteria = 0;

    const tasks: VerifyTaskData[] = rawTasks.map((task) => {
      const items = criteriaByTask.get(task.uuid) || [];
      const { summary } = computeAcceptanceStatus(items);

      totalCriteria += summary.total;
      verifiedCriteria += summary.passed;

      return {
        uuid: task.uuid,
        title: task.title,
        status: task.status,
        acceptanceCriteriaItems: items.map((item) => ({
          uuid: item.uuid,
          description: item.description,
          required: item.required,
          status: item.status,
          devStatus: item.devStatus,
        })),
        acceptanceSummary: {
          total: summary.total,
          passed: summary.passed,
          failed: summary.failed,
          pending: summary.pending,
        },
      };
    });

    return {
      success: true,
      data: {
        tasks,
        overallProgress: { verified: verifiedCriteria, total: totalCriteria },
        proposalTitle,
      },
    };
  } catch (error) {
    console.error("Failed to get verify view data:", error);
    return { success: false, error: "Failed to load verification data" };
  }
}

// Fetch data for PRD Expanded view
export async function getPrdExpandedViewDataAction(
  ideaUuid: string,
  projectUuid: string
): Promise<{ success: boolean; data?: PrdExpandedViewData; error?: string }> {
  const auth = await getServerAuthContext();
  if (!auth) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    // Find approved proposals that reference this idea
    const proposals = await prisma.proposal.findMany({
      where: {
        companyUuid: auth.companyUuid,
        projectUuid,
        status: "approved",
        inputType: "idea",
      },
      select: {
        uuid: true,
        title: true,
        inputUuids: true,
      },
    });

    // Filter to proposals that include this idea
    const matchingProposals = proposals.filter((p) => {
      const inputs = p.inputUuids as string[];
      return inputs && inputs.includes(ideaUuid);
    });

    if (matchingProposals.length === 0) {
      return {
        success: true,
        data: {
          documents: [],
          tasks: [],
          edges: [],
          proposalTitle: null,
        },
      };
    }

    const proposalUuids = matchingProposals.map((p) => p.uuid);
    const proposalTitle = matchingProposals[0].title;

    // Get documents from these proposals
    const documents = await prisma.document.findMany({
      where: {
        companyUuid: auth.companyUuid,
        projectUuid,
        proposalUuid: { in: proposalUuids },
      },
      select: {
        uuid: true,
        type: true,
        title: true,
        content: true,
      },
      orderBy: { createdAt: "asc" },
    });

    // Get tasks from these proposals
    const tasks = await prisma.task.findMany({
      where: {
        companyUuid: auth.companyUuid,
        projectUuid,
        proposalUuid: { in: proposalUuids },
      },
      select: {
        uuid: true,
        title: true,
        status: true,
        priority: true,
        proposalUuid: true,
      },
      orderBy: { createdAt: "asc" },
    });

    // Get edges (dependencies) for these tasks
    const taskUuids = tasks.map((t) => t.uuid);
    const dependencies = await prisma.taskDependency.findMany({
      where: {
        taskUuid: { in: taskUuids },
        dependsOnUuid: { in: taskUuids },
      },
      select: {
        taskUuid: true,
        dependsOnUuid: true,
      },
    });

    return {
      success: true,
      data: {
        documents: documents.map((d) => ({
          uuid: d.uuid,
          type: d.type,
          title: d.title,
          content: d.content,
        })),
        tasks: tasks.map((t) => ({
          uuid: t.uuid,
          title: t.title,
          status: t.status,
          priority: t.priority,
          proposalUuid: t.proposalUuid,
        })),
        edges: dependencies.map((d) => ({
          from: d.taskUuid,
          to: d.dependsOnUuid,
        })),
        proposalTitle,
      },
    };
  } catch (error) {
    console.error("Failed to get PRD expanded view data:", error);
    return { success: false, error: "Failed to load PRD data" };
  }
}
