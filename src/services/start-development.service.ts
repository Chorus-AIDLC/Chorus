// src/services/start-development.service.ts
// The `start_development` stage-advance event: a human clicks 「开始开发」on an
// Idea whose proposal is approved and whose tasks aren't finished, and the
// Idea's assigned daemon agent is woken (session-origin-pinned, dedicated
// `start_development` trigger) to claim and execute ALL remaining tasks.
//
// The event is wake-only: it performs NO Idea state transition — the derived
// status already renders the execute stage. Its offline policy is
// `require_online` (elaboration decision Q5): a human clicking "start
// development" expects development to start now or a clear agent-offline
// error, not a silent queue.

import { prisma } from "@/lib/prisma";
import {
  executeStageAdvance,
  StageAdvanceError,
  type StageAdvanceDefinition,
} from "@/services/stage-advance.service";

// Per-stage precondition sub-codes (StageAdvanceError.reason) — the server
// action forwards these so the UI can toast a precise message.
export const START_DEVELOPMENT_REASONS = {
  NO_APPROVED_PROPOSAL: "no_approved_proposal",
  NO_UNFINISHED_TASKS: "no_unfinished_tasks",
} as const;

// A task is finished only when it is done or closed; open / assigned /
// in_progress / to_verify all count as unfinished (elaboration decision Q3 —
// consistent with computeDerivedStatus's allDone predicate).
const FINISHED_TASK_STATUSES = ["done", "closed"];

const START_DEVELOPMENT_STAGE: StageAdvanceDefinition = {
  action: "start_development",
  precondition: async ({ companyUuid, ideaUuid, idea }) => {
    // The wake needs a daemon to land on: the assignee must be an agent (or a
    // pinned agent_instance). The require_online policy re-resolves the owning
    // agent for the liveness check; failing early here gives the UI the
    // sharper "assignee is not an agent" message instead of a liveness error.
    if (idea.assigneeType !== "agent" && idea.assigneeType !== "agent_instance") {
      throw new StageAdvanceError(
        "ASSIGNEE_NOT_AGENT",
        "The Idea's assignee is not an agent — there is no daemon to wake"
      );
    }

    // An approved proposal that contains this Idea (same query shape as
    // getIdeaWithDerivedStatus). Newest first in case several exist.
    const approvedProposal = await prisma.proposal.findFirst({
      where: {
        companyUuid,
        projectUuid: idea.projectUuid,
        status: "approved",
        inputUuids: { array_contains: [ideaUuid] },
      },
      select: { uuid: true },
      orderBy: { createdAt: "desc" },
    });
    if (!approvedProposal) {
      throw new StageAdvanceError(
        "PRECONDITION_FAILED",
        "The Idea has no approved proposal",
        START_DEVELOPMENT_REASONS.NO_APPROVED_PROPOSAL
      );
    }

    const remainingTasks = await prisma.task.count({
      where: {
        companyUuid,
        proposalUuid: approvedProposal.uuid,
        status: { notIn: FINISHED_TASK_STATUSES },
      },
    });
    if (remainingTasks === 0) {
      throw new StageAdvanceError(
        "PRECONDITION_FAILED",
        "All tasks of the approved proposal are finished",
        START_DEVELOPMENT_REASONS.NO_UNFINISHED_TASKS
      );
    }

    return { proposalUuid: approvedProposal.uuid, remainingTasks };
  },
  // Wake-only: no transition.
  offlinePolicy: "require_online",
};

export async function startDevelopment({
  companyUuid,
  ideaUuid,
  actorUuid,
  actorType,
}: {
  companyUuid: string;
  ideaUuid: string;
  actorUuid: string;
  actorType: string;
}): Promise<void> {
  await executeStageAdvance(START_DEVELOPMENT_STAGE, {
    companyUuid,
    ideaUuid,
    actorUuid,
    actorType,
  });
}
