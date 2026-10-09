// src/services/project-access.service.ts
// Project-level access control: visibility (public/private) × membership level.
// Single source of truth for "what can this actor do in this project?" — every
// REST route, page, server action, MCP tool and fan-out path goes through here.
//
// Levels (ordered): none < viewer < editor < admin
//   public project : explicit member role, floored at editor (everyone keeps full content r/w)
//   private project: local/group role or no-Admin fallback, else none
//   agents         : inherit their owner's membership; ownerless agents only see public projects

import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/api-handler";
import type { AuthContext } from "@/types/auth";
import type { Prisma, Project } from "@/generated/prisma/client";
import { firstCompanyUser, implicitGroupAdmin, implicitProjectAdmin, implicitProjectAdminUuids, invalidateImplicitGroupAdminCache } from "@/services/project-group-implicit-admin.service";
export type ProjectAccessClient = Pick<typeof prisma, "project" | "projectMember" | "projectGroupMember" | "projectGroup" | "user">;

export type ProjectVisibility = "public" | "private";
export type ProjectMemberRole = "viewer" | "editor" | "admin";
export type ProjectAccessLevel = "none" | ProjectMemberRole;
export type AccessEntityType = "project" | "idea" | "proposal" | "task" | "document" | "comment";

// Project-management operations (Tech Design D2 operation table)
export type ProjectOperation = "manage_project" | "change_visibility" | "manage_members";

export const PROJECT_VISIBILITIES: readonly ProjectVisibility[] = ["public", "private"];
export const PROJECT_MEMBER_ROLES: readonly ProjectMemberRole[] = ["viewer", "editor", "admin"];

const LEVEL_RANK: Record<ProjectAccessLevel, number> = { none: 0, viewer: 1, editor: 2, admin: 3 };

export function levelAtLeast(level: ProjectAccessLevel, min: ProjectAccessLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[min];
}

export function isProjectVisibility(value: unknown): value is ProjectVisibility {
  return typeof value === "string" && (PROJECT_VISIBILITIES as readonly string[]).includes(value);
}

export function isProjectMemberRole(value: unknown): value is ProjectMemberRole {
  return typeof value === "string" && (PROJECT_MEMBER_ROLES as readonly string[]).includes(value);
}

// ===== Errors (mapped to 404 / 403 by withErrorHandler via ApiError) =====

const ENTITY_LABEL: Record<AccessEntityType, string> = {
  project: "Project",
  idea: "Idea",
  proposal: "Proposal",
  task: "Task",
  document: "Document",
  comment: "Comment",
};

// Thrown when the actor has no access — indistinguishable from "does not exist".
export class ProjectNotFoundError extends ApiError {
  constructor(entityType: AccessEntityType = "project") {
    super("NOT_FOUND", `${ENTITY_LABEL[entityType]} not found`, 404);
    this.name = "ProjectNotFoundError";
  }
}

// Thrown when the actor can see the project but lacks the required level.
export class ProjectAccessDeniedError extends ApiError {
  constructor(message = "Insufficient project access") {
    super("FORBIDDEN", message, 403);
    this.name = "ProjectAccessDeniedError";
  }
}

// ===== Principal resolution =====

// The User whose membership governs this actor (agent → owner). null = no membership possible.
export function membershipPrincipal(auth: Pick<AuthContext, "type" | "actorUuid" | "ownerUuid">): string | null {
  if (auth.type === "user") return auth.actorUuid;
  if (auth.type === "agent") return auth.ownerUuid ?? null;
  return null;
}

export function resolveAccessLevel(visibility: string, memberRole: string | null): ProjectAccessLevel {
  const role: ProjectAccessLevel = isProjectMemberRole(memberRole) ? memberRole : "none";
  if (visibility === "private") return role;
  // Public (and any unknown value, fail-open to today's behaviour): floor at editor.
  return levelAtLeast(role, "editor") ? role : "editor";
}

