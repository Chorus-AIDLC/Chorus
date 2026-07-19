// src/services/project-visit.service.ts
// Project Visit Service Layer — per-user project quick-access state (recency + pin).
// UUID-Based Architecture: all operations are scoped by companyUuid + userUuid.
// See docs Tech Design "Sidebar project quick-access" for the read/write contract.

import { prisma } from "@/lib/prisma";

/** A resolved quick-access row: project identity + its group name (null if ungrouped). */
export interface ProjectRef {
  uuid: string;
  name: string;
  groupUuid: string | null;
  groupName: string | null;
}

/** The sidebar quick-access aggregate for a user. */
export interface SidebarQuickAccess {
  pinned: ProjectRef[];
  recent: ProjectRef[];
}

/** Recent list is capped at this many entries (after stale rows are dropped). */
const RECENT_LIMIT = 5;

/**
 * True when `projectUuid` names a live project in the caller's company.
 * Used to reject forged/foreign UUIDs before any write.
 */
async function projectInCompany(companyUuid: string, projectUuid: string): Promise<boolean> {
  const project = await prisma.project.findFirst({
    where: { uuid: projectUuid, companyUuid },
    select: { uuid: true },
  });
  return !!project;
}

/**
 * Record a project visit for the user, bumping `lastVisitedAt` to now and leaving
 * `pinnedAt` untouched. No-op-safe (fire-and-forget on every navigation). If the
 * project does not exist in the caller's company, nothing is written and nothing
 * is leaked.
 */
export async function recordVisit(
  companyUuid: string,
  userUuid: string,
  projectUuid: string
): Promise<void> {
  if (!(await projectInCompany(companyUuid, projectUuid))) return;

  const now = new Date();
  await prisma.projectVisit.upsert({
    where: { userUuid_projectUuid: { userUuid, projectUuid } },
    update: { lastVisitedAt: now },
    create: { companyUuid, userUuid, projectUuid, lastVisitedAt: now },
  });
}

/**
 * Pin a project for the user. Idempotent: re-pinning an already-pinned project
 * does NOT move `pinnedAt` (pin order is stable). On create the row is well-formed
 * with `lastVisitedAt` set. If the project is not in the caller's company, nothing
 * is written.
 */
export async function pinProject(
  companyUuid: string,
  userUuid: string,
  projectUuid: string
): Promise<void> {
  if (!(await projectInCompany(companyUuid, projectUuid))) return;

  const existing = await prisma.projectVisit.findUnique({
    where: { userUuid_projectUuid: { userUuid, projectUuid } },
    select: { pinnedAt: true },
  });
  // Already pinned → leave pinnedAt where it is (idempotent).
  if (existing?.pinnedAt) return;

  const now = new Date();
  await prisma.projectVisit.upsert({
    where: { userUuid_projectUuid: { userUuid, projectUuid } },
    update: { pinnedAt: now },
    create: { companyUuid, userUuid, projectUuid, pinnedAt: now, lastVisitedAt: now },
  });
}

/**
 * Unpin a project for the user by clearing `pinnedAt`. Idempotent and no-op-safe:
 * clearing an absent/unpinned row simply updates zero rows. The project falls back
 * into recent eligibility on the next read if its `lastVisitedAt` is recent enough.
 */
export async function unpinProject(
  companyUuid: string,
  userUuid: string,
  projectUuid: string
): Promise<void> {
  await prisma.projectVisit.updateMany({
    where: { companyUuid, userUuid, projectUuid },
    data: { pinnedAt: null },
  });
}

/**
 * Forget a project's visit for the user — the "remove from recent" action.
 * Deletes the (user, project) row so the project drops out of recent; the next
 * visit re-creates it (soft-remove: zero regret, no permanent hidden state).
 *
 * PINNED-GUARD: the `pinnedAt: null` predicate is in the WHERE clause, so a
 * pinned project's row is NEVER deleted by a remove — a pinned project only
 * leaves the sidebar via unpin. Uses `deleteMany` (not `delete`) so an absent or
 * pinned row is a zero-row no-op rather than a throw, matching `unpinProject`'s
 * idempotent posture. Scoped by company + user; no forged-UUID pre-check is
 * needed because the scope predicate already bounds the delete and removing a
 * non-existent row is harmless (unlike the create paths).
 */
