import { z } from "zod";

export const DEFAULT_PAGE = 1;
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;
export const MAX_COLLECTION_JSON_BYTES = 65_536;
export const SUMMARY_TEXT_CODE_POINTS = 256;
export const PREVIEW_TEXT_CODE_POINTS = 512;
const AGGREGATE_LONG_TEXT_CODE_POINTS = 4_096;
const JSON_INDENT = 2;

export const collectionPageSchema = z
  .number()
  .int()
  .positive()
  .default(DEFAULT_PAGE)
  .describe("Page number");

export const collectionPageSizeSchema = z
  .number()
  .int()
  .positive()
  .max(MAX_PAGE_SIZE)
  .default(DEFAULT_PAGE_SIZE)
  .describe(`Items per page (maximum ${MAX_PAGE_SIZE})`);

export interface CollectionPage {
  page: number;
  pageSize: number;
}

export interface CollectionMetadata extends CollectionPage {
  returned: number;
  total: number;
}

export type BoundedCollectionPayload<
  Key extends string,
  Row,
  Extra extends Record<string, unknown> = Record<never, never>,
> = Record<Key, Row[]> & CollectionMetadata & Extra;

export class CollectionPayloadTooLargeError extends Error {
  readonly code = "MCP_COLLECTION_ROW_TOO_LARGE";
  readonly maxBytes = MAX_COLLECTION_JSON_BYTES;

  constructor(readonly collectionKey: string) {
    super(
      `A single ${collectionKey} summary cannot fit within the ${MAX_COLLECTION_JSON_BYTES}-byte MCP collection limit`,
    );
    this.name = "CollectionPayloadTooLargeError";
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        collectionKey: this.collectionKey,
        maxBytes: this.maxBytes,
      },
    };
  }
}

export function truncateCodePoints(
  value: string,
  limit: number = SUMMARY_TEXT_CODE_POINTS,
): string {
  if (!Number.isInteger(limit) || limit < 3) {
    throw new RangeError("Truncation limit must be an integer of at least 3");
  }

  const codePoints = Array.from(value);
  if (codePoints.length <= limit) return value;
  return `${codePoints.slice(0, limit - 3).join("")}...`;
}

export function truncateSummaryText(value: string): string {
  return truncateCodePoints(value, SUMMARY_TEXT_CODE_POINTS);
}

export function truncatePreviewText(value: string): string {
  return truncateCodePoints(value, PREVIEW_TEXT_CODE_POINTS);
}

export function compactCollectionRow<
  const Keys extends readonly string[],
>(
  value: unknown,
  keys: Keys,
  textKeys: readonly string[] = ["title", "name", "label"],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null) return {};
  const source = value as Record<string, unknown>;
  const row: Record<string, unknown> = {};

  for (const key of keys) {
    const field = source[key];
    if (field === undefined) continue;
    row[key] =
      typeof field === "string" && textKeys.includes(key)
        ? truncateSummaryText(field)
        : field;
  }

  return row;
}

export function collectionMetadata(
  returned: number,
  total: number,
  page: number = DEFAULT_PAGE,
  pageSize: number = DEFAULT_PAGE_SIZE,
): CollectionMetadata {
  return { returned, page, pageSize, total };
}

interface BuildCollectionOptions<
  Key extends string,
  Row,
  Extra extends Record<string, unknown>,
> extends CollectionPage {
  collectionKey: Key;
  rows: readonly Row[];
  total: number;
  extra?: Extra;
  maxBytes?: number;
}

/**
 * Builds and measures the exact inner JSON emitted by an MCP collection tool.
 * Rows are removed from the tail until the serialized payload fits.
 */
export function buildBoundedCollectionPayload<
  Key extends string,
  Row,
  Extra extends Record<string, unknown> = Record<never, never>,
>({
  collectionKey,
  rows,
  total,
  page,
  pageSize,
  extra,
  maxBytes = MAX_COLLECTION_JSON_BYTES,
}: BuildCollectionOptions<Key, Row, Extra>): BoundedCollectionPayload<Key, Row, Extra> {
  const emittedRows = [...rows];

  const build = () =>
    ({
      [collectionKey]: emittedRows,
      ...collectionMetadata(emittedRows.length, total, page, pageSize),
      ...(extra ?? ({} as Extra)),
    }) as BoundedCollectionPayload<Key, Row, Extra>;

  let payload = build();
  while (
    emittedRows.length > 0 &&
    Buffer.byteLength(JSON.stringify(payload, null, JSON_INDENT), "utf8") > maxBytes
  ) {
    emittedRows.pop();
    payload = build();
  }

  if (rows.length > 0 && emittedRows.length === 0) {
    throw new CollectionPayloadTooLargeError(collectionKey);
  }
  if (
    Buffer.byteLength(JSON.stringify(payload, null, JSON_INDENT), "utf8") >
    maxBytes
  ) {
    throw new CollectionPayloadTooLargeError(collectionKey);
  }

  return payload;
}

