// src/services/mention.service.ts
// Mention Service Layer — parse @mentions, create Mention records, trigger notifications
// Content format: @[DisplayName](user:uuid) or @[DisplayName](agent:uuid)

import { prisma } from "@/lib/prisma";
import {
  getActorName,
  resolveAssigneeAgentUuid,
  resolveAssigneeInstanceInfo,
} from "@/lib/uuid-resolver";
// Type-only import (fully erased at compile) of the entity-kind union the
// root-idea resolver accepts. The VALUE `resolveRootIdea` is pulled in lazily
// inside enrichRootIdeaContext (see the note there) to break the module cycle
// mention.service → lineage.service → idea/task.service → mention.service.
import type { LineageEntityType } from "@/services/lineage.service";
import * as notificationService from "@/services/notification.service";
// Pure mention-markup codec, shared with the client editor so producer and
// parser of the on-disk markup cannot drift (cwd-addressable instances, T3).
import { decodePinSuffix } from "@/lib/mention-format";
// Re-exported for callers that build pinned markers (kept here so existing
// imports of these symbols from the service keep resolving).
export {
  encodePinSuffix,
  buildMentionMarker,
} from "@/lib/mention-format";
// Reuse the daemon-connection registry's single liveness threshold and the
// execution service's active-status set — do NOT restate either rule here, so
// producer and consumer cannot drift. listConnectionsForAgent supplies the
// per-instance (host, cwd) candidates with their effectiveStatus already
// derived, so the instance picker shows exactly the registry's liveness verdict.
import {
  STALE_THRESHOLD_MS,
  listConnectionsForAgent,
} from "@/services/daemon-connection.service";
import { ACTIVE_EXECUTION_STATUSES } from "@/services/daemon-execution.service";

// ===== Constants =====

const MAX_MENTIONS_PER_CONTENT = 10;

// Regex to match @[DisplayName](type:uuid) with an OPTIONAL pinned-instance
// suffix (cwd-addressable instances, T3). The base form is byte-identical to
// before this change: `@[Name](agent:uuid)`. A mention that pins a target
// instance carries an additional `?cwd=…&host=…` query-string suffix INSIDE the
// parens — `@[Name](agent:uuid?cwd=…&host=…)` — so an UN-pinned mention is
// unchanged (the suffix group is optional). The suffix is matched as "anything
// up to the closing paren" so the pin codec (see encodePinSuffix) must keep the
// payload paren-free; the codec percent-escapes `(`/`)` to guarantee that.
//
// ADDITIVE / backward-compatible: every existing parser/renderer that matched
// the old shape still matches the base; the new optional group only captures the
// pin when present. Group 4 is the raw pin query string (or undefined).
const MENTION_REGEX = /@\[([^\]]+)\]\((user|agent):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\?([^)]*))?\)/gi;

// ===== Type Definitions =====

export interface MentionRef {
  type: "user" | "agent";
  uuid: string;
  displayName: string;
  // Pinned target daemon instance (cwd-addressable instances, T3). When the
  // owner picked a specific (host, cwd) instance for this mention, these carry
  // the durable "place" so the autonomous wake (T5/T6) routes to it. Both null
  // for an un-pinned mention — which behaves exactly as before this change. The
  // pin is the durable (host, cwd), NOT a connectionUuid (connections churn on
  // daemon restart while the place is stable). `pinnedHost` is "" for an
  // unknown-host instance; `pinnedCwd` is null for an unknown-path instance.
  //
  // SEMANTIC CONTRACT (spec "Mention markup identifies an instance without
  // changing the wire format"): this `(pinnedHost, pinnedCwd)` IS the identity of
  // the `AgentInstance` for this agent at `(host, cwd)` — the SAME tuple
  // `daemon-connection.service.resolveInstanceByTuple(companyUuid, agentUuid,
  // host, cwd)` keys on, and the SAME `("" / null)` sentinels the connection
  // registry matches against. The wire format is NEVER parsed for a
  // connectionUuid; the place IS the durable instance handle. The wake path (T6
  // `notification-turn.resolvePinnedTarget`, `trigger === "mentioned"`) reads the
  // threaded pin off `WakeNotificationContext` and resolves it to the matching
  // AgentInstance's live connection by strict `(host, cwd)` equality — so a
  // pinned mention targets exactly the instance the owner typed, with no change
  // to the stored token and no migration of existing comment tokens.
  pinnedHost?: string | null;
  pinnedCwd?: string | null;
}

