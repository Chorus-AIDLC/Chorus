// src/services/observability.service.ts
// Observability Service Layer — aggregation over ToolUsageEvent + TokenUsageRecord
// UUID-Based Architecture: All operations use UUIDs and are scoped by companyUuid.

import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";

// ===== Type Definitions =====

export type EntityType = "task" | "idea" | "proposal" | "document";
export type LifecyclePhase = "elaboration" | "proposal" | "review" | "execution" | "verify";

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface ToolBreakdownItem {
  toolName: string;
  callCount: number;
  errorCount: number;
  totalInputSize: number;
  totalOutputSize: number;
  totalDurationMs: number;
}

export interface EntityTokensResult {
  entityType: EntityType;
  entityUuid: string;
  toolCallCount: number;
  toolErrorCount: number;
  totalInputSize: number;
  totalOutputSize: number;
  totalDurationMs: number;
  toolBreakdown: ToolBreakdownItem[];
  sessionTokens: TokenUsage;
  sessionCount: number;
}

export interface LifecyclePhaseResult {
  phase: LifecyclePhase;
  toolCallCount: number;
  toolErrorCount: number;
  totalInputSize: number;
  totalOutputSize: number;
  sessionTokens: TokenUsage;
  toolBreakdown: ToolBreakdownItem[];
}

export interface IdeaLifecycleResult {
  ideaUuid: string;
  totals: {
    toolCallCount: number;
    sessionTokens: TokenUsage;
  };
  phases: LifecyclePhaseResult[];
  tasks: Array<{
    taskUuid: string;
    title: string;
    status: string;
    toolCallCount: number;
    totalInputSize: number;
    totalOutputSize: number;
    sessionTokens: TokenUsage;
  }>;
}

export interface ProposalTokensResult {
  proposalUuid: string;
  drafting: {
    toolCallCount: number;
    totalInputSize: number;
    totalOutputSize: number;
    sessionTokens: TokenUsage;
    toolBreakdown: ToolBreakdownItem[];
  };
  review: {
    toolCallCount: number;
    totalInputSize: number;
    totalOutputSize: number;
  };
}

export interface AgentObservabilityItem {
  agentUuid: string;
  agentName: string;
  toolCallCount: number;
  toolErrorCount: number;
  totalInputSize: number;
  totalOutputSize: number;
  sessionTokens: TokenUsage;
  sessionCount: number;
  dailySeries: Array<{ date: string; toolCallCount: number }>;
  topTools: ToolBreakdownItem[];
}

export interface AgentObservabilityResult {
  projectUuid: string;
  dateRange: { days: number; from: string; to: string };
  agents: AgentObservabilityItem[];
}

export interface ClientToolEventInput {
  tool: string;
  id?: string;
  agent?: string;
  ts?: string;
  input_len?: number;
  output_len?: number;
  entity_type?: string | null;
  entity_uuid?: string | null;
  project_uuid?: string | null;
  is_error?: boolean;
  error_text?: string | null;
}

// ===== Helpers =====

function emptyTokenUsage(): TokenUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}

function addTokenUsage(target: TokenUsage, raw: unknown): void {
  if (!raw || typeof raw !== "object") return;
  const v = raw as Record<string, unknown>;
  const add = (k: keyof TokenUsage) => {
    const n = v[k];
    if (typeof n === "number" && Number.isFinite(n)) target[k] += n;
  };
  add("input_tokens");
  add("output_tokens");
  add("cache_creation_input_tokens");
  add("cache_read_input_tokens");
}

type RawToolEvent = {
  toolName: string;
  isError: boolean;
  durationMs: number;
  inputSize: number;
  outputSize: number;
};