// Only actual grants or the no-Admin fallback enter this calculation. A public
// group's company-wide editor baseline never exposes its private children.
export function resolveInheritedAccessLevel(
  visibility: string,
  localRole: string | null,
  groupRole: string | null,
): ProjectAccessLevel {
  const local = isProjectMemberRole(localRole) ? localRole : "none";
  const inherited = isProjectMemberRole(groupRole) ? groupRole : "none";
  return resolveAccessLevel(visibility, levelAtLeast(inherited, local) ? inherited : local);
}

// ===== Per-request memoisation =====

// Tech Design D3 contract: the full Project row (null when level is "none").
export interface ProjectAccessResult {
  project: Project | null;
  level: ProjectAccessLevel;
}
type AccessResult = ProjectAccessResult;

const accessCache = new WeakMap<object, Map<string, Promise<AccessResult>>>();

function cacheFor(auth: object): Map<string, Promise<AccessResult>> {
  let m = accessCache.get(auth);
  if (!m) {
    m = new Map();
    accessCache.set(auth, m);
  }
  return m;
}

// Call after a membership/visibility mutation so later checks in the same request see it.
export function invalidateProjectAccessCache(auth: object, projectUuid?: string): void {
  invalidateImplicitGroupAdminCache(auth);
  const m = accessCache.get(auth);
  if (!m) return;
  if (projectUuid) m.delete(projectUuid);
  else m.clear();
}

// ===== Core resolution =====

export async function computeProjectAccess(
  auth: AuthContext,
  projectUuid: string,
  client: ProjectAccessClient = prisma,
): Promise<AccessResult> {
  const project = await client.project.findFirst({
    where: { uuid: projectUuid, companyUuid: auth.companyUuid },
  });
  if (!project) return { project: null, level: "none" };

  const principal = membershipPrincipal(auth);
  let memberRole: string | null = null;
  if (principal) {
    const member = await client.projectMember.findUnique({
      where: { companyUuid: auth.companyUuid, projectUuid_userUuid: { projectUuid, userUuid: principal } },
      select: { role: true },
    });
    memberRole = member?.role ?? null;
  }

  const groupMember = project.groupUuid && principal
    ? await client.projectGroupMember.findFirst({
        where: { companyUuid: auth.companyUuid, groupUuid: project.groupUuid, userUuid: principal },
        select: { role: true },
      })
    : null;
  const automaticAdmin = project.groupUuid && principal
    ? await implicitGroupAdmin(auth.companyUuid, project.groupUuid, client, auth) : null;
  const groupRole = principal && principal === automaticAdmin ? "admin" : groupMember?.role ?? null;
  const automaticProjectAdmin = principal && groupRole !== "admin" && memberRole !== "admin"
    ? await implicitProjectAdmin(auth.companyUuid, projectUuid, client, auth) : null;
  const level = resolveInheritedAccessLevel(project.visibility, principal && principal === automaticProjectAdmin ? "admin" : memberRole, groupRole);
  return { project: level === "none" ? null : project, level };
}

export async function getProjectAccess(auth: AuthContext, projectUuid: string): Promise<AccessResult> {
  const cache = cacheFor(auth);
  let pending = cache.get(projectUuid);
  if (!pending) {
    pending = computeProjectAccess(auth, projectUuid);
    cache.set(projectUuid, pending);
    pending.catch(() => cache.delete(projectUuid));
  }
  return pending;
}

export async function requireProjectAccess(
  auth: AuthContext,
  projectUuid: string,
  min: ProjectMemberRole,
): Promise<Project & { accessLevel: ProjectMemberRole }> {
  const { project, level } = await getProjectAccess(auth, projectUuid);
  if (!project || level === "none") throw new ProjectNotFoundError("project");
  if (!levelAtLeast(level, min)) throw new ProjectAccessDeniedError();
  return { ...project, accessLevel: level };
}

// Required level per management operation, by visibility (Tech Design D2).
export function requiredLevelForOperation(op: ProjectOperation, visibility: string): ProjectMemberRole {
  if (op === "manage_project") return visibility === "private" ? "admin" : "editor";
  // change_visibility / manage_members require effective Admin, including the
  // no-Admin fallback. The public company editor floor alone never passes.
  return "admin";
}