/**
 * A live (host, cwd) daemon instance candidate for the instance picker. A
 * structural subset of `ConnectionView` (daemon-connection.service) carrying
 * exactly what the picker needs. Populated for agent `Mentionable`s only, by
 * enrichAgentInstances. The picker auto-selects when there is exactly one.
 */
export interface MentionableInstance {
  /** Current live `DaemonConnection.uuid` for this (host, cwd) place. */
  connectionUuid: string;
  /** Host the instance runs on. "" = unknown/host-less self-report. */
  host: string;
  /** Working directory. null = legacy daemon that never self-reported one. */
  cwd: string | null;
  /** Server-derived liveness verdict (rendered verbatim). */
  effectiveStatus: "online" | "offline";
}

export interface Mentionable {
  type: "user" | "agent";
  uuid: string;
  name: string;
  email?: string | null;
  avatarUrl?: string | null;
  roles?: string[];
  // Agent liveness, populated for `type: "agent"` candidates only (users never
  // carry these). `online` is true iff the agent has at least one effectively-
  // online daemon connection; `activeCount` is the number of running/queued
  // daemon executions for that agent and is coherent with `online` (an offline
  // agent reports 0). See enrichAgentLiveness.
  online?: boolean;
  activeCount?: number;
  // Live (host, cwd) instances for this agent (cwd-addressable instances, T3),
  // populated for `type: "agent"` candidates by enrichAgentInstances. The
  // @mention secondary picker lists these when the agent has 2+ of them; a
  // single instance auto-selects. ADDITIVE: existing consumers that ignore this
  // field are unaffected. Undefined when not enriched (e.g. user candidates, or
  // the empty-query / search paths that don't request instances).
  instances?: MentionableInstance[];
  // Root-idea entity-context enrichment (pin-cwd-before-wake, Part 2a),
  // populated for `type: "agent"` candidates ONLY when searchMentionables was
  // given both `entityType` and `entityUuid` AND the entity resolves to a root
  // idea. `isRootIdeaAssignee` is true iff this candidate agent is the owning
  // agent of the root idea's assignee (an `agent_instance` assignee is resolved
  // to its owning agent first). ADDITIVE: undefined on every candidate when no
  // entity context is supplied, or the entity has no idea ancestor, or for user
  // candidates — so the payload is byte-identical to the pre-change search in
  // those cases. The client (mention-editor) reads it to decide whether to
  // inherit the idea's pin instead of prompting.
  isRootIdeaAssignee?: boolean;
  // The root idea's pinned `(host, cwd)` place + its durable AgentInstance
  // reference, present ONLY on the candidate that IS the root idea's assignee
  // agent AND only when the root idea is instance-pinned (`assigneeType ===
  // "agent_instance"`). The client inherits this pin with NO picker (HARD pin —
  // the resulting wake is notify-only if offline, never re-routed). Absent when
  // the root idea is assigned to a bare agent (not instance-pinned), or for any
  // non-assignee / user candidate. `host` is "" for an unknown-host instance;
  // `cwd` is null for an unknown-path instance (same sentinels as elsewhere).
  rootIdeaPin?: {
    host: string;
    cwd: string | null;
    agentInstanceUuid: string;
  };
}

export interface CreateMentionsParams {
  companyUuid: string;
  sourceType: "comment" | "task" | "idea";
  sourceUuid: string;
  content: string;
  actorType: string;
  actorUuid: string;
  projectUuid: string;
  entityTitle: string;
}