function aggregateTools(events: RawToolEvent[]): {
  callCount: number;
  errorCount: number;
  totalInputSize: number;
  totalOutputSize: number;
  totalDurationMs: number;
  breakdown: ToolBreakdownItem[];
} {
  const byTool = new Map<string, ToolBreakdownItem>();
  let callCount = 0;
  let errorCount = 0;
  let totalInputSize = 0;
  let totalOutputSize = 0;
  let totalDurationMs = 0;

  for (const ev of events) {
    callCount += 1;
    if (ev.isError) errorCount += 1;
    totalInputSize += ev.inputSize;
    totalOutputSize += ev.outputSize;
    totalDurationMs += ev.durationMs;

    const item = byTool.get(ev.toolName) ?? {
      toolName: ev.toolName,
      callCount: 0,
      errorCount: 0,
      totalInputSize: 0,
      totalOutputSize: 0,
      totalDurationMs: 0,
    };
    item.callCount += 1;
    if (ev.isError) item.errorCount += 1;
    item.totalInputSize += ev.inputSize;
    item.totalOutputSize += ev.outputSize;
    item.totalDurationMs += ev.durationMs;
    byTool.set(ev.toolName, item);
  }

  const breakdown = Array.from(byTool.values()).sort(
    (a, b) => b.callCount - a.callCount
  );

  return {
    callCount,
    errorCount,
    totalInputSize,
    totalOutputSize,
    totalDurationMs,
    breakdown,
  };
}

// Classify MCP tool name into a lifecycle phase for an Idea.
// Returns null when the tool is not phase-discriminating on its own.
// Order matters: review/verify checks must come before the generic "proposal"
// substring fallback, because e.g. "chorus_admin_approve_proposal" also contains
// the word "proposal" but belongs to the review phase.
export function classifyPhase(toolName: string): LifecyclePhase | null {
  if (toolName.includes("elaboration")) return "elaboration";
  if (
    toolName === "chorus_admin_approve_proposal" ||
    toolName === "chorus_admin_reject_proposal" ||
    toolName === "chorus_admin_close_proposal"
  ) {
    return "review";
  }
  if (
    toolName === "chorus_admin_verify_task" ||
    toolName === "chorus_admin_reopen_task" ||
    toolName === "chorus_submit_for_verify" ||
    toolName === "chorus_report_criteria_self_check"
  ) {
    return "verify";
  }
  if (
    toolName.includes("proposal") ||
    toolName === "chorus_pm_add_document_draft" ||
    toolName === "chorus_pm_update_document_draft" ||
    toolName === "chorus_pm_remove_document_draft" ||
    toolName === "chorus_pm_add_task_draft" ||
    toolName === "chorus_pm_update_task_draft" ||
    toolName === "chorus_pm_remove_task_draft"
  ) {
    return "proposal";
  }
  return null;
}

// ===== Service Methods =====

// Aggregate tool events + session tokens for a single entity.
export async function getEntityTokens(
  companyUuid: string,
  entityType: EntityType,
  entityUuid: string
): Promise<EntityTokensResult> {
  const events = await prisma.toolUsageEvent.findMany({
    where: { companyUuid, entityType, entityUuid },
    select: {
      toolName: true,
      isError: true,
      durationMs: true,
      inputSize: true,
      outputSize: true,
      sessionUuid: true,
    },
  });

  const agg = aggregateTools(events);

  // Token usage from TokenUsageRecord (T3 will optimize this query)
  const sessionTokens = emptyTokenUsage();
  let sessionCount = 0;
  const tokenRecords = await prisma.tokenUsageRecord.findMany({
    where: { companyUuid, entityType, entityUuid },
    select: {
      inputTokens: true,
      outputTokens: true,
      cacheCreationInputTokens: true,
      cacheReadInputTokens: true,
      sessionUuid: true,
    },
  });
  const sessionSet = new Set<string>();
  for (const r of tokenRecords) {
    sessionTokens.input_tokens += r.inputTokens;
    sessionTokens.output_tokens += r.outputTokens;
    sessionTokens.cache_creation_input_tokens += r.cacheCreationInputTokens;
    sessionTokens.cache_read_input_tokens += r.cacheReadInputTokens;
    if (r.sessionUuid) sessionSet.add(r.sessionUuid);
  }
  sessionCount = sessionSet.size;

  return {
    entityType,
    entityUuid,
    toolCallCount: agg.callCount,
    toolErrorCount: agg.errorCount,
    totalInputSize: agg.totalInputSize,
    totalOutputSize: agg.totalOutputSize,
    totalDurationMs: agg.totalDurationMs,
    toolBreakdown: agg.breakdown,
    sessionTokens,
    sessionCount,
  };
}