export async function requireProjectOperation(
  auth: AuthContext,
  projectUuid: string,
  op: ProjectOperation,
): Promise<Project & { accessLevel: ProjectMemberRole }> {
  const { project, level } = await getProjectAccess(auth, projectUuid);
  if (!project || level === "none") throw new ProjectNotFoundError("project");
  const min = requiredLevelForOperation(op, project.visibility);
  if (!levelAtLeast(level, min)) {
    throw new ProjectAccessDeniedError(
      op === "manage_project" ? "Only project admins can manage this project" : "Only project admins can perform this action",
    );
  }
  return { ...project, accessLevel: level as ProjectMemberRole };
}

// ===== Entity → project =====

// Company-scoped. Returns null when the entity does not exist in the company.
export async function resolveEntityProjectUuid(
  companyUuid: string,
  entityType: AccessEntityType | string,
  entityUuid: string,
  client: Pick<typeof prisma, "project" | "idea" | "proposal" | "task" | "document" | "comment"> = prisma,
): Promise<string | null> {
  const where = { uuid: entityUuid, companyUuid };
  const select = { projectUuid: true } as const;
  switch (entityType) {
    case "project": {
      const p = await client.project.findFirst({ where, select: { uuid: true } });
      return p?.uuid ?? null;
    }
    case "idea":
      return (await client.idea.findFirst({ where, select }))?.projectUuid ?? null;
    case "proposal":
      return (await client.proposal.findFirst({ where, select }))?.projectUuid ?? null;
    case "task":
      return (await client.task.findFirst({ where, select }))?.projectUuid ?? null;
    case "document":
      return (await client.document.findFirst({ where, select }))?.projectUuid ?? null;
    case "comment": {
      const c = await client.comment.findFirst({ where, select: { targetType: true, targetUuid: true } });
      if (!c || c.targetType === "comment") return null;
      return resolveEntityProjectUuid(companyUuid, c.targetType, c.targetUuid, client);
    }
    default:
      return null;
  }
}

export async function requireEntityAccess(
  auth: AuthContext,
  entityType: AccessEntityType,
  entityUuid: string,
  min: ProjectMemberRole,
): Promise<{ projectUuid: string; accessLevel: ProjectMemberRole }> {
  const projectUuid = await resolveEntityProjectUuid(auth.companyUuid, entityType, entityUuid);
  if (!projectUuid) throw new ProjectNotFoundError(entityType);
  const { project, level } = await getProjectAccess(auth, projectUuid);
  if (!project || level === "none") throw new ProjectNotFoundError(entityType);
  if (!levelAtLeast(level, min)) throw new ProjectAccessDeniedError();
  return { projectUuid, accessLevel: level };
}

// ===== Multi-project filters =====

async function memberProjectUuids(companyUuid: string, principal: string | null): Promise<string[]> {
  if (!principal) return [];
  const rows = await prisma.projectMember.findMany({
    where: { companyUuid, userUuid: principal },
    select: { projectUuid: true },
  });
  return rows.map((r) => r.projectUuid);
}

// Prisma `where` for "projects this actor can see". Compose with AND for extra filters.
export async function accessibleProjectWhere(auth: AuthContext): Promise<Prisma.ProjectWhereInput> {
  const principal = membershipPrincipal(auth);
  const memberOf = await memberProjectUuids(auth.companyUuid, principal);
  const automaticAdmin = principal !== null && principal === await firstCompanyUser(auth.companyUuid, prisma, auth);
  const automaticProjects = automaticAdmin ? await implicitProjectAdminUuids(auth.companyUuid) : [];
  return {
    companyUuid: auth.companyUuid,
    OR: [
      { visibility: { not: "private" } },
      ...(memberOf.length > 0 ? [{ uuid: { in: memberOf } }] : []),
      ...(automaticProjects.length > 0 ? [{ uuid: { in: automaticProjects } }] : []),
      ...(principal ? [{ group: { companyUuid: auth.companyUuid, members: {
        some: { companyUuid: auth.companyUuid, userUuid: principal, role: { in: [...PROJECT_MEMBER_ROLES] } },
      } } }] : []),
      ...(automaticAdmin ? [{ group: { companyUuid: auth.companyUuid, members: {
        none: { companyUuid: auth.companyUuid, role: "admin" },
      } } }] : []),
    ],
  };
}