export interface SearchMentionablesParams {
  companyUuid: string;
  query: string;
  actorType: string;
  actorUuid: string;
  ownerUuid?: string;
  limit?: number;
  // When true, enrich agent candidates with their per-instance (host, cwd)
  // candidates (the `instances` field) so the @mention secondary picker can list
  // them (cwd-addressable instances, T3). Off by default — only the @mention
  // flow needs them, and it costs one connection query per returned agent. The
  // sort/slice still runs on liveness only; instances are attached AFTER the
  // slice so we query connections only for the agents actually returned.
  withInstances?: boolean;
  // Optional comment entity context (pin-cwd-before-wake, Part 2a). When BOTH
  // are supplied, the returned agent candidates are annotated with
  // `isRootIdeaAssignee` (and, when the root idea is instance-pinned,
  // `rootIdeaPin`) so the @mention editor can inherit the comment's root idea's
  // pin instead of prompting. `entityType` is the comment's target kind
  // (idea/task/proposal/document); `entityUuid` its uuid. When either is absent
  // (or the entity has no idea ancestor) no annotation is added and the search
  // is identical to before this change.
  entityType?: LineageEntityType;
  entityUuid?: string;
}

// ===== Service Methods =====

/**
 * Parse @[Name](type:uuid) patterns from content string, including any optional
 * pinned-instance suffix `?cwd=…&host=…` (cwd-addressable instances, T3).
 * Returns deduplicated list of mention references (max 10). An UN-pinned mention
 * yields a `MentionRef` with NO `pinnedHost`/`pinnedCwd` keys at all — so it is
 * object-identical to before this change (existing consumers and tests that
 * deep-equal the un-pinned shape are unaffected). A pinned mention adds the
 * two keys. Dedup key is `type:uuid` (the pin does not widen the key: a mention
 * targets the agent; the pin only refines which instance wakes).
 */
export function parseMentions(content: string): MentionRef[] {
  const mentions: MentionRef[] = [];
  const seen = new Set<string>();

  let match;
  // Reset regex state
  MENTION_REGEX.lastIndex = 0;

  while ((match = MENTION_REGEX.exec(content)) !== null) {
    if (mentions.length >= MAX_MENTIONS_PER_CONTENT) break;

    const displayName = match[1];
    const type = match[2].toLowerCase() as "user" | "agent";
    const uuid = match[3].toLowerCase();
    const { pinnedHost, pinnedCwd } = decodePinSuffix(match[4]);
    const key = `${type}:${uuid}`;

    if (!seen.has(key)) {
      seen.add(key);
      const ref: MentionRef = { type, uuid, displayName };
      // Only attach the pin when present, keeping un-pinned refs byte-identical
      // to the legacy shape (additive — existing consumers unaffected).
      if (pinnedHost !== null || pinnedCwd !== null) {
        ref.pinnedHost = pinnedHost;
        ref.pinnedCwd = pinnedCwd;
      }
      mentions.push(ref);
    }
  }

  return mentions;
}

/**
 * Create Mention records and notifications for @mentions found in content.
 * - Parses mentions from content
 * - Deduplicates and enforces max 10 limit
 * - Filters out self-mentions
 * - Validates mentioned targets exist in the same company
 * - Batch creates Mention records
 * - Creates Notification for each valid mention (respecting preferences)
 */
