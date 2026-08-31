// src/__tests__/fixtures/agentInstanceFixture.ts
//
// Shared in-memory Prisma stub + scenario seeder for the AgentInstance-addressing
// integration test (add-agent-instance-addressing, the regression safety net).
//
// Unlike cascadeMoveFixture — whose mock prisma supports only the handful of
// operators moveIdea performs — this fixture stands up a SMALL GENERIC in-memory
// prisma engine, because the integration test drives a much wider seam: the wake
// chokepoint (notification-turn.createTurnAndResolveTarget) composes the lineage
// resolver, the daemon-session service, and the connection registry, and the
// assignee helpers (uuid-resolver) + idea-tracker run real against the same store.
//
// What runs REAL against this store:
//   - idea.service     : claimIdea / assignIdea (agent_instance pin + revert) + getIdeaByUuid
//   - task.service     : getTaskByUuid
//   - proposal.service : getProposalByUuid
//   - lineage.service  : resolveRootIdea (task→proposal→idea walk)
//   - uuid-resolver    : buildAssigneeMatch / resolveAssigneeAgentUuid / formatIdeaResponse helpers
//   - idea-tracker     : buildIdeaTracker / buildTaskTracker
//   - daemon-connection: listInstancesForAgent / listConnectionsForAgent / resolveInstanceByTuple
//   - daemon-session   : resolveOrCreateSession / createPendingTurn (real seq allocation)
//   - notification-turn: createTurnAndResolveTarget (the full pin→inherit→degrade resolution)
//
// What is MOCKED (external side effects only, never the logic under test):
//   - @/lib/event-bus                       (emitChange / emit — no SSE)
//   - @/services/daemon-instruction.service (deliverTurnPing — no control-channel ping)
//
// The generic engine supports exactly the operators the above call sites use:
//   findFirst / findUnique / findMany / create / update / upsert / count,
//   where (scalar eq, { in }, nested relation { is }/{ some }/scalar), the
//   `agentUuid_sessionId` compound-unique where, `select` (incl. nested relation
//   select), `include` (project / agent / connections / agentInstance), and
//   `orderBy` (single key, used by createPendingTurn's seq lookup).

import { vi } from "vitest";
import type { AuthContext } from "@/types/auth";

// ===== Row types (only the fields the exercised services read/write) =====

export interface UserRow {
  uuid: string;
  companyUuid: string;
  name: string | null;
  email: string | null;
}

export interface AgentRow {
  uuid: string;
  companyUuid: string;
  name: string;
  ownerUuid: string | null;
  // Optional authz fields — the base scenario omits them (the addressing test
  // never gates on permissions), but the assign-idea end-to-end test seeds them
  // so getAgentByUuid → computeEffectivePermissions sees the target's idea:write.
  roles?: string[];
  permissions?: string[];
}