// UUIDs of every project the actor can see — for filtering non-Project tables.
export async function accessibleProjectUuids(auth: AuthContext): Promise<string[]> {
  const projects = await prisma.project.findMany({
    where: await accessibleProjectWhere(auth),
    select: { uuid: true },
  });
  return projects.map((p) => p.uuid);
}

// Keep only rows whose project the caller can see. For rows loaded by uuid across
// projects (e.g. a proposal's source ideas). Rows with no project are dropped.
export async function filterRowsByProjectAccess<T>(
  auth: AuthContext,
  rows: T[],
  projectOf: (row: T) => string | null | undefined,
): Promise<T[]> {
  if (rows.length === 0) return rows;
  const visible = new Set(await accessibleProjectUuids(auth));
  return rows.filter((row) => {
    const projectUuid = projectOf(row);
    return !!projectUuid && visible.has(projectUuid);
  });
}

// A root-idea lineage (lineage.service) starts at a visible entity but may climb
// into ideas of OTHER projects (a proposal can cite another project's idea).
// Idea nodes in projects hidden from the caller are removed, and the root /
// direct anchors and ambiguity candidates are re-derived from what is left, so
// no hidden idea's uuid or title is returned. All ideas hidden → the same shape
// as "no idea ancestor".
export async function redactLineageByAccess<
  T extends {
    rootIdeaUuid: string | null;
    directIdeaUuid: string | null;
    lineage: { type: string; uuid: string; title: string | null }[];
    resolvedVia: string;
    ambiguous?: boolean;
    candidates?: string[];
  },
>(auth: AuthContext, result: T): Promise<T> {
  const ideaUuids = new Set([
    ...result.lineage.filter((n) => n.type === "idea").map((n) => n.uuid),
    ...(result.candidates ?? []),
  ]);
  if (ideaUuids.size === 0) return result;
  const ideas = await prisma.idea.findMany({
    where: { companyUuid: auth.companyUuid, uuid: { in: [...ideaUuids] } },
    select: { uuid: true, projectUuid: true },
  });
  const visible = new Set(
    (await filterRowsByProjectAccess(auth, ideas, (i) => i.projectUuid)).map((i) => i.uuid),
  );
  if ([...ideaUuids].every((u) => visible.has(u))) return result;

  const lineage = result.lineage.filter((n) => n.type !== "idea" || visible.has(n.uuid));
  const ideaNodes = lineage.filter((n) => n.type === "idea");
  const rootIdeaUuid = ideaNodes.length ? ideaNodes[ideaNodes.length - 1].uuid : null;
  const candidates = (result.candidates ?? []).filter((u) => visible.has(u));
  const { ambiguous: _ambiguous, candidates: _candidates, ...rest } = result;
  void _ambiguous; void _candidates;
  return {
    ...rest,
    lineage,
    rootIdeaUuid,
    directIdeaUuid: ideaNodes[0]?.uuid ?? null,
    resolvedVia: rootIdeaUuid ? result.resolvedVia : "proposal_input_not_idea",
    ...(rootIdeaUuid && candidates.length > 1 ? { ambiguous: true, candidates } : {}),
  } as T;
}

// Access check for a third party (recipient / mention target / assignee), not the caller.
export async function canActorAccessProject(
  companyUuid: string,
  actor: { type: string; uuid: string },
  projectUuid: string,
  min: ProjectMemberRole,
  client: ProjectAccessClient & Pick<typeof prisma, "agent"> = prisma,
): Promise<boolean> {
  let ownerUuid: string | undefined;
  if (actor.type === "agent") {
    const agent = await client.agent.findFirst({
      where: { uuid: actor.uuid, companyUuid },
      select: { ownerUuid: true },
    });
    if (!agent) return false;
    ownerUuid = agent.ownerUuid ?? undefined;
  } else if (actor.type !== "user") {
    return false;
  }
  const { level } = await computeProjectAccess(
    { type: actor.type as "user" | "agent", companyUuid, actorUuid: actor.uuid, ownerUuid },
    projectUuid,
    client,
  );
  return levelAtLeast(level, min);
}