export async function createMentions(params: CreateMentionsParams): Promise<void> {
  const {
    companyUuid,
    sourceType,
    sourceUuid,
    content,
    actorType,
    actorUuid,
    projectUuid,
    entityTitle,
  } = params;

  const mentions = parseMentions(content);
  if (mentions.length === 0) return;

  // Filter out self-mentions
  const filteredMentions = mentions.filter(
    (m) => !(m.type === actorType && m.uuid === actorUuid)
  );
  if (filteredMentions.length === 0) return;

  // Validate that mentioned targets exist in this company
  const validMentions: MentionRef[] = [];

  for (const mention of filteredMentions) {
    const exists = await validateMentionTarget(companyUuid, mention.type, mention.uuid);
    if (exists) {
      validMentions.push(mention);
    }
  }

  if (validMentions.length === 0) return;

  // Batch create Mention records
  await prisma.mention.createMany({
    data: validMentions.map((m) => ({
      companyUuid,
      sourceType,
      sourceUuid,
      mentionedType: m.type,
      mentionedUuid: m.uuid,
      actorType,
      actorUuid,
    })),
  });

  // Get actor name for notification message
  const actorName = (await getActorName(actorType, actorUuid)) ?? "Someone";

  // Get project name for notification
  const project = await prisma.project.findUnique({
    where: { uuid: projectUuid },
    select: { name: true },
  });
  const projectName = project?.name ?? "Unknown Project";

  // Build context snippet from content (truncate to ~100 chars around mention)
  const snippet = buildContextSnippet(content);

  // Resolve the navigable entity for notifications.
  // When a mention comes from a comment, we need to store the comment's parent entity
  // (task/idea/proposal/document) so the notification links to the correct page.
  let notifEntityType: string = sourceType;
  let notifEntityUuid = sourceUuid;

  if (sourceType === "comment") {
    const comment = await prisma.comment.findUnique({
      where: { uuid: sourceUuid },
      select: { targetType: true, targetUuid: true },
    });
    if (comment) {
      notifEntityType = comment.targetType;
      notifEntityUuid = comment.targetUuid;
    }
  }

  // Create notifications for each mentioned user/agent (respecting preferences)
  const notifications: notificationService.NotificationCreateParams[] = [];

  for (const mention of validMentions) {
    // Check notification preference
    const prefs = await notificationService.getPreferences(
      companyUuid,
      mention.type,
      mention.uuid
    );
    if (!prefs.mentioned) continue;

    const message = `${actorName} mentioned you: "${snippet}"`;

    notifications.push({
      companyUuid,
      projectUuid,
      recipientType: mention.type,
      recipientUuid: mention.uuid,
      entityType: notifEntityType,
      entityUuid: notifEntityUuid,
      entityTitle,
      projectName,
      action: "mentioned",
      message,
      actorType,
      actorUuid,
      actorName,
      // Thread the owner-chosen pinned instance (cwd-addressable instances, T5) from
      // the mention markup into the wake-turn chokepoint so the `mentioned` autonomous
      // wake routes to that `(host, cwd)` instance. Only present when the mention was
      // pinned (parseMentions attaches pinnedHost/pinnedCwd only for a pinned ref); an
      // un-pinned mention omits them → online-first selection, exactly as before. The
      // pin is transport-only here — it is NOT persisted on the Notification row.
      pinnedHost: mention.pinnedHost,
      pinnedCwd: mention.pinnedCwd,
    });
  }

  if (notifications.length > 0) {
    await notificationService.createBatch(notifications);
  }
}

const DEFAULT_EMPTY_QUERY_LIMIT = 5;

/**
 * Type rank for online-first ordering (ascending): online agent → offline agent → user.
 * Reads the `online` field that enrichAgentLiveness populates, so this must run AFTER
 * enrichment (a not-yet-enriched agent has `online === undefined`, ranking as offline).
 */
function rankMentionable(m: Mentionable): number {
  if (m.type === "agent") return m.online ? 0 : 1;
  return 2;
}

/**
 * Pure comparator for the @mention candidate list. Sorts (ascending):
 * 1. By type rank: online agent (0) → offline agent (1) → user (2).
 * 2. Among online agents (rank 0): by `activeCount` ascending (idle first), then by
 *    `name.localeCompare` ascending as a deterministic tie-break.
 * 3. Otherwise (same rank: offline agents, or users) returns 0 — relies on
 *    `Array.prototype.sort` stability (Node ≥11 / ES2019) to preserve insertion order.
 *
 * Exported as a pure function for unit testing without a prisma mock. Must be applied
 * after enrichAgentLiveness, since it reads `online` / `activeCount`.
 */
export function compareMentionables(a: Mentionable, b: Mentionable): number {
  const ra = rankMentionable(a);
  const rb = rankMentionable(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) {
    // Both online agents: idle first, then deterministic name tie-break.
    const ca = a.activeCount ?? 0;
    const cb = b.activeCount ?? 0;
    if (ca !== cb) return ca - cb;
    return a.name.localeCompare(b.name);
  }
  return 0; // offline agents / users: keep stable (insertion) order.
}

/**
 * Enrich agent candidates in place with daemon liveness: `online` + `activeCount`.
 *
 * Resolves both in BATCH over the given agent uuids (two queries total, both
 * companyUuid-scoped — never one query per candidate). When there are no agent
 * candidates it issues NO query at all. Users are never passed in / never enriched.
 *
 * - `online`: an agent is online iff it has at least one effectively-online
 *   `DaemonConnection`, applying the daemon-connection registry's exact rule
 *   (`status === "online"` AND `now - lastSeenAt <= STALE_THRESHOLD_MS`). The
 *   constant is imported, not restated, so the rule cannot drift.
 * - `activeCount`: the number of `running`/`queued` `DaemonExecution` rows for the
 *   agent. It is kept COHERENT with `online`: an agent that is not online reports
 *   `0`, so the count never contradicts the dot. (We zero it out for non-online
 *   agents rather than trusting raw rows that may belong to a stale connection.)
 *
 * Mutates the `online`/`activeCount` fields of the agent entries in `results`.
 */