export function serializeBoundedCollection<
  Key extends string,
  Row,
  Extra extends Record<string, unknown> = Record<never, never>,
>(options: BuildCollectionOptions<Key, Row, Extra>): string {
  return JSON.stringify(
    buildBoundedCollectionPayload(options),
    null,
    JSON_INDENT,
  );
}

interface AggregateArray {
  rows: unknown[];
}

const AGGREGATE_COLLECTION_KEYS = new Set([
  "ideas",
  "tasks",
  "notifications",
  "recentActivities",
]);

function collectAggregateArrays(
  value: unknown,
  arrays: AggregateArray[],
  parentKey?: string,
): void {
  if (Array.isArray(value)) {
    if (parentKey && AGGREGATE_COLLECTION_KEYS.has(parentKey)) {
      arrays.push({ rows: value });
    }
    for (const item of value) collectAggregateArrays(item, arrays);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    collectAggregateArrays(child, arrays, key);
  }
}

/**
 * Applies the collection byte ceiling to status/dashboard aggregates while
 * preserving their established object shape. Deep collection tails are
 * removed round-robin until the exact emitted JSON fits.
 */
export function serializeBoundedAggregate(
  value: unknown,
  maxBytes: number = MAX_COLLECTION_JSON_BYTES,
): string {
  const copy = structuredClone(value);
  if (typeof copy === "object" && copy !== null && "agent" in copy) {
    const agent = (copy as { agent?: unknown }).agent;
    if (typeof agent === "object" && agent !== null) {
      for (const key of ["persona", "systemPrompt"] as const) {
        const field = (agent as Record<string, unknown>)[key];
        if (typeof field === "string") {
          (agent as Record<string, unknown>)[key] = truncateCodePoints(
            field,
            AGGREGATE_LONG_TEXT_CODE_POINTS,
          );
        }
      }
    }
  }
  const arrays: AggregateArray[] = [];
  collectAggregateArrays(copy, arrays);

  let text = JSON.stringify(copy, null, JSON_INDENT);
  while (Buffer.byteLength(text, "utf8") > maxBytes) {
    const largest = arrays
      .filter(({ rows }) => rows.length > 0)
      .sort((left, right) => right.rows.length - left.rows.length)[0];
    if (!largest) {
      throw new CollectionPayloadTooLargeError("aggregate");
    }
    largest.rows.pop();
    text = JSON.stringify(copy, null, JSON_INDENT);
  }
  return text;
}

export type CollectionContractEntry =
  | {
      mode: "page";
      collectionKey: string;
      detailSource: "single-get" | "list-authoritative";
    }
  | {
      mode: "bounded";
      collectionKey: string;
      maximumRows: number;
      reason: string;
      detailSource: "single-get" | "discovery";
    }
  | {
      mode: "aggregate";
      collectionKey: string;
      maximumRows: number;
      reason: string;
      detailSource: "aggregate";
    };

/**
 * Executable registry for every current MCP tool whose successful response can
 * contain a resource collection. Migration tests consume this registry.
 */