// Keep only recipients who can see the project (users by membership, agents via
// their owner). Used by every notification / mention fan-out so a private
// project never notifies — and therefore never wakes — an outsider.
// Batched: one project lookup, one membership query, one agent query.
export async function filterRecipientsByProjectAccess<T extends { type: string; uuid: string }>(
  companyUuid: string,
  projectUuid: string,
  recipients: T[],
): Promise<T[]> {
  if (recipients.length === 0) return recipients;
  const project = await prisma.project.findFirst({
    where: { uuid: projectUuid, companyUuid },
    select: { visibility: true, groupUuid: true },
  });
  if (!project) return [];
  if (project.visibility !== "private") return recipients.filter((r) => r.type === "user" || r.type === "agent");

  const agentUuids = recipients.filter((r) => r.type === "agent").map((r) => r.uuid);
  const agents = agentUuids.length
    ? await prisma.agent.findMany({
        where: { companyUuid, uuid: { in: agentUuids } },
        select: { uuid: true, ownerUuid: true },
      })
    : [];
  const ownerOf = new Map(agents.map((a) => [a.uuid, a.ownerUuid]));

  const principals = new Set<string>();
  for (const r of recipients) {
    if (r.type === "user") principals.add(r.uuid);
    else if (r.type === "agent" && ownerOf.get(r.uuid)) principals.add(ownerOf.get(r.uuid)!);
  }
  const members = principals.size
    ? await prisma.projectMember.findMany({
        where: { companyUuid, projectUuid, userUuid: { in: [...principals] } },
        select: { userUuid: true },
      })
    : [];
  const memberSet = new Set(members.map((m) => m.userUuid));
  const automaticProjectAdmin = await implicitProjectAdmin(companyUuid, projectUuid);
  if (automaticProjectAdmin && principals.has(automaticProjectAdmin)) memberSet.add(automaticProjectAdmin);
  if (project.groupUuid && principals.size) {
    const inherited = await prisma.projectGroupMember.findMany({
      where: { companyUuid, groupUuid: project.groupUuid, userUuid: { in: [...principals] },
        role: { in: [...PROJECT_MEMBER_ROLES] } },
      select: { userUuid: true },
    });
    for (const member of inherited) memberSet.add(member.userUuid);
    const automaticAdmin = await implicitGroupAdmin(companyUuid, project.groupUuid);
    if (automaticAdmin && principals.has(automaticAdmin)) memberSet.add(automaticAdmin);
  }

  return recipients.filter((r) => {
    if (r.type === "user") return memberSet.has(r.uuid);
    if (r.type === "agent") {
      const owner = ownerOf.get(r.uuid);
      return !!owner && memberSet.has(owner);
    }
    return false;
  });
}

// For a PRIVATE project, the user UUIDs of its members (so candidate queries can
// be scoped in the database instead of filtered after a `take`). Returns null
// for public projects or a project not in the company — callers then apply no
// membership restriction (and should still run their usual post-filter).
export async function privateProjectMemberUuids(companyUuid: string, projectUuid: string): Promise<string[] | null> {
  const project = await prisma.project.findFirst({
    where: { uuid: projectUuid, companyUuid },
    select: { visibility: true, groupUuid: true },
  });
  if (!project || project.visibility !== "private") return null;
  const rows = await prisma.projectMember.findMany({
    where: { projectUuid, companyUuid },
    select: { userUuid: true },
  });
  const inherited = project.groupUuid ? await prisma.projectGroupMember.findMany({
    where: { companyUuid, groupUuid: project.groupUuid, role: { in: [...PROJECT_MEMBER_ROLES] } },
    select: { userUuid: true },
  }) : [];
  const automaticAdmin = project.groupUuid ? await implicitGroupAdmin(companyUuid, project.groupUuid) : null;
  const automaticProjectAdmin = await implicitProjectAdmin(companyUuid, projectUuid);
  return [...new Set([...rows, ...inherited].map((r) => r.userUuid)
    .concat(automaticAdmin ? [automaticAdmin] : [], automaticProjectAdmin ? [automaticProjectAdmin] : []))];
}