async function enrichAgentLiveness(
  companyUuid: string,
  results: Mentionable[]
): Promise<void> {
  const agentUuids = results
    .filter((r) => r.type === "agent")
    .map((r) => r.uuid);
  // Cheap empty path: no agents → no liveness/count queries at all.
  if (agentUuids.length === 0) return;

  const now = Date.now();

  // 1. Online set — one batched, companyUuid-scoped connection query. An agent is
  //    online iff ANY of its connections is effectively online (registry rule).
  const connections = await prisma.daemonConnection.findMany({
    where: { companyUuid, agentUuid: { in: agentUuids } },
    select: { agentUuid: true, status: true, lastSeenAt: true },
  });
  const onlineAgentUuids = new Set<string>();
  for (const c of connections) {
    const fresh = now - c.lastSeenAt.getTime() <= STALE_THRESHOLD_MS;
    if (c.status === "online" && fresh) {
      onlineAgentUuids.add(c.agentUuid);
    }
  }

  // 2. Active counts — one batched, companyUuid-scoped aggregate over running/
  //    queued executions, grouped by agent.
  const grouped = await prisma.daemonExecution.groupBy({
    by: ["agentUuid"],
    where: {
      companyUuid,
      agentUuid: { in: agentUuids },
      status: { in: [...ACTIVE_EXECUTION_STATUSES] },
    },
    _count: { _all: true },
  });
  const countByAgent = new Map<string, number>();
  for (const g of grouped) {
    countByAgent.set(g.agentUuid, g._count._all);
  }

  // 3. Fold into the agent entries. activeCount is coherent with online: a
  //    non-online agent reports 0 regardless of any stale-connection rows.
  for (const r of results) {
    if (r.type !== "agent") continue;
    const online = onlineAgentUuids.has(r.uuid);
    r.online = online;
    r.activeCount = online ? countByAgent.get(r.uuid) ?? 0 : 0;
  }
}

/**
 * Enrich agent candidates in place with their per-instance (host, cwd)
 * candidates (cwd-addressable instances, T3): the `instances` field the @mention
 * secondary picker lists when an agent has 2+ live instances.
 *
 * Reuses `listConnectionsForAgent` (which already returns one row per
 * `(host, cwd)` connection with `effectiveStatus` derived from the registry's
 * single liveness rule, sorted online-first) — the rule is NOT restated here, so
 * the picker shows exactly the registry's verdict. BATCHED and owner-scoped: it
 * is gated to run only over the candidate agents that already passed the
 * owner-scoping in searchMentionables, and issues NO query when there are zero
 * agent candidates. Calls listConnectionsForAgent once per agent in parallel
 * (each is itself a single companyUuid-scoped query). No new permission bit.
 *
 * We surface ALL connections (online + offline) with each one's
 * `effectiveStatus`; the CONSUMER filters to online before showing the picker
 * (an offline instance is never a wake target, so the secondary picker only ever
 * lists online instances and a fully-offline agent shows no picker). Users are
 * never enriched. Mutates the `instances` field of the agent entries in
 * `results`.
 */
export async function enrichAgentInstances(
  companyUuid: string,
  results: Mentionable[]
): Promise<void> {
  const agents = results.filter((r) => r.type === "agent");
  // Cheap empty path: no agents → no connection queries at all.
  if (agents.length === 0) return;

  // One companyUuid-scoped query per candidate agent, run in parallel. The set
  // of agents is already owner-scoped by the caller (searchMentionables), so
  // this never widens visibility beyond what the owner can already mention.
  const perAgent = await Promise.all(
    agents.map(async (agent) => {
      const connections = await listConnectionsForAgent(companyUuid, agent.uuid);
      const instances: MentionableInstance[] = connections.map((c) => ({
        connectionUuid: c.uuid,
        host: c.host,
        cwd: c.cwd,
        effectiveStatus: c.effectiveStatus,
      }));
      return { uuid: agent.uuid, instances };
    })
  );

  const byAgent = new Map<string, MentionableInstance[]>();
  for (const { uuid, instances } of perAgent) byAgent.set(uuid, instances);
  for (const r of results) {
    if (r.type !== "agent") continue;
    r.instances = byAgent.get(r.uuid) ?? [];
  }
}

