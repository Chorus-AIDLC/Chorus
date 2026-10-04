// Shared input matrix for offline helper and real extension-factory tests.
// Expected operations and reviewers are explicit, independent of runtime maps.
export const WORKFLOW_CASES = [
  ["chorus_pm_submit_proposal", "chorus-proposal-reviewer", "CHORUS_ENABLE_PROPOSAL_REVIEWER"],
  ["chorus_submit_for_verify", "chorus-task-reviewer", "CHORUS_ENABLE_TASK_REVIEWER"],
  ["chorus_admin_verify_task", "chorus-code-reviewer", "CHORUS_ENABLE_CODE_REVIEWER"],
] as const;

export const WORKFLOW_PREFIXES = [
  "",
  "chorus_",
  "mcp__chorus__",
  "mcp__chorus.",
  "chorus__",
  "custom.namespace.",
  "x",
  "custom.gateway.",
  "mcp",
  "mcp__chorus",
] as const;

export const NON_TARGET_OUTER_NAMES = [
  "mcp",
  "mcp__chorus",
  "bash",
  "mcpScript",
  "mcp__other",
  "custom.mcp",
  "chorus_get_task",
  "",
  null,
  42,
] as const;

export const INVALID_NAMES: unknown[] = [
  "",
  undefined,
  null,
  0,
  42,
  true,
  false,
  {},
  [],
  ["chorus_submit_for_verify"],
  new String("chorus_submit_for_verify"),
  { toString: () => "chorus_submit_for_verify" },
  Symbol("chorus_submit_for_verify"),
  "chorus_checkin",
  "chorus_get_task",
  "chorus_chorus_get_task",
  "mcp__chorus__chorus_checkin",
  "bash",
  "constructor",
  "toString",
];

export function invalidWorkflowNames(operation: string): string[] {
  return WORKFLOW_PREFIXES.flatMap((prefix) => [
    `${prefix}${operation}_extra`,
    `${prefix}${operation} `,
    `${prefix}${operation}\t`,
    `${prefix}${operation}\n`,
    `${prefix}${operation}\r\n`,
    `${prefix}${operation.slice(0, -1)}`,
    `${prefix}${operation.toUpperCase()}`,
    `${prefix}${operation.replace("chorus_", "chorus-")}`,
  ]);
}

export const MALFORMED_INPUTS: unknown[] = [
  undefined,
  null,
  "",
  "chorus_submit_for_verify",
  42,
  true,
  false,
  {},
  { name: "chorus_submit_for_verify" },
  [{ tool: "chorus_submit_for_verify" }],
  Object.assign([], { tool: "chorus_submit_for_verify" }),
  Object.assign(() => {}, { tool: "chorus_submit_for_verify" }),
];