// A proposal's stored inputs (ideas / documents) may live in other projects and
// may have become hidden after the proposal was created (visibility flip or
// membership removal). Any consumer that reads them on the caller's behalf —
// validate, submit — must re-check viewer access to EVERY input first; a hidden
// input 404s exactly like a missing one. Missing proposal → 404 "Proposal".
export async function requireProposalInputsAccess(auth: AuthContext, proposalUuid: string): Promise<void> {
  const proposal = await prisma.proposal.findFirst({
    where: { uuid: proposalUuid, companyUuid: auth.companyUuid },
    select: { inputType: true, inputUuids: true },
  });
  if (!proposal) throw new ProjectNotFoundError("proposal");
  const inputType = proposal.inputType === "document" ? "document" : "idea";
  const inputUuids = Array.isArray(proposal.inputUuids)
    ? proposal.inputUuids.filter((u): u is string => typeof u === "string")
    : [];
  for (const uuid of inputUuids) {
    await requireEntityAccess(auth, inputType, uuid, "viewer");
  }
}

// Execution rows (SSE + REST) carry the entity's project AND two lineage anchors
// (direct / root idea, the root with its title) that may live in OTHER projects.
// Connection ownership is not project access, so every source is judged on its own:
//   - a row whose own project (entity's project, else its direct/root idea's) is
//     hidden, or whose idea no longer resolves, is dropped;
//   - on a kept row, any direct/root anchor in a hidden project is redacted
//     (uuid → null, and rootIdeaTitle → null for the root), so a visible public
//     execution never carries a private idea's id or title.
// Ad-hoc rows (no project, no anchors) are kept. `visible` lets the SSE stream pass
// its live accessible set; otherwise it is computed for the caller.
export async function filterExecutionViewsByAccess<
  T extends {
    projectUuid: string | null;
    directIdeaUuid: string | null;
    rootIdeaUuid: string | null;
    rootIdeaTitle?: string | null;
  },
>(auth: AuthContext, rows: T[], visible?: ReadonlySet<string>): Promise<T[]> {
  if (rows.length === 0) return rows;
  const visibleSet = visible ?? new Set(await accessibleProjectUuids(auth));
  const ideaProject = new Map<string, Promise<string | null>>();
  // true = visible, false = hidden or unresolvable (fail closed)
  const ideaVisible = async (ideaUuid: string): Promise<boolean> => {
    if (!ideaProject.has(ideaUuid)) {
      ideaProject.set(
        ideaUuid,
        resolveEntityProjectUuid(auth.companyUuid, "idea", ideaUuid).catch(() => null),
      );
    }
    const projectUuid = await ideaProject.get(ideaUuid)!;
    return !!projectUuid && visibleSet.has(projectUuid);
  };

  const out: T[] = [];
  for (const row of rows) {
    const directOk = row.directIdeaUuid ? await ideaVisible(row.directIdeaUuid) : null;
    const rootOk = row.rootIdeaUuid ? await ideaVisible(row.rootIdeaUuid) : null;

    // The row's own project decides whether it is shown at all.
    const ownVisible = row.projectUuid
      ? visibleSet.has(row.projectUuid)
      : directOk ?? rootOk ?? true; // ad-hoc (no project, no anchors) → kept
    if (!ownVisible) continue;

    let redacted = row;
    if (directOk === false) redacted = { ...redacted, directIdeaUuid: null };
    if (rootOk === false) redacted = { ...redacted, rootIdeaUuid: null, rootIdeaTitle: null };
    out.push(redacted);
  }
  return out;
}