export const COLLECTION_TOOL_INVENTORY = {
  chorus_list_projects: { mode: "page", collectionKey: "projects", detailSource: "single-get" },
  chorus_get_ideas: { mode: "page", collectionKey: "ideas", detailSource: "single-get" },
  chorus_get_documents: { mode: "page", collectionKey: "documents", detailSource: "single-get" },
  chorus_get_proposals: { mode: "page", collectionKey: "proposals", detailSource: "single-get" },
  chorus_list_tasks: { mode: "page", collectionKey: "tasks", detailSource: "single-get" },
  chorus_get_activity: { mode: "page", collectionKey: "activities", detailSource: "list-authoritative" },
  chorus_get_comments: { mode: "page", collectionKey: "comments", detailSource: "list-authoritative" },
  chorus_get_notifications: { mode: "page", collectionKey: "notifications", detailSource: "list-authoritative" },
  chorus_list_sessions: { mode: "page", collectionKey: "sessions", detailSource: "single-get" },
  chorus_search: {
    mode: "bounded",
    collectionKey: "results",
    maximumRows: 50,
    reason: "Search service enforces a cross-entity result limit.",
    detailSource: "discovery",
  },
  chorus_search_mentionables: {
    mode: "bounded",
    collectionKey: "results",
    maximumRows: 100,
    reason: "Typeahead results use a validated hard limit.",
    detailSource: "discovery",
  },
  chorus_get_available_ideas: {
    mode: "bounded",
    collectionKey: "ideas",
    maximumRows: 50,
    reason: "Assignment discovery deliberately returns at most 50 claim candidates.",
    detailSource: "single-get",
  },
  chorus_get_available_tasks: {
    mode: "bounded",
    collectionKey: "tasks",
    maximumRows: 50,
    reason: "Assignment discovery deliberately returns at most 50 claim candidates.",
    detailSource: "single-get",
  },
  chorus_get_unblocked_tasks: { mode: "page", collectionKey: "tasks", detailSource: "single-get" },
  chorus_get_project_groups: { mode: "page", collectionKey: "groups", detailSource: "single-get" },
  chorus_checkin: {
    mode: "aggregate",
    collectionKey: "notifications",
    maximumRows: 5,
    reason: "Check-in is a bounded status aggregate with at most five notifications.",
    detailSource: "aggregate",
  },
  chorus_get_my_assignments: {
    mode: "aggregate",
    collectionKey: "taskTracker",
    maximumRows: 100,
    reason: "The tracker is a bounded workflow aggregate, not a browsable collection.",
    detailSource: "aggregate",
  },
  chorus_get_group_dashboard: {
    mode: "aggregate",
    collectionKey: "recentActivities",
    maximumRows: 20,
    reason: "Dashboard activity is a fixed-size supporting aggregate.",
    detailSource: "aggregate",
  },
} as const satisfies Record<string, CollectionContractEntry>;

export type CollectionToolName = keyof typeof COLLECTION_TOOL_INVENTORY;

export const COLLECTION_TOOL_META_KEY = "chorus/collection";
export type ToolCollectionClassification = "collection" | "non-collection";

/**
 * Explicit review gate for the complete production tool surface. Do not derive
 * this policy from registration names or inventory membership: every new tool
 * requires a deliberate collection/non-collection decision.
 */
export const TOOL_COLLECTION_CLASSIFICATION = {
  chorus_add_comment: "non-collection",
  chorus_add_reference: "non-collection",
  chorus_admin_approve_proposal: "non-collection",
  chorus_admin_close_proposal: "non-collection",
  chorus_admin_close_task: "non-collection",
  chorus_admin_create_project: "non-collection",
  chorus_admin_create_project_group: "non-collection",
  chorus_admin_delete_document: "non-collection",
  chorus_admin_delete_idea: "non-collection",
  chorus_admin_delete_project_group: "non-collection",
  chorus_admin_delete_task: "non-collection",
  chorus_admin_move_project_to_group: "non-collection",
  chorus_admin_reopen_task: "non-collection",
  chorus_admin_update_project_group: "non-collection",
  chorus_admin_verify_task: "non-collection",
  chorus_answer_elaboration: "non-collection",
  chorus_checkin: "collection",
  chorus_claim_idea: "non-collection",
  chorus_claim_task: "non-collection",
  chorus_close_session: "non-collection",
  chorus_create_report: "non-collection",
  chorus_create_session: "non-collection",
  chorus_create_tasks: "non-collection",
  chorus_edit_idea: "non-collection",
  chorus_get_activity: "collection",
  chorus_get_available_ideas: "collection",
  chorus_get_available_tasks: "collection",
  chorus_get_comments: "collection",
  chorus_get_document: "non-collection",
  chorus_get_documents: "collection",
  chorus_get_elaboration: "non-collection",
  chorus_get_group_dashboard: "collection",
  chorus_get_idea: "non-collection",
  chorus_get_ideas: "collection",
  chorus_get_my_assignments: "collection",
  chorus_get_notifications: "collection",
  chorus_get_project: "non-collection",
  chorus_get_project_group: "non-collection",
  chorus_get_project_groups: "collection",
  chorus_get_proposal: "non-collection",
  chorus_get_proposals: "collection",
  chorus_get_session: "non-collection",
  chorus_get_task: "non-collection",
  chorus_get_unblocked_tasks: "collection",
  chorus_list_projects: "collection",
  chorus_list_sessions: "collection",
  chorus_list_tasks: "collection",
  chorus_mark_acceptance_criteria: "non-collection",
  chorus_mark_notification_read: "non-collection",
  chorus_move_idea: "non-collection",
  chorus_pm_add_document_draft: "non-collection",
  chorus_pm_add_task_draft: "non-collection",
  chorus_pm_assign_idea: "non-collection",
  chorus_pm_assign_task: "non-collection",
  chorus_pm_create_document: "non-collection",
  chorus_pm_create_idea: "non-collection",
  chorus_pm_create_proposal: "non-collection",
  chorus_pm_reject_proposal: "non-collection",
  chorus_pm_remove_document_draft: "non-collection",
  chorus_pm_remove_task_draft: "non-collection",
  chorus_pm_revoke_proposal: "non-collection",
  chorus_pm_skip_elaboration: "non-collection",
  chorus_pm_start_elaboration: "non-collection",
  chorus_pm_submit_proposal: "non-collection",
  chorus_pm_update_document: "non-collection",
  chorus_pm_update_document_draft: "non-collection",
  chorus_pm_update_task_draft: "non-collection",
  chorus_pm_validate_elaboration: "non-collection",
  chorus_pm_validate_proposal: "non-collection",
  chorus_release_idea: "non-collection",
  chorus_release_task: "non-collection",
  chorus_remove_reference: "non-collection",
  chorus_reopen_session: "non-collection",
  chorus_report_criteria_self_check: "non-collection",
  chorus_report_work: "non-collection",
  chorus_search: "collection",
  chorus_search_mentionables: "collection",
  chorus_session_checkin_task: "non-collection",
  chorus_session_checkout_task: "non-collection",
  chorus_session_heartbeat: "non-collection",
  chorus_submit_for_verify: "non-collection",
  chorus_update_reference: "non-collection",
  chorus_update_task: "non-collection",
} as const satisfies Record<string, ToolCollectionClassification>;