// Aggregate lifecycle phases for an Idea. Uses ToolUsageEvent for the
// Idea itself (phases: elaboration/proposal/review) plus the tasks that the
// Idea spawned (phases: execution/verify).
export async function getIdeaLifecycleTokens(
  companyUuid: string,
  ideaUuid: string
): Promise<IdeaLifecycleResult> {
  // 1. Find linked proposals (inputType=idea, inputUuids contains ideaUuid) and tasks.
  const proposals = await prisma.proposal.findMany({
    where: { companyUuid, inputType: "idea" },
    select: { uuid: true, inputUuids: true },
  });
  const linkedProposalUuids = proposals
    .filter((p) => {
      const arr = Array.isArray(p.inputUuids) ? (p.inputUuids as unknown[]) : [];
      return arr.includes(ideaUuid);
    })
    .map((p) => p.uuid);

  const tasks = linkedProposalUuids.length
    ? await prisma.task.findMany({
        where: { companyUuid, proposalUuid: { in: linkedProposalUuids } },
        select: { uuid: true, title: true, status: true },
      })
    : [];
  const taskUuids = tasks.map((t) => t.uuid);

  // 2. Collect events across idea + proposals + tasks.
  const orClauses: Prisma.ToolUsageEventWhereInput[] = [
    { entityType: "idea", entityUuid: ideaUuid },
  ];
  if (linkedProposalUuids.length) {
    orClauses.push({
      entityType: "proposal",
      entityUuid: { in: linkedProposalUuids },
    });
  }
  if (taskUuids.length) {
    orClauses.push({ entityType: "task", entityUuid: { in: taskUuids } });
  }

  const events = await prisma.toolUsageEvent.findMany({
    where: { companyUuid, OR: orClauses },
    select: {
      toolName: true,
      isError: true,
      durationMs: true,
      inputSize: true,
      outputSize: true,
      sessionUuid: true,
      entityType: true,
      entityUuid: true,
    },
  });

  // 3. Bucket events into lifecycle phases.
  const phaseBuckets: Record<LifecyclePhase, RawToolEvent[]> = {
    elaboration: [],
    proposal: [],
    review: [],
    execution: [],
    verify: [],
  };
  const taskEventsByUuid = new Map<string, RawToolEvent[]>();

  for (const ev of events) {
    const raw: RawToolEvent = {
      toolName: ev.toolName,
      isError: ev.isError,
      durationMs: ev.durationMs,
      inputSize: ev.inputSize,
      outputSize: ev.outputSize,
    };

    let phase: LifecyclePhase | null = classifyPhase(ev.toolName);
    // Fallback by entity context when tool name is not discriminating.
    if (!phase) {
      if (ev.entityType === "idea") phase = "elaboration";
      else if (ev.entityType === "proposal") phase = "proposal";
      else if (ev.entityType === "task") phase = "execution";
    }
    if (phase) {
      phaseBuckets[phase].push(raw);
    }

    if (ev.entityType === "task" && ev.entityUuid) {
      const list = taskEventsByUuid.get(ev.entityUuid) ?? [];
      list.push(raw);
      taskEventsByUuid.set(ev.entityUuid, list);
    }
  }

  // 4. Fetch token usage from TokenUsageRecord, indexed by entityType:entityUuid.
  const allEntityUuids = [ideaUuid, ...linkedProposalUuids, ...taskUuids];
  const tokenRecords = allEntityUuids.length
    ? await prisma.tokenUsageRecord.findMany({
        where: { companyUuid, entityUuid: { in: allEntityUuids } },
        select: {
          entityType: true,
          entityUuid: true,
          sessionUuid: true,
          isReviewer: true,
          inputTokens: true,
          outputTokens: true,
          cacheCreationInputTokens: true,
          cacheReadInputTokens: true,
        },
      })
    : [];

  // Also fetch project-level records for input tokens
  const projectTokenRecords = await prisma.tokenUsageRecord.findMany({
    where: {
      companyUuid,
      entityType: "project",
      entityUuid: { in: allEntityUuids.length ? allEntityUuids : ["__none__"] },
    },
    select: {
      inputTokens: true,
      outputTokens: true,
      cacheCreationInputTokens: true,
      cacheReadInputTokens: true,
    },
  });

  const tokenByEntity = new Map<string, TokenUsage>();
  for (const r of tokenRecords) {
    const key = `${r.entityType}:${r.entityUuid}`;
    const existing = tokenByEntity.get(key) ?? emptyTokenUsage();
    existing.input_tokens += r.inputTokens;
    existing.output_tokens += r.outputTokens;
    existing.cache_creation_input_tokens += r.cacheCreationInputTokens;
    existing.cache_read_input_tokens += r.cacheReadInputTokens;
    tokenByEntity.set(key, existing);
  }

  // 5. Build phase results using entityType + isReviewer.
  // | entityType | sessionUuid | isReviewer | → phase      |
  // |------------|-------------|------------|--------------|
  // | idea       | *           | *          | elaboration  |
  // | proposal   | null        | *          | proposal     |
  // | proposal   | set         | *          | review       |
  // | task       | null        | *          | verify       |
  // | task       | set         | true       | verify       |
  // | task       | set         | false      | execution    |
  const phaseTokenBuckets: Record<LifecyclePhase, TokenUsage> = {
    elaboration: emptyTokenUsage(),
    proposal: emptyTokenUsage(),
    review: emptyTokenUsage(),
    execution: emptyTokenUsage(),
    verify: emptyTokenUsage(),
  };
  for (const r of tokenRecords) {
    const usage: TokenUsage = {
      input_tokens: r.inputTokens,
      output_tokens: r.outputTokens,
      cache_creation_input_tokens: r.cacheCreationInputTokens,
      cache_read_input_tokens: r.cacheReadInputTokens,
    };
    if (r.entityType === "idea") {
      addTokenUsage(phaseTokenBuckets.elaboration, usage);
    } else if (r.entityType === "proposal") {
      if (r.sessionUuid) {
        addTokenUsage(phaseTokenBuckets.review, usage);
      } else {
        addTokenUsage(phaseTokenBuckets.proposal, usage);
      }
    } else if (r.entityType === "task") {
      if (r.isReviewer) {
        addTokenUsage(phaseTokenBuckets.verify, usage);
      } else {
        addTokenUsage(phaseTokenBuckets.execution, usage);
      }
    }
  }

  const phases: LifecyclePhaseResult[] = (
    ["elaboration", "proposal", "review", "execution", "verify"] as LifecyclePhase[]
  ).map((phase) => {
    const agg = aggregateTools(phaseBuckets[phase]);
    return {
      phase,
      toolCallCount: agg.callCount,
      toolErrorCount: agg.errorCount,
      totalInputSize: agg.totalInputSize,
      totalOutputSize: agg.totalOutputSize,
      sessionTokens: phaseTokenBuckets[phase],
      toolBreakdown: agg.breakdown,
    };
  });

  // 6. Per-task rollup.
  const perTask = tasks.map((t) => {
    const evs = taskEventsByUuid.get(t.uuid) ?? [];
    const agg = aggregateTools(evs);
    const tokens = tokenByEntity.get(`task:${t.uuid}`) ?? emptyTokenUsage();
    return {
      taskUuid: t.uuid,
      title: t.title,
      status: t.status,
      toolCallCount: agg.callCount,
      totalInputSize: agg.totalInputSize,
      totalOutputSize: agg.totalOutputSize,
      sessionTokens: { ...tokens },
    };
  });

  // 7. Totals: sum all token records for this idea's entities + project-level input.
  const totalTokens = emptyTokenUsage();
  for (const t of tokenByEntity.values()) {
    addTokenUsage(totalTokens, t);
  }
  for (const r of projectTokenRecords) {
    totalTokens.input_tokens += r.inputTokens;
    totalTokens.output_tokens += r.outputTokens;
    totalTokens.cache_creation_input_tokens += r.cacheCreationInputTokens;
    totalTokens.cache_read_input_tokens += r.cacheReadInputTokens;
  }
  const totalToolCalls = phases.reduce((acc, p) => acc + p.toolCallCount, 0);

  return {
    ideaUuid,
    totals: {
      toolCallCount: totalToolCalls,
      sessionTokens: totalTokens,
    },
    phases,
    tasks: perTask,
  };
}

