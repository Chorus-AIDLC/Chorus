// src/services/yolo-request.service.ts
// The `yolo_requested` stage-advance event: a human clicks 「Yolo」 on an Idea
// assigned to a daemon agent, and that agent is woken (session-origin-pinned,
// dedicated `yolo_requested` trigger) to drive the WHOLE idea to done via the
// yolo skill (full-auto AI-DLC pipeline), self-selecting the entry phase from
// the idea's current state.
//
// Mirrors `start-development.service.ts`, with two deliberate differences:
//   1. The precondition checks ONLY that the assignee is an agent — NOT that an
//      approved proposal or unfinished task exists. The Yolo button is shown at
//      ANY incomplete stage (elaboration decision Q1), so the event must accept
//      an idea that has no proposal yet.
//   2. There are no proposal/task precondition sub-codes — the only
//      distinguishable precondition failure is "assignee is not an agent".
//
// The event is wake-only: it performs NO Idea state transition. Its offline
// policy is `require_online` (inherited from start_development): a human
// clicking "Yolo" expects the run to start now or a clear agent-offline error,
// not a silent queue.

import {
  executeStageAdvance,
  StageAdvanceError,
  type StageAdvanceDefinition,
} from "@/services/stage-advance.service";

const YOLO_REQUESTED_STAGE: StageAdvanceDefinition = {
  action: "yolo_requested",
  precondition: async ({ idea }) => {
    // The wake needs a daemon to land on: the assignee must be an agent (or a
    // pinned agent_instance). The require_online policy re-resolves the owning
    // agent for the liveness check; failing early here gives the UI the sharper
    // "assignee is not an agent" message instead of a liveness error.
    //
    // Unlike start_development there is NO proposal/task lookup: Yolo drives the
    // idea from whatever stage it is in, so an idea with no proposal is a valid
    // target (the woken agent's yolo skill will create one).
    if (idea.assigneeType !== "agent" && idea.assigneeType !== "agent_instance") {
      throw new StageAdvanceError(
        "ASSIGNEE_NOT_AGENT",
        "The Idea's assignee is not an agent — there is no daemon to wake"
      );
    }

    return {};
  },
  // Wake-only: no transition.
  offlinePolicy: "require_online",
};

export async function requestYolo({
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
  await executeStageAdvance(YOLO_REQUESTED_STAGE, {
    companyUuid,
    ideaUuid,
    actorUuid,
    actorType,
  });
}