export async function forgetVisit(
  companyUuid: string,
  userUuid: string,
  projectUuid: string
): Promise<void> {
  await prisma.projectVisit.deleteMany({
    where: { companyUuid, userUuid, projectUuid, pinnedAt: null },
  });
}

/**
 * Read the sidebar quick-access aggregate for a user:
 *   - `pinned`: rows with `pinnedAt` set, ordered by pin time ascending (unlimited).
 *   - `recent`: rows with `pinnedAt` null, ordered by `lastVisitedAt` descending,
 *     capped at 5.
 *
 * FILTER-THEN-CAP: every visit is resolved against LIVE, company-scoped projects
 * first (dropping any whose project was deleted or belongs to another company), and
 * only then is `recent` capped at 5. A stale/deleted newest visit never consumes a
 * recent slot, so the visible recent list is not under-filled below 5 when enough
 * live visits exist. Because a project has at most one row and pinned/recent are
 * split on `pinnedAt`, a pinned project never appears in recent (dedupe for free).
 */
export async function getSidebarQuickAccess(
  companyUuid: string,
  userUuid: string
): Promise<SidebarQuickAccess> {
  const [pinnedVisits, recentVisits] = await Promise.all([
    prisma.projectVisit.findMany({
      where: { companyUuid, userUuid, pinnedAt: { not: null } },
      orderBy: { pinnedAt: "asc" },
      select: { projectUuid: true },
    }),
    // No take() here — stale rows must be dropped BEFORE the cap is applied.
    prisma.projectVisit.findMany({
      where: { companyUuid, userUuid, pinnedAt: null },
      orderBy: { lastVisitedAt: "desc" },
      select: { projectUuid: true },
    }),
  ]);

  // Resolve every referenced project against live, company-scoped rows in bulk.
  const projectUuids = [
    ...new Set([...pinnedVisits, ...recentVisits].map((v) => v.projectUuid)),
  ];
  const projects = await prisma.project.findMany({
    where: { companyUuid, uuid: { in: projectUuids } },
    select: { uuid: true, name: true, groupUuid: true },
  });
  const projectMap = new Map(projects.map((p) => [p.uuid, p]));

  // Resolve group names in bulk (company-scoped).
  const groupUuids = [
    ...new Set(
      projects
        .map((p) => p.groupUuid)
        .filter((g): g is string => g !== null)
    ),
  ];
  const groups = await prisma.projectGroup.findMany({
    where: { companyUuid, uuid: { in: groupUuids } },
    select: { uuid: true, name: true },
  });
  const groupNameMap = new Map(groups.map((g) => [g.uuid, g.name]));

  const toRef = (p: { uuid: string; name: string; groupUuid: string | null }): ProjectRef => ({
    uuid: p.uuid,
    name: p.name,
    groupUuid: p.groupUuid,
    groupName: p.groupUuid ? groupNameMap.get(p.groupUuid) ?? null : null,
  });

  // Pinned: unlimited, ordered by pin time; drop stale rows.
  const pinned: ProjectRef[] = [];
  for (const v of pinnedVisits) {
    const p = projectMap.get(v.projectUuid);
    if (p) pinned.push(toRef(p));
  }

  // Recent: drop stale rows first, then cap at RECENT_LIMIT live entries.
  const recent: ProjectRef[] = [];
  for (const v of recentVisits) {
    if (recent.length >= RECENT_LIMIT) break;
    const p = projectMap.get(v.projectUuid);
    if (p) recent.push(toRef(p));
  }

  return { pinned, recent };
}