// Proposal-specific breakdown: drafting (events on proposal entity) + review rounds.
export async function getProposalTokens(
  companyUuid: string,
  proposalUuid: string
): Promise<ProposalTokensResult> {
  const events = await prisma.toolUsageEvent.findMany({
    where: { companyUuid, entityType: "proposal", entityUuid: proposalUuid },
    select: {
      toolName: true,
      isError: true,
      durationMs: true,
      inputSize: true,
      outputSize: true,
      sessionUuid: true,
    },
  });

  const draftingEvents: RawToolEvent[] = [];
  const reviewEvents: RawToolEvent[] = [];

  for (const ev of events) {
    const phase = classifyPhase(ev.toolName);
    const raw: RawToolEvent = {
      toolName: ev.toolName,
      isError: ev.isError,
      durationMs: ev.durationMs,
      inputSize: ev.inputSize,
      outputSize: ev.outputSize,
    };
    if (phase === "review") {
      reviewEvents.push(raw);
    } else {
      draftingEvents.push(raw);
    }
  }

  const draftingAgg = aggregateTools(draftingEvents);
  const reviewAgg = aggregateTools(reviewEvents);

  const draftingTokens = emptyTokenUsage();
  const proposalTokenRecords = await prisma.tokenUsageRecord.findMany({
    where: { companyUuid, entityType: "proposal", entityUuid: proposalUuid },
    select: {
      inputTokens: true,
      outputTokens: true,
      cacheCreationInputTokens: true,
      cacheReadInputTokens: true,
    },
  });
  for (const r of proposalTokenRecords) {
    draftingTokens.input_tokens += r.inputTokens;
    draftingTokens.output_tokens += r.outputTokens;
    draftingTokens.cache_creation_input_tokens += r.cacheCreationInputTokens;
    draftingTokens.cache_read_input_tokens += r.cacheReadInputTokens;
  }

  return {
    proposalUuid,
    drafting: {
      toolCallCount: draftingAgg.callCount,
      totalInputSize: draftingAgg.totalInputSize,
      totalOutputSize: draftingAgg.totalOutputSize,
      sessionTokens: draftingTokens,
      toolBreakdown: draftingAgg.breakdown,
    },
    review: {
      toolCallCount: reviewAgg.callCount,
      totalInputSize: reviewAgg.totalInputSize,
      totalOutputSize: reviewAgg.totalOutputSize,
    },
  };
}