export function assertToolClassificationPolicy(
  classifications: Readonly<Record<string, ToolCollectionClassification>>,
): void {
  const missing = Object.entries(classifications)
    .filter(([name, classification]) =>
      classification === "collection" && !(name in COLLECTION_TOOL_INVENTORY)
    )
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(
      `MCP collection tools missing from COLLECTION_TOOL_INVENTORY: ${missing.sort().join(", ")}`,
    );
  }
}

/**
 * Enforces explicit collection classification on the real registerTool path.
 * A new tool cannot be registered until its classification is reviewed.
 */
export function enforceToolClassification<T extends object>(
  server: T,
  classifications: Readonly<Record<string, ToolCollectionClassification>> =
    TOOL_COLLECTION_CLASSIFICATION,
): T {
  assertToolClassificationPolicy(classifications);
  return new Proxy(server, {
    get(target, property, receiver) {
      if (property !== "registerTool") {
        return Reflect.get(target, property, receiver);
      }
      return (name: string, ...args: unknown[]) => {
        if (!(name in classifications)) {
          throw new Error(
            `MCP tool missing explicit collection classification: ${name}`,
          );
        }
        const registerTool = Reflect.get(target, property, receiver);
        if (typeof registerTool !== "function") {
          throw new TypeError("MCP server registerTool must be a function");
        }
        return Reflect.apply(registerTool, target, [name, ...args]);
      };
    },
  });
}

export function collectionToolConfig<T extends object>(
  config: T,
): T & { _meta: Record<string, unknown> } {
  const existingMeta =
    "_meta" in config &&
    typeof config._meta === "object" &&
    config._meta !== null
      ? (config._meta as Record<string, unknown>)
      : {};
  return {
    ...config,
    _meta: {
      ...existingMeta,
      [COLLECTION_TOOL_META_KEY]: true,
    },
  };
}

export function isCollectionToolConfig(config: unknown): boolean {
  if (typeof config !== "object" || config === null) return false;
  const meta = (config as { _meta?: unknown })._meta;
  return (
    typeof meta === "object" &&
    meta !== null &&
    (meta as Record<string, unknown>)[COLLECTION_TOOL_META_KEY] === true
  );
}

export function assertCollectionToolsInventoried(
  registeredCollectionTools: Iterable<string>,
): void {
  const missing = [...registeredCollectionTools].filter(
    (name) => !(name in COLLECTION_TOOL_INVENTORY),
  );
  if (missing.length > 0) {
    throw new Error(
      `MCP collection tools missing from COLLECTION_TOOL_INVENTORY: ${missing.sort().join(", ")}`,
    );
  }
}
