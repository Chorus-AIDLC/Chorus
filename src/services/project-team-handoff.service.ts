import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { AuthContext } from "@/types/auth";
import { AGENT_TEAM_ROLES } from "@/lib/agent-team-roles";
import { eventBus } from "@/lib/event-bus";
import { createActivityInTx } from "@/services/activity.service";
import { computeDerivedStatus, rollupThemeDerivedStatus, type DerivedIdeaStatus } from "@/services/idea.service";
import { computeProjectAccess, levelAtLeast } from "@/services/project-access.service";
import { getProjectAgentTeam, ProjectTeamError, projectTeamTransaction, type ProjectTeamClient } from "@/services/project-agent-team.service";

const uuidSchema = z.string().uuid().transform((value) => value.toLowerCase());
const inputSchema = z.union([
  z.object({ leadAgentUuid: uuidSchema, preview: z.literal(true) }).strict(),
  z.object({ leadAgentUuid: uuidSchema, confirmationToken: z.string().min(1).max(1024) }).strict(),
]);
const tokenSchema = z.object({ version: z.literal(1), expiresAt: z.number().int(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const PREVIEW_TTL_MS = 5 * 60 * 1000;

export interface ProjectTeamHandoffCandidate {
  uuid: string;
  title: string;
  status: string;
  derivedStatus: DerivedIdeaStatus;
  assigneeType: string | null;
  assigneeUuid: string | null;
}

export type ProjectTeamHandoffResult = {
  candidates: ProjectTeamHandoffCandidate[];
  count: number;
} & ({ confirmationToken: string; expiresAt: string } | { changedCount: number });

function conflict(): never {
  throw new ProjectTeamError("CONFLICT", "Handoff preview changed or expired; preview again");
}

function signature(payload: string) {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error("NEXTAUTH_SECRET is not set");
  return createHmac("sha256", secret).update(`project-team-handoff:v1:${payload}`).digest("hex");
}

function readToken(token: string) {
  const parts = token.split(".");
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[a-f0-9]{64}$/.test(parts[1])) conflict();
  if (!timingSafeEqual(Buffer.from(signature(parts[0]), "hex"), Buffer.from(parts[1], "hex"))) conflict();
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch {
    conflict();
  }
  const parsed = tokenSchema.safeParse(decoded);
  if (!parsed.success || parsed.data.expiresAt <= Date.now() || parsed.data.expiresAt > Date.now() + PREVIEW_TTL_MS) conflict();
  return parsed.data;
}

function stable(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

interface LifecycleIdea {
  uuid: string;
  status: string;
  elaborationStatus: string | null;
  isContainer: boolean;
  parentUuid: string | null;
}

async function derivedStatuses(client: ProjectTeamClient, companyUuid: string, projectUuid: string, ideas: LifecycleIdea[]) {
  const proposals = await client.proposal.findMany({
    where: { companyUuid, projectUuid, status: { in: ["approved", "pending"] } },
    select: { uuid: true, status: true, inputUuids: true, createdAt: true },
    orderBy: [{ createdAt: "desc" }, { uuid: "asc" }],
  });
  const latest = new Map<string, string>();
  const pending = new Set<string>();
  for (const proposal of proposals) {
    if (!Array.isArray(proposal.inputUuids)) continue;
    for (const ideaUuid of proposal.inputUuids) {
      if (typeof ideaUuid !== "string") continue;
      if (proposal.status === "pending") pending.add(ideaUuid);
      else if (!latest.has(ideaUuid)) latest.set(ideaUuid, proposal.uuid);
    }
  }
  const tasks = await client.task.findMany({
    where: { companyUuid, proposalUuid: { in: [...new Set(latest.values())] } },
    select: { uuid: true, proposalUuid: true, status: true }, orderBy: { uuid: "asc" },
  });
  const taskStatuses = new Map<string, string[]>();
  for (const task of tasks) {
    if (task.proposalUuid) taskStatuses.set(task.proposalUuid, [...(taskStatuses.get(task.proposalUuid) ?? []), task.status]);
  }
  const statuses = new Map(ideas.map((idea) => [idea.uuid, computeDerivedStatus({
    ideaStatus: idea.status, elaborationStatus: idea.elaborationStatus,
    hasPendingProposal: pending.has(idea.uuid), hasApprovedProposal: latest.has(idea.uuid),
    taskStatuses: taskStatuses.get(latest.get(idea.uuid) ?? "") ?? [],
  }).derivedStatus]));
  const byUuid = new Map(ideas.map((idea) => [idea.uuid, idea]));
  const children = new Map<string, string[]>();
  for (const idea of ideas) {
    if (idea.parentUuid && byUuid.has(idea.parentUuid)) children.set(idea.parentUuid, [...(children.get(idea.parentUuid) ?? []), idea.uuid]);
  }
  const cyclic = new Set<string>();
  const scanned = new Set<string>();
  for (const idea of ideas) {
    const path: string[] = [];
    const indices = new Map<string, number>();
    let cursor: string | null = idea.uuid;
    while (cursor && byUuid.has(cursor) && !scanned.has(cursor)) {
      const cycleStart = indices.get(cursor);
      if (cycleStart !== undefined) {
        for (const member of path.slice(cycleStart)) cyclic.add(member);
        break;
      }
      indices.set(cursor, path.length);
      path.push(cursor);
      cursor = byUuid.get(cursor)?.parentUuid ?? null;
    }
    for (const member of path) scanned.add(member);
  }
  const unresolved = new Map<string, number>();
  for (const idea of ideas) {
    if (idea.isContainer && children.has(idea.uuid) && !cyclic.has(idea.uuid)) unresolved.set(idea.uuid, 0);
  }
  const ready: string[] = [];
  for (const ideaUuid of unresolved.keys()) {
    const count = children.get(ideaUuid)!.filter((child) => unresolved.has(child)).length;
    unresolved.set(ideaUuid, count);
    if (!count) ready.push(ideaUuid);
  }
  for (let index = 0; index < ready.length; index += 1) {
    const ideaUuid = ready[index];
    statuses.set(ideaUuid, rollupThemeDerivedStatus(children.get(ideaUuid)!.map((child) => statuses.get(child)!)).derivedStatus);
    const parent = byUuid.get(ideaUuid)?.parentUuid;
    if (parent && unresolved.has(parent)) {
      const count = unresolved.get(parent)! - 1;
      unresolved.set(parent, count);
      if (!count) ready.push(parent);
    }
  }
  return { statuses, proposals, tasks };
}

async function readState(auth: AuthContext, projectUuid: string, leadAgentUuid: string, client: ProjectTeamClient) {
  const access = await computeProjectAccess(auth, projectUuid, client);
  if (!access.project || !levelAtLeast(access.level, "viewer")) throw new ProjectTeamError("NOT_FOUND", "Project not found");
  if (!levelAtLeast(access.level, "editor")) throw new ProjectTeamError("FORBIDDEN", "Editor project access is required for handoff");
  const scope = { companyUuid: auth.companyUuid, projectUuid, ownerUuid: auth.actorUuid };
  const team = await getProjectAgentTeam(auth, projectUuid, client);
  const config = await client.projectAgentTeam.findFirst({ where: scope });
  if (!team || !config) throw new ProjectTeamError("NOT_FOUND", "Project team not found");
  const lead = team.roles.lead.find((member) => member.agentUuid === leadAgentUuid && member.eligible);
  if (!lead) throw new ProjectTeamError("CONFLICT", "Select a current eligible lead and preview again");
  const agents = await client.agent.findMany({
    where: { companyUuid: auth.companyUuid, ownerUuid: auth.actorUuid }, select: { uuid: true }, orderBy: { uuid: "asc" },
  });
  const ownedAgents = new Set(agents.map((agent) => agent.uuid));
  if (!ownedAgents.has(leadAgentUuid)) conflict();
  const instances = await client.agentInstance.findMany({
    where: { companyUuid: auth.companyUuid, agentUuid: { in: [...ownedAgents] } },
    select: { uuid: true, agentUuid: true }, orderBy: { uuid: "asc" },
  });
  const instanceAgents = new Map(instances.map((instance) => [instance.uuid, instance.agentUuid]));
  const ideas = await client.idea.findMany({
    where: { companyUuid: auth.companyUuid, projectUuid },
    select: {
      uuid: true, title: true, status: true, elaborationStatus: true, parentUuid: true, isContainer: true,
      assigneeType: true, assigneeUuid: true, assignedAt: true, updatedAt: true,
      cwdSource: true, cwdHost: true, runtimeCwd: true,
    }, orderBy: { uuid: "asc" },
  });
  const lifecycle = await derivedStatuses(client, auth.companyUuid, projectUuid, ideas);
  const candidates = ideas.filter((idea) => {
    if (!idea.assigneeUuid || lifecycle.statuses.get(idea.uuid) === "done" || idea.status === "done" || idea.status === "closed") return false;
    if (idea.assigneeType === "user") return idea.assigneeUuid === auth.actorUuid;
    if (idea.assigneeType === "agent") return ownedAgents.has(idea.assigneeUuid);
    return idea.assigneeType === "agent_instance" && instanceAgents.has(idea.assigneeUuid);
  });
  const template = config.templateUuid ? await client.agentTeam.findFirst({
    where: { uuid: config.templateUuid, companyUuid: auth.companyUuid, ownerUuid: auth.actorUuid },
    select: { uuid: true, updatedAt: true },
  }) : null;
  const preference = await client.projectAgentCwdPreference.findFirst({
    where: { companyUuid: auth.companyUuid, userUuid: auth.actorUuid, projectUuid, agentUuid: leadAgentUuid },
  });
  const fingerprint = createHash("sha256").update(stable({
    companyUuid: auth.companyUuid, actorUuid: auth.actorUuid, projectUuid, leadAgentUuid,
    config, template, preference,
    roles: AGENT_TEAM_ROLES.map((role) => [role, team.roles[role].map((member) => ({
      agentUuid: member.agentUuid, eligible: member.eligible, hasProjectAccess: member.hasProjectAccess,
      missingPermissions: [...member.missingPermissions].sort(),
    })).sort((left, right) => left.agentUuid.localeCompare(right.agentUuid))]),
    candidates: candidates.map((idea) => ({ ...idea, logicalAgentUuid: idea.assigneeType === "agent_instance" ? instanceAgents.get(idea.assigneeUuid!) : null })),
    lifecycle: { ideas: ideas.map(({ uuid, status, elaborationStatus, parentUuid, isContainer }) => ({ uuid, status, elaborationStatus, parentUuid, isContainer })), proposals: lifecycle.proposals, tasks: lifecycle.tasks },
  })).digest("hex");
  return { config, preference, fingerprint, candidates, instanceAgents, statuses: lifecycle.statuses };
}

export async function handoffProjectTeam(auth: AuthContext, projectUuid: string, input: unknown): Promise<ProjectTeamHandoffResult> {
  if (auth.type !== "user") throw new ProjectTeamError("FORBIDDEN", "Only users can hand off project ideas");
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new ProjectTeamError("VALIDATION_ERROR", "Invalid handoff request", parsed.error.flatten());
  const project = uuidSchema.safeParse(projectUuid);
  if (!project.success) throw new ProjectTeamError("NOT_FOUND", "Project not found");
  projectUuid = project.data;
  const request = parsed.data;
  const confirmed = "confirmationToken" in request ? readToken(request.confirmationToken) : null;
  const committed = await projectTeamTransaction(async (client) => {
    const state = await readState(auth, projectUuid, request.leadAgentUuid, client);
    const candidates = state.candidates.map(({ uuid, title, status, assigneeType, assigneeUuid }) => ({
      uuid, title, status, assigneeType, assigneeUuid, derivedStatus: state.statuses.get(uuid)!,
    }));
    if (!confirmed) {
      const expiresAt = Date.now() + PREVIEW_TTL_MS;
      const payload = Buffer.from(JSON.stringify({ version: 1, expiresAt, fingerprint: state.fingerprint })).toString("base64url");
      return { result: { candidates, count: candidates.length, confirmationToken: `${payload}.${signature(payload)}`, expiresAt: new Date(expiresAt).toISOString() }, publish: [] };
    }
    if (confirmed.expiresAt <= Date.now() || confirmed.fingerprint !== state.fingerprint) conflict();
    const changed = state.candidates.filter((idea) =>
      !(idea.assigneeType === "agent" && idea.assigneeUuid === request.leadAgentUuid)
      && !(idea.assigneeType === "agent_instance" && state.instanceAgents.get(idea.assigneeUuid!) === request.leadAgentUuid));
    let instanceUuid: string | null = null;
    const preference = state.preference;
    if (changed.length && preference) {
      if (!preference.host || !preference.cwd) throw new ProjectTeamError("CONFLICT", "Project fixed working directory is invalid");
      const instance = await client.agentInstance.upsert({
        where: { companyUuid_agentUuid_host_cwd: { companyUuid: auth.companyUuid, agentUuid: request.leadAgentUuid, host: preference.host, cwd: preference.cwd } },
        create: { companyUuid: auth.companyUuid, agentUuid: request.leadAgentUuid, host: preference.host, cwd: preference.cwd },
        update: { updatedAt: new Date() }, select: { uuid: true },
      });
      instanceUuid = instance.uuid;
      await client.projectAgentCwdPreference.update({ where: { uuid: preference.uuid }, data: { anchorAgentInstanceUuid: instanceUuid } });
    }
    const publish: (() => void)[] = [];
    for (const idea of changed) {
      const updated = await client.idea.updateMany({
        where: { uuid: idea.uuid, companyUuid: auth.companyUuid, projectUuid, assigneeType: idea.assigneeType, assigneeUuid: idea.assigneeUuid, status: idea.status, updatedAt: idea.updatedAt },
        data: {
          assigneeType: instanceUuid ? "agent_instance" : "agent", assigneeUuid: instanceUuid ?? request.leadAgentUuid,
          status: idea.status === "open" ? "elaborating" : idea.status,
          assignedByType: "user", assignedByUuid: auth.actorUuid, assignedAt: new Date(),
          cwdSource: preference ? "project_fixed" : null, cwdHost: preference?.host ?? null, runtimeCwd: preference?.cwd ?? null,
        },
      });
      if (updated.count !== 1) conflict();
      const activity = await createActivityInTx(client, {
        companyUuid: auth.companyUuid, projectUuid, targetType: "idea", targetUuid: idea.uuid,
        actorType: "user", actorUuid: auth.actorUuid, action: "assigned",
        value: {
          assigneeType: "agent", assigneeUuid: request.leadAgentUuid,
          ...(instanceUuid ? { instanceUuid } : {}),
          ...(preference ? { resolvedCwdSource: "project_fixed", resolvedCwdHost: preference.host, resolvedRuntimeCwd: preference.cwd } : {}),
        },
      });
      publish.push(activity.publish, () => eventBus.emitChange({ companyUuid: auth.companyUuid, projectUuid, entityType: "idea", entityUuid: idea.uuid, action: "updated" }));
    }
    const saved = await client.projectAgentTeam.updateMany({
      where: { uuid: state.config.uuid, companyUuid: auth.companyUuid, ownerUuid: auth.actorUuid, projectUuid, revision: state.config.revision },
      data: { lastLeadAgentUuid: request.leadAgentUuid, revision: { increment: 1 } },
    });
    if (saved.count !== 1) conflict();
    return { result: { candidates, count: candidates.length, changedCount: changed.length }, publish };
  }).catch((caught: unknown) => {
    if (caught && typeof caught === "object" && "code" in caught && caught.code === "P2034") conflict();
    throw caught;
  });
  for (const publish of committed.publish) publish();
  return committed.result;
}
