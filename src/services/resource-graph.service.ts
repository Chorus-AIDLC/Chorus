// src/services/resource-graph.service.ts
// Project-scoped aggregation across Idea / Proposal / Task / Document for the
// "Resource Graph" view (per-project knowledge graph). Returns the four entity
// types as graph nodes and their relationships as typed edges.
//
// Modeled on getProjectTaskDependencies() (src/services/task.service.ts:1349):
// parallel queries scoped by companyUuid + projectUuid, then a pure mapping
// into the { nodes, edges } shape.
//
// All Prisma field names were verified against prisma/schema.prisma:
//   Idea.parentUuid          (schema:195)
//   Document.proposalUuid    (schema:221)
//   Task.proposalUuid        (schema:257)
//   TaskDependency           (schema:276) — { taskUuid, dependsOnUuid }
//   Proposal.inputType       (schema:329) — "idea" | "document"
//   Proposal.inputUuids      (schema:330) — Json (array of UUID strings)
//
// Multi-tenancy: every query filters on { companyUuid, projectUuid } so no
// cross-company / cross-project entity is ever returned. Edges that would
// reference a node outside the project (e.g. an Idea parent that lives in a
// different project, or a Task dependency on a task in another project) are
// silently dropped so the graph is closed under its own node set.
//
// Edge direction convention (documented explicitly per kind — DO NOT silently
// reuse the task-DAG convention, where the service returns
// { from: taskUuid, to: dependsOnUuid } and the renderer then flips it):
//
//   kind: "lineage"  — parent Idea  → child Idea
//                      from = parentIdeaUuid, to = childIdeaUuid
//
//   kind: "derive"   — source       → derivative (always points downstream)
//                      idea → proposal    : from = ideaUuid,     to = proposalUuid
//                      proposal → task    : from = proposalUuid, to = taskUuid
//                      proposal → document: from = proposalUuid, to = documentUuid
//
//                      ROOT-TASKS-ONLY rule for proposal → task: a proposal
//                      links ONLY to its root tasks — tasks whose in-proposal
//                      dependency indegree is 0 (no prerequisite that shares
//                      the same proposalUuid). Non-root tasks are reached
//                      transitively through `depends` edges; emitting a
//                      direct proposal → task edge for every task would
//                      collapse the layout into a hairball. A task whose only
//                      prerequisite lives in a DIFFERENT proposal still has
//                      in-proposal indegree 0 and so still gets its own
//                      proposal-edge (the cross-proposal `depends` arrow is
//                      preserved separately). proposal → document derive is
//                      NOT filtered this way — documents have no dependency
//                      chain, so every document gets its proposal edge.
//
//   kind: "depends"  — dependency   → dependent (upstream → downstream)
//                      from = dependsOnUuid (the prerequisite),
//                      to   = taskUuid       (the task that needs it)
//                      Rationale: the graph renderer wants the arrow to flow
//                      from "must finish first" toward "blocked by it", which
//                      matches the visual reading of "this depends on that".
//                      Emitted for every project-local TaskDependency row,
//                      independent of the root-tasks-only proposal filter.

import { prisma } from "@/lib/prisma";
import { computeDerivedStatus } from "@/services/idea.service";
import { STATUS_UNKNOWN_SENTINEL } from "@/app/(dashboard)/projects/[uuid]/graph/node-status";

export type ResourceGraphNodeType = "idea" | "proposal" | "task" | "document";
export type ResourceGraphEdgeKind = "derive" | "lineage" | "depends";

export interface ResourceGraphNode {
  uuid: string;
  type: ResourceGraphNodeType;
  title: string;
  // Per-node status string consumed by the renderer's shared `node-status.ts`
  // resolver. The semantics per type are:
  //   - idea     → derived `badgeHint` (8 values, e.g. "building",
  //                "review_proposal"), computed via `computeDerivedStatus`
  //                from the idea's latest approved proposal + tasks (same
  //                derivation as `getIdeasWithDerivedStatus`). A null
  //                badgeHint maps to `STATUS_UNKNOWN_SENTINEL` so this field
  //                is always a defined string.
  //   - proposal → raw `Proposal.status`
  //   - task     → raw `Task.status`
  //   - document → `Document.type` (documents have no lifecycle status, so
  //                their type carries the badge slot)
  status: string;
  // Idea-only: the lineage parent (null for top-level ideas). Used by the
  // client to build collapse groupings and to walk Idea→Idea lineage.
  parentIdeaUuid?: string | null;
  // Task/Document-only: source Proposal UUID (null for manually-created
  // entities). Used by the client to associate derivatives with their hub.
  proposalUuid?: string | null;
  // Proposal-only: the set of source-Idea UUIDs filtered to project-local
  // ideas. Empty for document-input proposals (inputType !== "idea") or when
  // none of the source ideas live in this project.
  sourceIdeaUuids?: string[];
}

