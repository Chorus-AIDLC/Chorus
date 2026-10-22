// src/types/task-draft.ts
// Role of a proposal task draft. Lives outside the service so tool schemas can
// import it without depending on the service module (tests mock the service).

export const TASK_DRAFT_KINDS = ["implementation", "verification", "docs", "other"] as const;
export type TaskDraftKind = (typeof TASK_DRAFT_KINDS)[number];