// Agent observability dashboard for a project over the given date range.
export async function getAgentObservability(
  companyUuid: string,
  projectUuid: string,
  days: number
): Promise<AgentObservabilityResult> {
  const now = new Date();
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  const events = await prisma.toolUsageEvent.findMany({
    where: {
      companyUuid,
      projectUuid,
      createdAt: { gte: from },
    },
    select: {
      agentUuid: true,
      toolName: true,
      isError: true,
      durationMs: true,
      inputSize: true,
      outputSize: true,
      sessionUuid: true,
      createdAt: true,
    },
  });

  type AgentBucket = {
    events: RawToolEvent[];
    sessions: Set<string>;
    dailyCounts: Map<string, number>;
  };
  const byAgent = new Map<string, AgentBucket>();
  for (const ev of events) {
    const bucket = byAgent.get(ev.agentUuid) ?? {
      events: [],
      sessions: new Set<string>(),
      dailyCounts: new Map<string, number>(),
    };
    bucket.events.push({
      toolName: ev.toolName,
      isError: ev.isError,
      durationMs: ev.durationMs,
      inputSize: ev.inputSize,
      outputSize: ev.outputSize,
    });
    if (ev.sessionUuid) bucket.sessions.add(ev.sessionUuid);
    const dayKey = ev.createdAt.toISOString().slice(0, 10);
    bucket.dailyCounts.set(dayKey, (bucket.dailyCounts.get(dayKey) ?? 0) + 1);
    byAgent.set(ev.agentUuid, bucket);
  }

  const agentUuids = Array.from(byAgent.keys());
  const [agents, tokenRecords] = await Promise.all([
    agentUuids.length
      ? prisma.agent.findMany({
          where: { companyUuid, uuid: { in: agentUuids } },
          select: { uuid: true, name: true },
        })
      : Promise.resolve([] as Array<{ uuid: string; name: string }>),
    agentUuids.length
      ? prisma.tokenUsageRecord.findMany({
          where: { companyUuid, projectUuid, agentUuid: { in: agentUuids } },
          select: {
            agentUuid: true,
            inputTokens: true,
            outputTokens: true,
            cacheCreationInputTokens: true,
            cacheReadInputTokens: true,
            sessionUuid: true,
          },
        })
      : Promise.resolve(
          [] as Array<{
            agentUuid: string;
            inputTokens: number;
            outputTokens: number;
            cacheCreationInputTokens: number;
            cacheReadInputTokens: number;
            sessionUuid: string | null;
          }>
        ),
  ]);

  const agentNameByUuid = new Map(agents.map((a) => [a.uuid, a.name]));
  const tokensByAgent = new Map<string, { tokens: TokenUsage; sessions: Set<string> }>();
  for (const r of tokenRecords) {
    const entry = tokensByAgent.get(r.agentUuid) ?? {
      tokens: emptyTokenUsage(),
      sessions: new Set<string>(),
    };
    entry.tokens.input_tokens += r.inputTokens;
    entry.tokens.output_tokens += r.outputTokens;
    entry.tokens.cache_creation_input_tokens += r.cacheCreationInputTokens;
    entry.tokens.cache_read_input_tokens += r.cacheReadInputTokens;
    if (r.sessionUuid) entry.sessions.add(r.sessionUuid);
    tokensByAgent.set(r.agentUuid, entry);
  }

  const items: AgentObservabilityItem[] = [];
  for (const [agentUuid, bucket] of byAgent.entries()) {
    const agg = aggregateTools(bucket.events);
    const agentTokenEntry = tokensByAgent.get(agentUuid);
    const tokens = agentTokenEntry?.tokens ?? emptyTokenUsage();
    const dailySeries = Array.from(bucket.dailyCounts.entries())
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([date, toolCallCount]) => ({ date, toolCallCount }));
    items.push({
      agentUuid,
      agentName: agentNameByUuid.get(agentUuid) ?? "Unknown Agent",
      toolCallCount: agg.callCount,
      toolErrorCount: agg.errorCount,
      totalInputSize: agg.totalInputSize,
      totalOutputSize: agg.totalOutputSize,
      sessionTokens: { ...tokens },
      sessionCount: agentTokenEntry?.sessions.size ?? bucket.sessions.size,
      dailySeries,
      topTools: agg.breakdown.slice(0, 10),
    });
  }

  items.sort((a, b) => b.toolCallCount - a.toolCallCount);

  return {
    projectUuid,
    dateRange: {
      days,
      from: from.toISOString(),
      to: now.toISOString(),
    },
    agents: items,
  };
}