/**
 * Annotate agent candidates with the comment's root-idea assignment context
 * (pin-cwd-before-wake, Part 2a), so the @mention editor can inherit the root
 * idea's pin instead of prompting.
 *
 * Given entity context (`entityType` + `entityUuid`), this:
 *   1. Resolves the comment's ROOT idea via the shared `resolveRootIdea` lineage
 *      resolver (company-scoped). No root idea (`rootIdeaUuid === null`, i.e. the
 *      entity has no idea ancestor) → NO annotations, identical to before.
 *   2. Reads the root idea's `assigneeType`/`assigneeUuid` and resolves it to its
 *      OWNING agent uuid (`resolveAssigneeAgentUuid` maps an `agent_instance`
 *      assignee back to its agent). No agent assignee (user/unassigned) → still
 *      sets `isRootIdeaAssignee: false` on every agent candidate (a defined
 *      annotation the client can read), but no candidate matches → no pin.
 *   3. When the root idea is instance-pinned (`assigneeType === "agent_instance"`),
 *      reads the pinned instance's durable `(host, cwd)` place once
 *      (`resolveAssigneeInstanceInfo`).
 *   4. Marks each agent candidate `isRootIdeaAssignee` (candidate uuid === the
 *      root idea's owning agent uuid) and attaches `rootIdeaPin` to the matching
 *      assignee candidate when the idea is instance-pinned.
 *
 * BATCHED / bounded: exactly one root-idea resolve + at most one owning-agent
 * resolve + at most one instance-place lookup, regardless of candidate count —
 * NO per-candidate query. `companyUuid`-scoped throughout (the resolver and both
 * uuid-resolver helpers are company-scoped or key on a company-scoped uuid); no
 * new permission bit and no widening of candidate visibility (the annotation only
 * marks candidates already returned by the owner-scoped search). Users are never
 * annotated. Mutates the `isRootIdeaAssignee`/`rootIdeaPin` fields in `results`.
 *
 * NOTE — deliberate lazy `await import()` of `lineage.service`: importing it at
 * module top level creates the cycle mention.service → lineage.service →
 * idea/task.service → mention.service. A dynamic import defers the load to call
 * time (only when entity context is actually supplied), so the cycle never forms
 * at module-init. The `LineageEntityType` TYPE is imported statically above
 * (type-only imports are erased and carry no runtime edge).
 */
export async function enrichRootIdeaContext(
  companyUuid: string,
  results: Mentionable[],
  entityType: LineageEntityType,
  entityUuid: string,
): Promise<void> {
  // Cheap empty path: no agent candidates → nothing to annotate, no resolve.
  const hasAgent = results.some((r) => r.type === "agent");
  if (!hasAgent) return;

  // Lazy value import — breaks the module cycle (see the note above).
  const { resolveRootIdea } = await import("@/services/lineage.service");
  const { rootIdeaUuid } = await resolveRootIdea(companyUuid, entityType, entityUuid);
  // No idea ancestor → no annotations, identical to the pre-change search.
  if (!rootIdeaUuid) return;

  // The root idea's assignee (company-scoped read). A missing idea (should not
  // happen — resolveRootIdea just returned it) leaves everything un-annotated.
  const rootIdea = await prisma.idea.findFirst({
    where: { uuid: rootIdeaUuid, companyUuid },
    select: { assigneeType: true, assigneeUuid: true },
  });
  if (!rootIdea) return;

  // The root idea's OWNING agent (an `agent_instance` assignee → its agent). The
  // single agent-identity value every candidate is compared against.
  const rootAssigneeAgentUuid = await resolveAssigneeAgentUuid(
    companyUuid,
    rootIdea.assigneeType,
    rootIdea.assigneeUuid,
  );

  // The idea's pinned place — resolved AT MOST ONCE, only when the idea is
  // instance-pinned. `resolveAssigneeInstanceInfo` returns null for a non-instance
  // assignee, so this is a single lookup gated on the instance-pinned case.
  const pinInfo =
    rootIdea.assigneeType === "agent_instance"
      ? await resolveAssigneeInstanceInfo(rootIdea.assigneeType, rootIdea.assigneeUuid)
      : null;

  for (const r of results) {
    if (r.type !== "agent") continue;
    const isAssignee =
      rootAssigneeAgentUuid !== null && r.uuid === rootAssigneeAgentUuid;
    r.isRootIdeaAssignee = isAssignee;
    // The pin rides ONLY on the assignee candidate, and only when instance-pinned.
    // `agentInstanceUuid` is the assignee's own uuid (the AgentInstance.uuid) — a
    // durable handle the client can persist.
    if (isAssignee && pinInfo && rootIdea.assigneeUuid) {
      r.rootIdeaPin = {
        host: pinInfo.host,
        cwd: pinInfo.cwd,
        agentInstanceUuid: rootIdea.assigneeUuid,
      };
    }
  }
}