export interface AgentInstanceRow {
  uuid: string;
  companyUuid: string;
  agentUuid: string;
  host: string;
  cwd: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DaemonConnectionRow {
  uuid: string;
  companyUuid: string;
  agentUuid: string;
  clientType: string;
  clientVersion: string | null;
  host: string;
  cwd: string | null;
  startedAt: Date | null;
  status: string; // "online" | "offline"
  connectedAt: Date;
  lastSeenAt: Date;
  disconnectedAt: Date | null;
  agentInstanceUuid: string | null;
}

export interface IdeaRow {
  uuid: string;
  companyUuid: string;
  projectUuid: string;
  title: string;
  content: string | null;
  attachments: unknown;
  status: string;
  elaborationStatus: string | null;
  elaborationDepth: string | null;
  parentUuid: string | null;
  assigneeType: string | null;
  assigneeUuid: string | null;
  cwdSource?: string | null;
  cwdHost?: string | null;
  runtimeCwd?: string | null;
  assignedAt: Date | null;
  assignedByUuid: string | null;
  createdByUuid: string;
  createdByType?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProposalRow {
  uuid: string;
  companyUuid: string;
  projectUuid: string;
  title: string;
  description: string | null;
  inputType: string;
  inputUuids: string[];
  status: string;
  createdByUuid: string;
  createdByType: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface TaskRow {
  uuid: string;
  companyUuid: string;
  projectUuid: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  storyPoints: number | null;
  acceptanceCriteria: string | null;
  assigneeType: string | null;
  assigneeUuid: string | null;
  assignedAt: Date | null;
  assignedByUuid: string | null;
  proposalUuid: string | null;
  createdByUuid: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProjectRow {
  uuid: string;
  companyUuid: string;
  name: string;
}

export interface DaemonSessionRow {
  uuid: string;
  companyUuid: string;
  agentUuid: string;
  sessionId: string;
  directIdeaUuid: string | null;
  originConnectionUuid: string;
  status: string;
  title: string | null;
  lastTurnAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface DaemonSessionTurnRow {
  uuid: string;
  sessionUuid: string;
  backendSessionId: string | null;
  seq: number;
  trigger: string;
  promptText: string | null;
  status: string;
  executionUuid: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  createdAt: Date;
}

// Activity / notification / notification-preference rows — only exercised by the
// assign-idea end-to-end integration test, which drives the REAL notification
// listener (handleActivity) + notification.service (createBatch) over this store
// to assert idea_claimed recipient resolution and preference gating. Additive: the
// addressing test never touches these arrays.
export interface ActivityRow {
  uuid: string;
  companyUuid: string;
  projectUuid: string;
  targetType: string;
  targetUuid: string;
  actorType: string;
  actorUuid: string;
  action: string;
  value: unknown;
  sessionUuid: string | null;
  sessionName: string | null;
  createdAt: Date;
}

export interface NotificationRow {
  uuid: string;
  companyUuid: string;
  projectUuid: string;
  recipientType: string;
  recipientUuid: string;
  entityType: string;
  entityUuid: string;
  entityTitle: string;
  projectName: string;
  action: string;
  message: string;
  actorType: string;
  actorUuid: string;
  actorName: string;
  instructionText: string | null;
  readAt: Date | null;
  archivedAt: Date | null;
  createdAt: Date;
}

export interface NotificationPreferenceRow {
  uuid: string;
  companyUuid: string;
  ownerType: string;
  ownerUuid: string;
  taskAssigned: boolean;
  taskStatusChanged: boolean;
  taskVerified: boolean;
  taskReopened: boolean;
  proposalSubmitted: boolean;
  proposalApproved: boolean;
  proposalRejected: boolean;
  ideaClaimed: boolean;
  commentAdded: boolean;
  elaborationRequested: boolean;
  elaborationAnswered: boolean;
  mentioned: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// Per-(user, project, agent) fixed-cwd preference read by the autonomous-wake
// project-cwd fallback (notification-turn.resolveProjectOwnerCwdPin). Left EMPTY by
// the seeds so the fallback cleanly returns null → online-first (no owner pin); the
// model must merely exist so the query does not throw.
export interface ProjectAgentCwdPreferenceRow {
  uuid: string;
  companyUuid: string;
  userUuid: string;
  projectUuid: string;
  agentUuid: string;
  host: string | null;
  cwd: string | null;
  anchorAgentInstanceUuid?: string | null;
}

export interface AgentInstanceStore {
  users: UserRow[];
  agents: AgentRow[];
  agentInstances: AgentInstanceRow[];
  daemonConnections: DaemonConnectionRow[];
  ideas: IdeaRow[];
  proposals: ProposalRow[];
  tasks: TaskRow[];
  projects: ProjectRow[];
  daemonSessions: DaemonSessionRow[];
  daemonSessionTurns: DaemonSessionTurnRow[];
  activities: ActivityRow[];
  notifications: NotificationRow[];
  notificationPreferences: NotificationPreferenceRow[];
  projectAgentCwdPreferences: ProjectAgentCwdPreferenceRow[];
}

export const agentInstanceStore: AgentInstanceStore = {
  users: [],
  agents: [],
  agentInstances: [],
  daemonConnections: [],
  ideas: [],
  proposals: [],
  tasks: [],
  projects: [],
  daemonSessions: [],
  daemonSessionTurns: [],
  activities: [],
  notifications: [],
  notificationPreferences: [],
  projectAgentCwdPreferences: [],
};

export function resetAgentInstanceStore() {
  agentInstanceStore.users = [];
  agentInstanceStore.agents = [];
  agentInstanceStore.agentInstances = [];
  agentInstanceStore.daemonConnections = [];
  agentInstanceStore.ideas = [];
  agentInstanceStore.proposals = [];
  agentInstanceStore.tasks = [];
  agentInstanceStore.projects = [];
  agentInstanceStore.daemonSessions = [];
  agentInstanceStore.daemonSessionTurns = [];
  agentInstanceStore.activities = [];
  agentInstanceStore.notifications = [];
  agentInstanceStore.notificationPreferences = [];
  agentInstanceStore.projectAgentCwdPreferences = [];
}

// ===== Generic where-clause matcher =====
//
// Supports the operators the exercised call sites use:
//   - scalar equality (incl. null)
//   - { in: [...] }
//   - { not: <scalar> } / { notIn: [...] }
//   - OR: [...] (array of sub-wheres)
//   - nested relation object: { agent: { ownerUuid: x } } / { is: {...} } / { some: {...} }
// Relation keys are resolved against the store via `relationResolvers`.

type Where = Record<string, unknown> | undefined;

interface RelationResolver {
  // Resolve the related row(s) for a parent row. `kind` = "one" (belongs-to) or
  // "many" (has-many). Returns the concrete fixture row(s) — coerced to the
  // generic record shape at the consumption sites (matchesWhere / hydrateRelation).
  kind: "one" | "many";
  resolve: (row: Record<string, unknown>) => unknown;
}

function matchScalar(actual: unknown, expected: unknown): boolean {
  if (expected !== null && typeof expected === "object") {
    const op = expected as Record<string, unknown>;
    if ("in" in op) {
      return (op.in as unknown[]).includes(actual);
    }
    if ("notIn" in op) {
      return !(op.notIn as unknown[]).includes(actual);
    }
    if ("not" in op) {
      return actual !== op.not;
    }
    // Unknown operator object — fall back to strict equality on the object.
    return actual === expected;
  }
  return actual === expected;
}

export function matchesWhere(
  row: Record<string, unknown>,
  where: Where,
  relations: Record<string, RelationResolver> = {},
): boolean {
  if (!where) return true;
  for (const [key, expected] of Object.entries(where)) {
    if (key === "OR") {
      const branches = expected as Where[];
      if (!branches.some((b) => matchesWhere(row, b, relations))) return false;
      continue;
    }
    if (key === "AND") {
      const branches = expected as Where[];
      if (!branches.every((b) => matchesWhere(row, b, relations))) return false;
      continue;
    }
    // Nested relation filter: { agent: { ownerUuid: x } } or { is: {...} }/{ some: {...} }.
    const relation = relations[key];
    if (relation) {
      const related = relation.resolve(row);
      const filter = expected as Record<string, unknown>;
      if (relation.kind === "one") {
        const target = (filter.is ?? filter) as Where;
        if (!related || Array.isArray(related)) return false;
        if (!matchesWhere(related as Record<string, unknown>, target, relations)) return false;
      } else {
        const someFilter = (filter.some ?? filter) as Where;
        const list = (related as Record<string, unknown>[]) ?? [];
        if (!list.some((r) => matchesWhere(r, someFilter, relations))) return false;
      }
      continue;
    }
    if (!matchScalar(row[key], expected)) return false;
  }
  return true;
}

// ===== select / include projection =====
//
// Applies a Prisma `select` (scalar fields + nested relation select) or `include`
// (relation only) onto a row, hydrating relations from the store. Without select/
// include the full row is returned (matching Prisma default).

function projectRow(
  row: Record<string, unknown>,
  opts: { select?: Record<string, unknown>; include?: Record<string, unknown> },
  relations: Record<string, RelationResolver>,
): Record<string, unknown> {
  const { select, include } = opts;
  if (!select && !include) return { ...row };

  const out: Record<string, unknown> = {};

  if (select) {
    for (const [key, val] of Object.entries(select)) {
      if (val === false || val == null) continue;
      const relation = relations[key];
      if (relation) {
        out[key] = hydrateRelation(row, relation, typeof val === "object" ? (val as Record<string, unknown>) : undefined, relations);
      } else if (val === true) {
        out[key] = row[key];
      }
    }
    return out;
  }

  // include: full row + the listed relations.
  Object.assign(out, row);
  for (const [key, val] of Object.entries(include!)) {
    if (val === false || val == null) continue;
    const relation = relations[key];
    if (relation) {
      const nested =
        typeof val === "object" && val !== null ? (val as Record<string, unknown>) : undefined;
      out[key] = hydrateRelation(row, relation, nested, relations);
    }
  }
  return out;
}

function hydrateRelation(
  row: Record<string, unknown>,
  relation: RelationResolver,
  nested: Record<string, unknown> | undefined,
  relations: Record<string, RelationResolver>,
): unknown {
  const related = relation.resolve(row);
  const select = nested?.select as Record<string, unknown> | undefined;
  const include = nested?.include as Record<string, unknown> | undefined;
  if (relation.kind === "one") {
    if (!related || Array.isArray(related)) return null;
    return projectRow(related as Record<string, unknown>, { select, include }, relations);
  }
  const list = (related as Record<string, unknown>[]) ?? [];
  return list.map((r) => projectRow(r, { select, include }, relations));
}

// ===== Generic model factory =====

interface ModelOptions {
  relations?: Record<string, RelationResolver>;
  // Compound-unique `where` keys (e.g. agentUuid_sessionId) expanded to their
  // component scalar match before the generic matcher runs.
  compoundKeys?: Record<string, string[]>;
  // Default field values applied on `create`/`upsert.create` when absent.
  defaults?: () => Record<string, unknown>;
}

function normalizeWhere(
  where: Record<string, unknown> | undefined,
  compoundKeys: Record<string, string[]>,
): Record<string, unknown> | undefined {
  if (!where) return where;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(where)) {
    if (compoundKeys[key] && val && typeof val === "object") {
      // Expand { agentUuid_sessionId: { agentUuid, sessionId } } → flat scalars.
      Object.assign(out, val as Record<string, unknown>);
    } else {
      out[key] = val;
    }
  }
  return out;
}

function makeModel<T extends Record<string, unknown>>(
  getRows: () => T[],
  options: ModelOptions = {},
) {
  const relations = options.relations ?? {};
  const compoundKeys = options.compoundKeys ?? {};

  const findOne = (args: { where?: Where; select?: Record<string, unknown>; include?: Record<string, unknown> } = {}) => {
    const where = normalizeWhere(args.where as Record<string, unknown> | undefined, compoundKeys);
    const row = getRows().find((r) => matchesWhere(r, where, relations));
    if (!row) return null;
    return projectRow(row, { select: args.select, include: args.include }, relations);
  };

  return {
    findFirst: vi.fn(async (args: { where?: Where; select?: Record<string, unknown>; include?: Record<string, unknown>; orderBy?: Record<string, "asc" | "desc"> } = {}) => {
      const where = normalizeWhere(args.where as Record<string, unknown> | undefined, compoundKeys);
      let rows = getRows().filter((r) => matchesWhere(r, where, relations));
      if (args.orderBy) {
        const [[key, dir]] = Object.entries(args.orderBy);
        rows = [...rows].sort((a, b) => {
          const av = a[key] as number;
          const bv = b[key] as number;
          return dir === "desc" ? bv - av : av - bv;
        });
      }
      const row = rows[0];
      if (!row) return null;
      return projectRow(row, { select: args.select, include: args.include }, relations);
    }),
    findUnique: vi.fn(async (args: { where?: Where; select?: Record<string, unknown>; include?: Record<string, unknown> } = {}) =>
      findOne(args),
    ),
    findMany: vi.fn(async (args: { where?: Where; select?: Record<string, unknown>; include?: Record<string, unknown> } = {}) => {
      const where = normalizeWhere(args.where as Record<string, unknown> | undefined, compoundKeys);
      const rows = getRows().filter((r) => matchesWhere(r, where, relations));
      return rows.map((r) => projectRow(r, { select: args.select, include: args.include }, relations));
    }),
    count: vi.fn(async (args: { where?: Where } = {}) => {
      const where = normalizeWhere(args.where as Record<string, unknown> | undefined, compoundKeys);
      return getRows().filter((r) => matchesWhere(r, where, relations)).length;
    }),
    create: vi.fn(async (args: { data: Record<string, unknown>; select?: Record<string, unknown>; include?: Record<string, unknown> }) => {
      const row = { ...(options.defaults?.() ?? {}), ...args.data } as T;
      getRows().push(row);
      return projectRow(row, { select: args.select, include: args.include }, relations);
    }),
    update: vi.fn(async (args: { where: Where; data: Record<string, unknown>; select?: Record<string, unknown>; include?: Record<string, unknown> }) => {
      const where = normalizeWhere(args.where as Record<string, unknown> | undefined, compoundKeys);
      const row = getRows().find((r) => matchesWhere(r, where, relations));
      if (!row) throw new Error("Row not found for update");
      Object.assign(row, args.data);
      return projectRow(row, { select: args.select, include: args.include }, relations);
    }),
    upsert: vi.fn(async (args: { where: Where; create: Record<string, unknown>; update: Record<string, unknown>; select?: Record<string, unknown>; include?: Record<string, unknown> }) => {
      const where = normalizeWhere(args.where as Record<string, unknown> | undefined, compoundKeys);
      const existing = getRows().find((r) => matchesWhere(r, where, relations));
      if (existing) {
        Object.assign(existing, args.update);
        return projectRow(existing, { select: args.select, include: args.include }, relations);
      }
      const row = { ...(options.defaults?.() ?? {}), ...args.create } as T;
      getRows().push(row);
      return projectRow(row, { select: args.select, include: args.include }, relations);
    }),
  };
}

let uuidCounter = 0;
function nextUuid(prefix: string): string {
  uuidCounter += 1;
  return `${prefix}-generated-${uuidCounter}`;
}

// ===== Mock prisma builder =====

export function buildMockPrisma() {
  const agentByUuid = (uuid: string | null | undefined) =>
    agentInstanceStore.agents.find((a) => a.uuid === uuid) ?? null;

  const mockPrisma = {
    user: makeModel<UserRow & Record<string, unknown>>(() => agentInstanceStore.users as (UserRow & Record<string, unknown>)[]),
    agent: makeModel<AgentRow & Record<string, unknown>>(() => agentInstanceStore.agents as (AgentRow & Record<string, unknown>)[]),
    agentInstance: makeModel<AgentInstanceRow & Record<string, unknown>>(
      () => agentInstanceStore.agentInstances as (AgentInstanceRow & Record<string, unknown>)[],
      {
        compoundKeys: {
          companyUuid_agentUuid_host_cwd: [
            "companyUuid",
            "agentUuid",
            "host",
            "cwd",
          ],
        },
        defaults: () => ({
          uuid: nextUuid("instance"),
          host: "",
          cwd: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
        relations: {
          agent: {
            kind: "one",
            resolve: (row) => agentByUuid(row.agentUuid as string),
          },
          connections: {
            kind: "many",
            resolve: (row) =>
              agentInstanceStore.daemonConnections.filter(
                (c) => c.agentInstanceUuid === row.uuid,
              ) as unknown as Record<string, unknown>[],
          },
        },
      },
    ),
    daemonConnection: makeModel<DaemonConnectionRow & Record<string, unknown>>(
      () => agentInstanceStore.daemonConnections as (DaemonConnectionRow & Record<string, unknown>)[],
      {
        relations: {
          agent: {
            kind: "one",
            resolve: (row) => agentByUuid(row.agentUuid as string),
          },
          agentInstance: {
            kind: "one",
            resolve: (row) =>
              agentInstanceStore.agentInstances.find(
                (i) => i.uuid === row.agentInstanceUuid,
              ) ?? null,
          },
        },
      },
    ),
    idea: makeModel<IdeaRow & Record<string, unknown>>(
      () => agentInstanceStore.ideas as (IdeaRow & Record<string, unknown>)[],
      {
        relations: {
          project: {
            kind: "one",
            resolve: (row) =>
              agentInstanceStore.projects.find((p) => p.uuid === row.projectUuid) ?? null,
          },
        },
      },
    ),
    proposal: makeModel<ProposalRow & Record<string, unknown>>(
      () => agentInstanceStore.proposals as (ProposalRow & Record<string, unknown>)[],
    ),
    task: makeModel<TaskRow & Record<string, unknown>>(
      () => agentInstanceStore.tasks as (TaskRow & Record<string, unknown>)[],
      {
        relations: {
          project: {
            kind: "one",
            resolve: (row) =>
              agentInstanceStore.projects.find((p) => p.uuid === row.projectUuid) ?? null,
          },
          acceptanceCriteriaItems: {
            kind: "many",
            resolve: () => [],
          },
        },
      },
    ),
    project: makeModel<ProjectRow & Record<string, unknown>>(
      () => agentInstanceStore.projects as (ProjectRow & Record<string, unknown>)[],
    ),
    daemonSession: makeModel<DaemonSessionRow & Record<string, unknown>>(
      () => agentInstanceStore.daemonSessions as (DaemonSessionRow & Record<string, unknown>)[],
      {
        compoundKeys: { agentUuid_sessionId: ["agentUuid", "sessionId"] },
        defaults: () => ({
          uuid: nextUuid("session"),
          status: "active",
          title: null,
          lastTurnAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      },
    ),
    daemonSessionTurn: makeModel<DaemonSessionTurnRow & Record<string, unknown>>(
      () => agentInstanceStore.daemonSessionTurns as (DaemonSessionTurnRow & Record<string, unknown>)[],
      {
        defaults: () => ({
          uuid: nextUuid("turn"),
          promptText: null,
          status: "pending",
          executionUuid: null,
          startedAt: null,
          endedAt: null,
          createdAt: new Date(),
        }),
      },
    ),
    // activity.service.createActivity writes here; the assign-idea end-to-end test
    // reads the persisted `assigned` idea Activity back to assert actorType.
    activity: makeModel<ActivityRow & Record<string, unknown>>(
      () => agentInstanceStore.activities as (ActivityRow & Record<string, unknown>)[],
      {
        defaults: () => ({
          uuid: nextUuid("activity"),
          value: null,
          sessionUuid: null,
          sessionName: null,
          createdAt: new Date(),
        }),
      },
    ),
    // notification.service.createBatch/createReturningTurn write here; the end-to-end
    // test reads the persisted rows back to assert the resolved wake recipient.
    notification: makeModel<NotificationRow & Record<string, unknown>>(
      () => agentInstanceStore.notifications as (NotificationRow & Record<string, unknown>)[],
      {
        defaults: () => ({
          uuid: nextUuid("notification"),
          instructionText: null,
          readAt: null,
          archivedAt: null,
          createdAt: new Date(),
        }),
      },
    ),
    // getPreferences reads/creates here (compound-unique ownerType_ownerUuid). Defaults
    // mirror the Prisma schema (@default(true)) so an auto-created pref row is fully
    // enabled — the test only flips ideaClaimed off explicitly to prove pref gating.
    notificationPreference: makeModel<NotificationPreferenceRow & Record<string, unknown>>(
      () => agentInstanceStore.notificationPreferences as (NotificationPreferenceRow & Record<string, unknown>)[],
      {
        compoundKeys: { ownerType_ownerUuid: ["ownerType", "ownerUuid"] },
        defaults: () => ({
          uuid: nextUuid("notif-pref"),
          taskAssigned: true,
          taskStatusChanged: true,
          taskVerified: true,
          taskReopened: true,
          proposalSubmitted: true,
          proposalApproved: true,
          proposalRejected: true,
          ideaClaimed: true,
          commentAdded: true,
          elaborationRequested: true,
          elaborationAnswered: true,
          mentioned: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      },
    ),
    // Read by the autonomous-wake project-cwd fallback (resolveProjectOwnerCwdPin);
    // left empty by the seeds → findFirst returns null → clean online-first selection.
    projectAgentCwdPreference: makeModel<ProjectAgentCwdPreferenceRow & Record<string, unknown>>(
      () => agentInstanceStore.projectAgentCwdPreferences as (ProjectAgentCwdPreferenceRow & Record<string, unknown>)[],
    ),
  };

  return mockPrisma;
}

// ===== Scenario seed identifiers =====

export const COMPANY = "company-ai-instance";
export const PROJECT = "project-ai-instance";

// Agent X with two instances A and B; agent Y with its own instance.
export const AGENT_X = "agent-x-0001";
export const AGENT_Y = "agent-y-0002";
export const OWNER = "owner-user-0001";

export const INSTANCE_A = "instance-a-host-alpha-cwd1";
export const INSTANCE_B = "instance-b-host-beta-cwd2";
export const INSTANCE_Y = "instance-y-host-gamma-cwd3";

export const CONN_A = "conn-a";
export const CONN_B = "conn-b";
export const CONN_Y = "conn-y";

export const IDEA_UUID = "idea-pinned-root-0001";
export const PROPOSAL_UUID = "proposal-derived-0001";
export const TASK_INHERIT = "task-inherit-x-0001"; // assigned to agent X (no override)
export const TASK_CROSS = "task-cross-y-0001"; // assigned to agent Y
export const TASK_OVERRIDE = "task-override-b-0001"; // pinned to instance B directly

const HOST_A = "host-alpha";
const CWD_A = "/work/alpha";
const HOST_B = "host-beta";
const CWD_B = "/work/beta";
// Agent Y's instance DELIBERATELY COLLIDES on instance A's (host, cwd) place. This
// makes the same-agent guard LOAD-BEARING: if a regression let agent Y inherit the
// idea's instance-A pin, the wake would find Y's own ONLINE connection at this exact
// place and resolve DIRECTED (non-null targetConnectionUuid). Because the guard holds,
// Y resolves online-first (null target) instead — so the cross-agent test would FAIL
// if the guard were removed. (Same-place identity differs only by owning agent.)
const HOST_Y = "host-alpha";
const CWD_Y = "/work/alpha";

export interface AgentInstanceScenario {
  companyUuid: string;
  projectUuid: string;
  agentX: string;
  agentY: string;
  ownerUuid: string;
  instanceA: string;
  instanceB: string;
  instanceY: string;
  connA: string;
  connB: string;
  connY: string;
  ideaUuid: string;
  proposalUuid: string;
  taskInherit: string;
  taskCross: string;
  taskOverride: string;
  hostA: string;
  cwdA: string;
  hostB: string;
  cwdB: string;
  hostY: string;
  cwdY: string;
}

/**
 * Seed: agent X with two ONLINE instances (A, B), agent Y with one online
 * instance (Y). One idea (initially un-assigned), one derived approved proposal,
 * three tasks: an inherit task (agent X, no override), a cross-agent task (agent
 * Y), and an override task (pinned to instance B). The store MUST be reset via
 * resetAgentInstanceStore() before each call.
 *
 * All three instances start ONLINE (a fresh `online` connection linked to each).
 */
export function seedAgentInstanceScenario(): AgentInstanceScenario {
  const now = new Date();

  agentInstanceStore.projects.push({ uuid: PROJECT, companyUuid: COMPANY, name: "AI Instance Project" });

  // The owner user — createdByUuid on the idea resolves through formatCreatedBy.
  agentInstanceStore.users.push({ uuid: OWNER, companyUuid: COMPANY, name: "Owner User", email: "owner@example.com" });

  agentInstanceStore.agents.push(
    { uuid: AGENT_X, companyUuid: COMPANY, name: "Agent X", ownerUuid: OWNER },
    { uuid: AGENT_Y, companyUuid: COMPANY, name: "Agent Y", ownerUuid: OWNER },
  );

  // Durable instances (identity only — liveness lives on the connection).
  agentInstanceStore.agentInstances.push(
    { uuid: INSTANCE_A, companyUuid: COMPANY, agentUuid: AGENT_X, host: HOST_A, cwd: CWD_A, createdAt: now, updatedAt: now },
    { uuid: INSTANCE_B, companyUuid: COMPANY, agentUuid: AGENT_X, host: HOST_B, cwd: CWD_B, createdAt: now, updatedAt: now },
    { uuid: INSTANCE_Y, companyUuid: COMPANY, agentUuid: AGENT_Y, host: HOST_Y, cwd: CWD_Y, createdAt: now, updatedAt: now },
  );

  // Live connections linked to each instance (all online, fresh lastSeenAt).
  const mkConn = (uuid: string, agentUuid: string, host: string, cwd: string, instanceUuid: string): DaemonConnectionRow => ({
    uuid,
    companyUuid: COMPANY,
    agentUuid,
    clientType: "claude-code",
    clientVersion: "0.11.2",
    host,
    cwd,
    startedAt: now,
    status: "online",
    connectedAt: now,
    lastSeenAt: now,
    disconnectedAt: null,
    agentInstanceUuid: instanceUuid,
  });
  agentInstanceStore.daemonConnections.push(
    mkConn(CONN_A, AGENT_X, HOST_A, CWD_A, INSTANCE_A),
    mkConn(CONN_B, AGENT_X, HOST_B, CWD_B, INSTANCE_B),
    mkConn(CONN_Y, AGENT_Y, HOST_Y, CWD_Y, INSTANCE_Y),
  );

  // Idea — starts open / un-assigned; the test assigns it through the real service.
  agentInstanceStore.ideas.push({
    uuid: IDEA_UUID,
    companyUuid: COMPANY,
    projectUuid: PROJECT,
    title: "Idea-rooted pin lifecycle",
    content: "body",
    attachments: null,
    status: "open",
    elaborationStatus: null,
    elaborationDepth: null,
    parentUuid: null,
    assigneeType: null,
    assigneeUuid: null,
    assignedAt: null,
    assignedByUuid: null,
    createdByUuid: OWNER,
    createdByType: "user",
    createdAt: now,
    updatedAt: now,
  });

  // Derived proposal (inputType=idea, inputUuids=[idea]).
  agentInstanceStore.proposals.push({
    uuid: PROPOSAL_UUID,
    companyUuid: COMPANY,
    projectUuid: PROJECT,
    title: "Derived proposal",
    description: null,
    inputType: "idea",
    inputUuids: [IDEA_UUID],
    status: "approved",
    createdByUuid: AGENT_X,
    createdByType: "agent",
    createdAt: now,
    updatedAt: now,
  });

  // Inherit task — assigned to plain agent X (no instance override). Wakes should
  // inherit the idea's pinned instance via the root-idea step (same-agent guard).
  agentInstanceStore.tasks.push({
    uuid: TASK_INHERIT,
    companyUuid: COMPANY,
    projectUuid: PROJECT,
    title: "Inherit task (agent X, no override)",
    description: null,
    status: "assigned",
    priority: "high",
    storyPoints: 2,
    acceptanceCriteria: null,
    assigneeType: "agent",
    assigneeUuid: AGENT_X,
    assignedAt: now,
    assignedByUuid: null,
    proposalUuid: PROPOSAL_UUID,
    createdByUuid: AGENT_X,
    createdAt: now,
    updatedAt: now,
  });

  // Cross-agent task — assigned to agent Y. Must NOT inherit X's idea instance.
  agentInstanceStore.tasks.push({
    uuid: TASK_CROSS,
    companyUuid: COMPANY,
    projectUuid: PROJECT,
    title: "Cross-agent task (agent Y)",
    description: null,
    status: "assigned",
    priority: "high",
    storyPoints: 2,
    acceptanceCriteria: null,
    assigneeType: "agent",
    assigneeUuid: AGENT_Y,
    assignedAt: now,
    assignedByUuid: null,
    proposalUuid: PROPOSAL_UUID,
    createdByUuid: AGENT_X,
    createdAt: now,
    updatedAt: now,
  });

  // Override task — pinned directly to instance B (agent X). The per-task override
  // beats the inherited idea instance.
  agentInstanceStore.tasks.push({
    uuid: TASK_OVERRIDE,
    companyUuid: COMPANY,
    projectUuid: PROJECT,
    title: "Override task (pinned to instance B)",
    description: null,
    status: "assigned",
    priority: "high",
    storyPoints: 2,
    acceptanceCriteria: null,
    assigneeType: "agent_instance",
    assigneeUuid: INSTANCE_B,
    assignedAt: now,
    assignedByUuid: null,
    proposalUuid: PROPOSAL_UUID,
    createdByUuid: AGENT_X,
    createdAt: now,
    updatedAt: now,
  });

  return {
    companyUuid: COMPANY,
    projectUuid: PROJECT,
    agentX: AGENT_X,
    agentY: AGENT_Y,
    ownerUuid: OWNER,
    instanceA: INSTANCE_A,
    instanceB: INSTANCE_B,
    instanceY: INSTANCE_Y,
    connA: CONN_A,
    connB: CONN_B,
    connY: CONN_Y,
    ideaUuid: IDEA_UUID,
    proposalUuid: PROPOSAL_UUID,
    taskInherit: TASK_INHERIT,
    taskCross: TASK_CROSS,
    taskOverride: TASK_OVERRIDE,
    hostA: HOST_A,
    cwdA: CWD_A,
    hostB: HOST_B,
    cwdB: CWD_B,
    hostY: HOST_Y,
    cwdY: CWD_Y,
  };
}

/** Take an instance offline by flipping its linked connection's status. */
export function takeInstanceOffline(connectionUuid: string) {
  const conn = agentInstanceStore.daemonConnections.find((c) => c.uuid === connectionUuid);
  if (conn) conn.status = "offline";
}

/** Reverse of takeInstanceOffline: the connection reconnects (status→online, fresh lastSeenAt). */
export function bringInstanceOnline(connectionUuid: string) {
  const conn = agentInstanceStore.daemonConnections.find((c) => c.uuid === connectionUuid);
  if (conn) {
    conn.status = "online";
    conn.lastSeenAt = new Date();
  }
}

/** Build an agent AuthContext for the helper/tracker calls. */
export function agentAuth(actorUuid: string, ownerUuid: string | null = OWNER): AuthContext {
  return {
    type: "agent",
    companyUuid: COMPANY,
    actorUuid,
    ownerUuid: ownerUuid ?? undefined,
  };
}