// Bulk insert client-reported (Layer 2) tool events.
// Caller must have already authorized the agent and verified sessionUuid ownership.
export async function batchInsertClientToolEvents(
  companyUuid: string,
  agentUuid: string,
  sessionUuid: string | null,
  events: ClientToolEventInput[]
): Promise<{ inserted: number }> {
  if (events.length === 0) return { inserted: 0 };

  const rows = events.map((e) => ({
    companyUuid,
    agentUuid,
    sessionUuid,
    toolName: e.tool,
    source: "client",
    durationMs: 0,
    inputSize: Number.isFinite(e.input_len) ? Number(e.input_len ?? 0) : 0,
    outputSize: Number.isFinite(e.output_len) ? Number(e.output_len ?? 0) : 0,
    isError: Boolean(e.is_error),
    errorText: e.error_text ?? null,
    entityType: e.entity_type ?? null,
    entityUuid: e.entity_uuid ?? null,
    projectUuid: e.project_uuid ?? null,
    createdAt: e.ts ? new Date(e.ts) : new Date(),
  }));

  const result = await prisma.toolUsageEvent.createMany({ data: rows });
  return { inserted: result.count };
}

// ===== Token Attribution Engine =====

export interface TurnUsage {
  ts: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface TimelineEntry {
  ts: string;
  entity_type: string;
  entity_uuid: string;
}

interface AttributedRecord {
  companyUuid: string;
  agentUuid: string;
  sessionUuid: string | null;
  projectUuid: string | null;
  entityType: string | null;
  entityUuid: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  isReviewer: boolean;
  sourceSessionId: string | null;
  turnTimestamp: Date | null;
}

// Per-turn attribution: each turn becomes one record with entity attribution.
// Uses carry-forward: the last timeline entry before a turn's timestamp determines
// the active entity.
export function attributeTokenUsage(
  turns: TurnUsage[],
  timeline: TimelineEntry[],
  sessionUuid: string | null,
  agentUuid: string,
  companyUuid: string,
  sourceSessionId: string | null = null,
  isReviewer: boolean = false
): AttributedRecord[] {
  if (turns.length === 0) return [];

  const sortedTimeline = [...timeline].sort(
    (a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime()
  );

  // Sub-agents are spawned for a single primary entity (a task, proposal, etc.).
  // They may call chorus tools on other entities for context (e.g. reviewer reads
  // the idea before reviewing the proposal), but ALL their tokens should be
  // attributed to the primary entity. Pick the highest-priority entity from the
  // timeline: task > proposal > idea > document.
  const primaryEntity = sessionUuid
    ? findPrimaryEntity(sortedTimeline)
    : null;

  const records: AttributedRecord[] = [];

  for (const turn of turns) {
    const turnTs = turn.ts ? new Date(turn.ts) : null;
    // Sub-agent: all turns → primary entity. Main agent: carry-forward per turn.
    const entity = sessionUuid
      ? primaryEntity
      : turn.ts
        ? findActiveEntity(turn.ts, sortedTimeline)
        : null;

    records.push({
      companyUuid,
      agentUuid,
      sessionUuid,
      projectUuid: null,
      entityType: entity?.entity_type ?? null,
      entityUuid: entity?.entity_uuid ?? null,
      inputTokens: turn.input_tokens ?? 0,
      outputTokens: turn.output_tokens ?? 0,
      cacheCreationInputTokens: turn.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: turn.cache_read_input_tokens ?? 0,
      isReviewer,
      sourceSessionId,
      turnTimestamp: turnTs,
    });
  }

  return records;
}

// Resolve projectUuid for each entity in attributed records.
// Batch-queries all unique entity UUIDs, returns a map of entityUuid -> projectUuid.
// Records without entity get null projectUuid.
export async function resolveProjectUuids(
  companyUuid: string,
  records: AttributedRecord[]
): Promise<Map<string, string>> {
  const result = new Map<string, string>();

  const taskUuids = new Set<string>();
  const ideaUuids = new Set<string>();
  const proposalUuids = new Set<string>();

  for (const r of records) {
    if (!r.entityType || !r.entityUuid) continue;
    if (r.entityType === "task") taskUuids.add(r.entityUuid);
    else if (r.entityType === "idea") ideaUuids.add(r.entityUuid);
    else if (r.entityType === "proposal") proposalUuids.add(r.entityUuid);
  }

  const [tasks, ideas, proposals] = await Promise.all([
    taskUuids.size
      ? prisma.task.findMany({
          where: { companyUuid, uuid: { in: [...taskUuids] } },
          select: { uuid: true, proposalUuid: true },
        })
      : Promise.resolve([]),
    ideaUuids.size
      ? prisma.idea.findMany({
          where: { companyUuid, uuid: { in: [...ideaUuids] } },
          select: { uuid: true, projectUuid: true },
        })
      : Promise.resolve([]),
    proposalUuids.size
      ? prisma.proposal.findMany({
          where: { companyUuid, uuid: { in: [...proposalUuids] } },
          select: { uuid: true, projectUuid: true },
        })
      : Promise.resolve([]),
  ]);

  for (const idea of ideas) {
    if (idea.projectUuid) result.set(idea.uuid, idea.projectUuid);
  }
  for (const proposal of proposals) {
    if (proposal.projectUuid) result.set(proposal.uuid, proposal.projectUuid);
  }

  // Tasks need proposal lookup for projectUuid
  const taskProposalUuids = new Set<string>();
  for (const task of tasks) {
    if (task.proposalUuid) taskProposalUuids.add(task.proposalUuid);
  }
  const taskProposals = taskProposalUuids.size
    ? await prisma.proposal.findMany({
        where: { uuid: { in: [...taskProposalUuids] } },
        select: { uuid: true, projectUuid: true },
      })
    : [];
  const proposalProjectMap = new Map(
    taskProposals.filter((p) => p.projectUuid).map((p) => [p.uuid, p.projectUuid!])
  );
  for (const task of tasks) {
    if (task.proposalUuid) {
      const projUuid = proposalProjectMap.get(task.proposalUuid);
      if (projUuid) result.set(task.uuid, projUuid);
    }
  }

  return result;
}

function findActiveEntity(
  turnTs: string,
  sortedTimeline: TimelineEntry[]
): TimelineEntry | null {
  const turnTime = new Date(turnTs).getTime();
  let best: TimelineEntry | null = null;
  for (const entry of sortedTimeline) {
    if (new Date(entry.ts).getTime() <= turnTime) {
      best = entry;
    } else {
      break;
    }
  }
  return best;
}

const ENTITY_PRIORITY: Record<string, number> = {
  task: 4,
  proposal: 3,
  idea: 2,
  document: 1,
};

// Sub-agents work on one primary entity. Pick the highest-priority entity type
// seen anywhere in the timeline. A reviewer may read an idea for context but its
// real work target is the proposal.
export function findPrimaryEntity(
  timeline: TimelineEntry[]
): TimelineEntry | null {
  let best: TimelineEntry | null = null;
  let bestPri = 0;
  for (const entry of timeline) {
    const pri = ENTITY_PRIORITY[entry.entity_type] ?? 0;
    if (pri > bestPri) {
      bestPri = pri;
      best = entry;
    }
  }
  return best;
}

// Upsert: when sourceSessionId is set, delete old records first (each session = 1 snapshot).
// When sourceSessionId is null, just insert (no dedup possible).
export async function insertAttributedTokenUsage(
  records: AttributedRecord[]
): Promise<{ inserted: number }> {
  if (records.length === 0) return { inserted: 0 };

  const sourceIds = new Set(
    records.map((r) => r.sourceSessionId).filter((s): s is string => s !== null)
  );
  if (sourceIds.size > 0) {
    await prisma.tokenUsageRecord.deleteMany({
      where: { sourceSessionId: { in: [...sourceIds] } },
    });
  }

  const result = await prisma.tokenUsageRecord.createMany({ data: records });
  return { inserted: result.count };
}