/**
 * Search for mentionable users and agents within a company.
 * Permission scoping:
 * - User caller: all company users + own agents (agents with ownerUuid = actorUuid)
 * - Agent caller: all company users + same-owner agents (agents with same ownerUuid)
 */
export async function searchMentionables(params: SearchMentionablesParams): Promise<Mentionable[]> {
  const { companyUuid, query, actorType, actorUuid, ownerUuid, limit = 10, withInstances = false, entityType, entityUuid } = params;
  // Entity context is opt-in and requires BOTH parts; either alone is ignored
  // (treated as "no context" → the search is unchanged). Computed once here so
  // both the empty-query and search return paths share the same guard.
  const hasEntityContext = !!entityType && !!entityUuid;

  const effectiveLimit = Math.min(limit, 50);
  const results: Mentionable[] = [];

  // Determine the owner UUID for agent scoping (computed once, reused below)
  let agentOwnerUuid: string | undefined;
  if (actorType === "user") {
    agentOwnerUuid = actorUuid;
  } else if (actorType === "agent" && ownerUuid) {
    agentOwnerUuid = ownerUuid;
  }

  // If query is empty, return only user's own agents (ordered by createdAt DESC)
  // Design decision: We surface recently created agents first for quick access.
  // Human users are not shown in the empty-query case to keep the UX focused on AI agents.
  if (!query) {
    if (agentOwnerUuid) {
      const agents = await prisma.agent.findMany({
        where: {
          companyUuid,
          ownerUuid: agentOwnerUuid,
        },
        select: {
          uuid: true,
          name: true,
          roles: true,
        },
        orderBy: { createdAt: 'desc' },
        // Widen the candidate pool to effectiveLimit (was min(5, effectiveLimit)):
        // an online agent that is NOT among the most recently created few must
        // still be eligible to climb to the top via the online-first sort below.
        take: effectiveLimit,
      });

      for (const agent of agents) {
        results.push({
          type: "agent",
          uuid: agent.uuid,
          name: agent.name,
          roles: agent.roles,
        });
      }
    }

    // enrich → sort (online-first) → slice. Enrich the full agent candidate pool,
    // then order online agents to the front, then trim to the display cap (≤5).
    await enrichAgentLiveness(companyUuid, results);
    results.sort(compareMentionables);
    const sliced = results.slice(0, Math.min(DEFAULT_EMPTY_QUERY_LIMIT, effectiveLimit));
    // Attach per-instance candidates AFTER the slice so we only query connections
    // for the agents actually returned (cwd-addressable instances, T3).
    if (withInstances) await enrichAgentInstances(companyUuid, sliced);
    // Annotate root-idea assignment context AFTER the slice too (pin-cwd-before-wake,
    // Part 2a) — the resolve is bounded (single root-idea resolve, no per-candidate query).
    if (hasEntityContext) await enrichRootIdeaContext(companyUuid, sliced, entityType!, entityUuid!);
    return sliced;
  }
  // Search users (all company users are mentionable)
  const users = await prisma.user.findMany({
    where: {
      companyUuid,
      OR: [
        { name: { contains: query, mode: "insensitive" } },
        { email: { contains: query, mode: "insensitive" } },
      ],
    },
    select: {
      uuid: true,
      name: true,
      email: true,
      avatarUrl: true,
    },
    take: effectiveLimit,
  });

  for (const user of users) {
    results.push({
      type: "user",
      uuid: user.uuid,
      name: user.name ?? user.email ?? "Unknown",
      email: user.email,
      avatarUrl: user.avatarUrl,
    });
  }

  // Search agents with permission scoping

  const agentWhere: {
    companyUuid: string;
    name: { contains: string; mode: "insensitive" };
    ownerUuid?: string;
  } = {
    companyUuid,
    name: { contains: query, mode: "insensitive" as const },
  };

  // Scope agents: user sees own agents, agent sees same-owner agents
  if (agentOwnerUuid) {
    agentWhere.ownerUuid = agentOwnerUuid;
  }

  const agents = await prisma.agent.findMany({
    where: agentWhere,
    select: {
      uuid: true,
      name: true,
      roles: true,
    },
    // Take the full effectiveLimit (NOT effectiveLimit - results.length): the agent
    // candidate pool must be large enough that online agents survive the slice even
    // when many matching users were inserted first. Online-first sort happens below.
    take: effectiveLimit,
  });

  for (const agent of agents) {
    results.push({
      type: "agent",
      uuid: agent.uuid,
      name: agent.name,
      roles: agent.roles,
    });
  }

  // enrich → sort → slice. Enrich the FULL candidate pool (so liveness is known for
  // every agent), order online agents to the front, THEN trim to the display limit —
  // this is what keeps online agents from being sliced out by a flood of users.
  await enrichAgentLiveness(companyUuid, results);
  results.sort(compareMentionables);
  const sliced = results.slice(0, effectiveLimit);
  // Attach per-instance candidates AFTER the slice so we only query connections
  // for the agents actually returned (cwd-addressable instances, T3).
  if (withInstances) await enrichAgentInstances(companyUuid, sliced);
  // Annotate root-idea assignment context AFTER the slice too (pin-cwd-before-wake,
  // Part 2a) — the resolve is bounded (single root-idea resolve, no per-candidate query).
  if (hasEntityContext) await enrichRootIdeaContext(companyUuid, sliced, entityType!, entityUuid!);
  return sliced;
}