export interface ResourceGraphEdge {
  from: string;
  to: string;
  kind: ResourceGraphEdgeKind;
}

export interface ResourceGraphResult {
  nodes: ResourceGraphNode[];
  edges: ResourceGraphEdge[];
}

/**
 * Aggregate every Idea / Proposal / Task / Document in a project plus their
 * derive / lineage / depends relationships into a flat { nodes, edges } graph.
 *
 * @param companyUuid - tenant scope (REQUIRED — never cross-company)
 * @param projectUuid - project scope (REQUIRED — never cross-project)
 *
 * Empty projects return { nodes: [], edges: [] } (not an error).
 * Orphan entities (no incident edges) still appear as standalone nodes.
 */
export async function getProjectResourceGraph(
  companyUuid: string,
  projectUuid: string
): Promise<ResourceGraphResult> {
  // Parallel queries — same pattern as getProjectTaskDependencies(). Every
  // findMany is doubly scoped (companyUuid AND projectUuid) so neither a
  // mistuned companyUuid nor a leaked projectUuid alone can produce data
  // from outside the caller's intended scope.
  const [ideas, proposals, tasks, documents, dependencies] = await Promise.all([
    prisma.idea.findMany({
      where: { companyUuid, projectUuid },
      // status + elaborationStatus feed `computeDerivedStatus` for the idea
      // node's `status` (derived badgeHint).
      select: {
        uuid: true,
        title: true,
        parentUuid: true,
        status: true,
        elaborationStatus: true,
      },
    }),
    prisma.proposal.findMany({
      where: { companyUuid, projectUuid },
      // status feeds two things: (1) the proposal node's own raw `status`
      // (badge), (2) the per-idea pending/approved partition used to derive
      // each idea's badgeHint — same shape as `getIdeasWithDerivedStatus`.
      select: {
        uuid: true,
        title: true,
        inputType: true,
        inputUuids: true,
        status: true,
        createdAt: true,
      },
    }),
    prisma.task.findMany({
      where: { companyUuid, projectUuid },
      // status feeds both the task node's badge AND each idea's badgeHint
      // (via the tasks-under-latest-approved-proposal grouping below).
      select: { uuid: true, title: true, proposalUuid: true, status: true },
    }),
    prisma.document.findMany({
      where: { companyUuid, projectUuid },
      // type stands in for status on documents (no lifecycle status).
      select: { uuid: true, title: true, proposalUuid: true, type: true },
    }),
    // TaskDependency has no companyUuid / projectUuid of its own — scope
    // through the related task. The dependsOn task is filtered separately
    // below to drop cross-project edges, since a Task can in principle
    // declare a dependency on a task in another project (the model doesn't
    // forbid it at the DB level).
    prisma.taskDependency.findMany({
      where: { task: { companyUuid, projectUuid } },
      select: { taskUuid: true, dependsOnUuid: true },
    }),
  ]);

  // Build the node list. Ideas carry parentIdeaUuid, proposals carry
  // sourceIdeaUuids (project-local only — filtered below), and
  // tasks/documents carry their source proposalUuid (kept as-is; if the
  // proposalUuid points outside the project, no derive edge is emitted but
  // the field is preserved so the client can still group/display).
  const ideaUuidSet = new Set(ideas.map((i) => i.uuid));
  const proposalUuidSet = new Set(proposals.map((p) => p.uuid));
  const taskUuidSet = new Set(tasks.map((t) => t.uuid));

  // --- Idea badgeHint derivation (mirror `getIdeasWithDerivedStatus`) ------
  //
  // For each idea, `computeDerivedStatus(...)` needs:
  //   - hasPendingProposal:  any proposal in this project whose inputUuids
  //                          contains the idea AND status === "pending"
  //   - hasApprovedProposal: same but status === "approved"
  //   - taskStatuses:        statuses of tasks whose `proposalUuid` is the
  //                          idea's LATEST approved proposal (the one
  //                          getIdeasWithDerivedStatus picks: max createdAt)
  //
  // The aggregation already loaded every proposal + task for the project, so
  // we derive everything in memory — no new query, no N+1. We re-use the
  // already-loaded sets and apply the same partitioning as
  // getIdeasWithDerivedStatus.
  const ideaToLatestApproved = new Map<string, { uuid: string; createdAt: Date }>();
  const ideasWithPendingProposal = new Set<string>();
  for (const proposal of proposals) {
    if (proposal.inputType !== "idea") continue;
    if (proposal.status !== "pending" && proposal.status !== "approved") continue;
    const rawIds = Array.isArray(proposal.inputUuids) ? (proposal.inputUuids as string[]) : [];
    for (const ideaUuid of rawIds) {
      if (proposal.status === "pending") {
        ideasWithPendingProposal.add(ideaUuid);
      } else {
        const existing = ideaToLatestApproved.get(ideaUuid);
        if (!existing || proposal.createdAt > existing.createdAt) {
          ideaToLatestApproved.set(ideaUuid, {
            uuid: proposal.uuid,
            createdAt: proposal.createdAt,
          });
        }
      }
    }
  }
  // Tasks grouped by their proposalUuid (only proposals that are some idea's
  // latest-approved are actually consulted, but a single pass keeps it simple).
  const tasksByProposal = new Map<string, string[]>();
  for (const task of tasks) {
    if (!task.proposalUuid) continue;
    const arr = tasksByProposal.get(task.proposalUuid);
    if (arr) arr.push(task.status);
    else tasksByProposal.set(task.proposalUuid, [task.status]);
  }

  const nodes: ResourceGraphNode[] = [
    ...ideas.map<ResourceGraphNode>((i) => {
      const latestApproved = ideaToLatestApproved.get(i.uuid);
      const taskStatuses = latestApproved
        ? tasksByProposal.get(latestApproved.uuid) ?? []
        : [];
      const { badgeHint } = computeDerivedStatus({
        ideaStatus: i.status,
        elaborationStatus: i.elaborationStatus,
        hasPendingProposal: ideasWithPendingProposal.has(i.uuid),
        hasApprovedProposal: !!latestApproved,
        taskStatuses,
      });
      return {
        uuid: i.uuid,
        type: "idea",
        title: i.title,
        // null badgeHint → defined sentinel so `status` is always a string
        // and the renderer's node-status resolver has a defined value to map.
        status: badgeHint ?? STATUS_UNKNOWN_SENTINEL,
        parentIdeaUuid: i.parentUuid ?? null,
      };
    }),
    ...proposals.map<ResourceGraphNode>((p) => {
      // inputUuids is a Json column; cast to string[] (matches the existing
      // convention in proposal.service.ts:201/249/422). Defensive guard so
      // a malformed row doesn't blow up the whole graph.
      const rawIds = Array.isArray(p.inputUuids) ? (p.inputUuids as string[]) : [];
      const sourceIdeaUuids =
        p.inputType === "idea"
          ? rawIds.filter((u) => ideaUuidSet.has(u)) // project-local only
          : [];
      return {
        uuid: p.uuid,
        type: "proposal",
        title: p.title,
        status: p.status,
        sourceIdeaUuids,
      };
    }),
    ...tasks.map<ResourceGraphNode>((t) => ({
      uuid: t.uuid,
      type: "task",
      title: t.title,
      status: t.status,
      proposalUuid: t.proposalUuid ?? null,
    })),
    ...documents.map<ResourceGraphNode>((d) => ({
      uuid: d.uuid,
      type: "document",
      title: d.title,
      // Documents have no lifecycle status; type carries the badge slot
      // (the design doc decision; see PRD/Tech Design).
      status: d.type,
      proposalUuid: d.proposalUuid ?? null,
    })),
  ];

  const edges: ResourceGraphEdge[] = [];

  // --- lineage: parent Idea → child Idea ------------------------------------
  // Only emit if BOTH endpoints are project-local. A parent in a sibling
  // project (rare but possible in principle) is silently dropped: the edge
  // would reference an unknown node.
  for (const idea of ideas) {
    if (idea.parentUuid && ideaUuidSet.has(idea.parentUuid)) {
      edges.push({
        from: idea.parentUuid,
        to: idea.uuid,
        kind: "lineage",
      });
    }
  }

  // --- derive: Idea → Proposal ---------------------------------------------
  // Only for inputType === "idea"; only for input UUIDs that resolve to a
  // project-local Idea (sourceIdeaUuids was pre-filtered above so we reuse
  // it via the proposal-node we just built).
  for (const proposal of proposals) {
    if (proposal.inputType !== "idea") continue;
    const rawIds = Array.isArray(proposal.inputUuids) ? (proposal.inputUuids as string[]) : [];
    for (const ideaUuid of rawIds) {
      if (ideaUuidSet.has(ideaUuid)) {
        edges.push({
          from: ideaUuid,
          to: proposal.uuid,
          kind: "derive",
        });
      }
    }
  }

  // --- derive: Proposal → Task ---------------------------------------------
  // Task.proposalUuid is optional (manual tasks). Only emit if the proposal
  // is also project-local; if it's not in the proposalUuidSet, the task is
  // an orphan w.r.t. the graph view (still appears as a node).
  //
  // Root-tasks-only filter: a task is a root within its proposal iff its
  // in-proposal dependency indegree is 0 — no TaskDependency row exists
  // where (this task is the dependent side) AND (the prerequisite task
  // belongs to the same proposal). We compute that indegree from the
  // already-queried `dependencies` rows + each task's proposalUuid; both
  // endpoints must be project-local (otherwise the depends edge itself
  // doesn't exist in the graph). The "same proposal" qualifier matters:
  // a cross-proposal prerequisite does NOT block the proposal-edge for
  // the downstream task — the cross-proposal `depends` arrow handles
  // that linkage on its own.
  const taskProposalUuidByUuid = new Map<string, string | null>(
    tasks.map((t) => [t.uuid, t.proposalUuid ?? null])
  );
  const inProposalIndegree = new Map<string, number>();
  for (const dep of dependencies) {
    if (!taskUuidSet.has(dep.taskUuid) || !taskUuidSet.has(dep.dependsOnUuid)) {
      // Cross-project edge — dropped by the graph anyway, so it cannot
      // contribute to a within-proposal indegree count.
      continue;
    }
    const downstreamProposalUuid = taskProposalUuidByUuid.get(dep.taskUuid) ?? null;
    const upstreamProposalUuid = taskProposalUuidByUuid.get(dep.dependsOnUuid) ?? null;
    if (
      downstreamProposalUuid !== null &&
      upstreamProposalUuid === downstreamProposalUuid
    ) {
      inProposalIndegree.set(
        dep.taskUuid,
        (inProposalIndegree.get(dep.taskUuid) ?? 0) + 1
      );
    }
  }
  for (const task of tasks) {
    if (!task.proposalUuid || !proposalUuidSet.has(task.proposalUuid)) continue;
    if ((inProposalIndegree.get(task.uuid) ?? 0) > 0) continue; // non-root: skip
    edges.push({
      from: task.proposalUuid,
      to: task.uuid,
      kind: "derive",
    });
  }

  // --- derive: Proposal → Document -----------------------------------------
  for (const document of documents) {
    if (document.proposalUuid && proposalUuidSet.has(document.proposalUuid)) {
      edges.push({
        from: document.proposalUuid,
        to: document.uuid,
        kind: "derive",
      });
    }
  }

  // --- depends: dependsOn Task → dependent Task ----------------------------
  // Direction is dependsOn → task ("must finish first" → "blocked by it").
  // Both endpoints must be project-local; the WHERE clause already restricts
  // the dependent side, this re-checks the dependsOn side.
  for (const dep of dependencies) {
    if (taskUuidSet.has(dep.taskUuid) && taskUuidSet.has(dep.dependsOnUuid)) {
      edges.push({
        from: dep.dependsOnUuid,
        to: dep.taskUuid,
        kind: "depends",
      });
    }
  }

  return { nodes, edges };
}