/**
 * Get all mentions for a given source entity.
 */
export async function getMentionsBySource(
  companyUuid: string,
  sourceType: string,
  sourceUuid: string
): Promise<Array<{ uuid: string; mentionedType: string; mentionedUuid: string; actorType: string; actorUuid: string; createdAt: string }>> {
  const mentions = await prisma.mention.findMany({
    where: {
      companyUuid,
      sourceType,
      sourceUuid,
    },
    select: {
      uuid: true,
      mentionedType: true,
      mentionedUuid: true,
      actorType: true,
      actorUuid: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });

  return mentions.map((m) => ({
    uuid: m.uuid,
    mentionedType: m.mentionedType,
    mentionedUuid: m.mentionedUuid,
    actorType: m.actorType,
    actorUuid: m.actorUuid,
    createdAt: m.createdAt.toISOString(),
  }));
}

// ===== Internal Helpers =====

/**
 * Validate that a mention target (user or agent) exists in the given company.
 */
async function validateMentionTarget(
  companyUuid: string,
  type: "user" | "agent",
  uuid: string
): Promise<boolean> {
  if (type === "user") {
    const user = await prisma.user.findFirst({
      where: { uuid, companyUuid },
      select: { uuid: true },
    });
    return !!user;
  } else {
    const agent = await prisma.agent.findFirst({
      where: { uuid, companyUuid },
      select: { uuid: true },
    });
    return !!agent;
  }
}

/**
 * Build a context snippet from content, stripping mention syntax for readability.
 * Truncates to ~120 chars.
 */
function buildContextSnippet(content: string): string {
  // Replace @[Name](type:uuid) with just @Name for readability
  const cleaned = content.replace(MENTION_REGEX, "@$1");
  if (cleaned.length <= 120) return cleaned;
  return cleaned.substring(0, 117) + "...";
}
