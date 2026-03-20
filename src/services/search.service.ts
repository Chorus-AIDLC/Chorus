// src/services/search.service.ts
// Search Service Layer — Unified search across 6 entity types
// UUID-Based Architecture: All operations use UUIDs

import { prisma } from "@/lib/prisma";

// ===== Type Definitions =====

export type EntityType = "task" | "idea" | "proposal" | "document" | "project" | "project_group";
export type SearchScope = "global" | "group" | "project";

export interface SearchParams {
  query: string;
  companyUuid: string;
  scope?: SearchScope;
  scopeUuid?: string;  // project group UUID or project UUID
  entityTypes?: EntityType[];
  limit?: number;
}

export interface SearchResult {
  entityType: EntityType;
  uuid: string;
  title: string;
  snippet: string;  // ~100 char excerpt around match
  status: string;
  projectUuid: string | null;  // null for project_group
  projectName: string | null;  // null for project_group
  updatedAt: string;
}

export interface SearchCounts {
  tasks: number;
  ideas: number;
  proposals: number;
  documents: number;
  projects: number;
  projectGroups: number;
}

export interface SearchResponse {
  results: SearchResult[];
  counts: SearchCounts;
}

// ===== Helper Functions =====

// Generate snippet: extract ~100 chars around the first match position
function generateSnippet(text: string, query: string, maxLength = 100): string {
  if (!text) return "";

  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const matchIndex = lowerText.indexOf(lowerQuery);

  if (matchIndex === -1) {
    // No match found, return beginning
    return text.substring(0, maxLength) + (text.length > maxLength ? "..." : "");
  }

  // Calculate start position (try to center the match)
  const halfLength = Math.floor(maxLength / 2);
  let start = Math.max(0, matchIndex - halfLength);

  // Adjust start to avoid cutting words if possible
  if (start > 0) {
    const spaceIndex = text.lastIndexOf(" ", start + 10);
    if (spaceIndex > start && spaceIndex < start + 20) {
      start = spaceIndex + 1;
    }
  }

  let snippet = text.substring(start, start + maxLength);

  // Add ellipsis
  if (start > 0) snippet = "..." + snippet;
  if (start + maxLength < text.length) snippet = snippet + "...";

  return snippet.trim();
}

// Resolve project UUIDs for a group scope
async function resolveGroupProjects(companyUuid: string, groupUuid: string): Promise<string[]> {
  const projects = await prisma.project.findMany({
    where: { companyUuid, groupUuid },
    select: { uuid: true },
  });
  return projects.map(p => p.uuid);
}

// ===== Entity Search Functions =====

async function searchTasks(
  companyUuid: string,
  query: string,
  projectUuids: string[] | null,
  limit: number
): Promise<{ results: SearchResult[]; count: number }> {
  const where: {
    companyUuid: string;
    OR: Array<{ title: { contains: string; mode: "insensitive" } } | { description: { contains: string; mode: "insensitive" } }>;
    projectUuid?: { in: string[] };
  } = {
    companyUuid,
    OR: [
      { title: { contains: query, mode: "insensitive" } },
      { description: { contains: query, mode: "insensitive" } },
    ],
  };

  if (projectUuids) {
    where.projectUuid = { in: projectUuids };
  }

  const [tasks, count] = await Promise.all([
    prisma.task.findMany({
      where,
      take: limit,
      orderBy: { updatedAt: "desc" },
      select: {
        uuid: true,
        title: true,
        description: true,
        status: true,
        projectUuid: true,
        updatedAt: true,
        project: { select: { name: true } },
      },
    }),
    prisma.task.count({ where }),
  ]);

  const results: SearchResult[] = tasks.map(task => ({
    entityType: "task" as const,
    uuid: task.uuid,
    title: task.title,
    snippet: generateSnippet(task.description || task.title, query),
    status: task.status,
    projectUuid: task.projectUuid,
    projectName: task.project.name,
    updatedAt: task.updatedAt.toISOString(),
  }));

  return { results, count };
}

async function searchIdeas(
  companyUuid: string,
  query: string,
  projectUuids: string[] | null,
  limit: number
): Promise<{ results: SearchResult[]; count: number }> {
  const where: {
    companyUuid: string;
    OR: Array<{ title: { contains: string; mode: "insensitive" } } | { content: { contains: string; mode: "insensitive" } }>;
    projectUuid?: { in: string[] };
  } = {
    companyUuid,
    OR: [
      { title: { contains: query, mode: "insensitive" } },
      { content: { contains: query, mode: "insensitive" } },
    ],
  };

  if (projectUuids) {
    where.projectUuid = { in: projectUuids };
  }

  const [ideas, count] = await Promise.all([
    prisma.idea.findMany({
      where,
      take: limit,
      orderBy: { updatedAt: "desc" },
      select: {
        uuid: true,
        title: true,
        content: true,
        status: true,
        projectUuid: true,
        updatedAt: true,
        project: { select: { name: true } },
      },
    }),
    prisma.idea.count({ where }),
  ]);

  const results: SearchResult[] = ideas.map(idea => ({
    entityType: "idea" as const,
    uuid: idea.uuid,
    title: idea.title,
    snippet: generateSnippet(idea.content || idea.title, query),
    status: idea.status,
    projectUuid: idea.projectUuid,
    projectName: idea.project.name,
    updatedAt: idea.updatedAt.toISOString(),
  }));

  return { results, count };
}

async function searchProposals(
  companyUuid: string,
  query: string,
  projectUuids: string[] | null,
  limit: number
): Promise<{ results: SearchResult[]; count: number }> {
  const where: {
    companyUuid: string;
    OR: Array<{ title: { contains: string; mode: "insensitive" } } | { description: { contains: string; mode: "insensitive" } }>;
    projectUuid?: { in: string[] };
  } = {
    companyUuid,
    OR: [
      { title: { contains: query, mode: "insensitive" } },
      { description: { contains: query, mode: "insensitive" } },
    ],
  };

  if (projectUuids) {
    where.projectUuid = { in: projectUuids };
  }

  const [proposals, count] = await Promise.all([
    prisma.proposal.findMany({
      where,
      take: limit,
      orderBy: { updatedAt: "desc" },
      select: {
        uuid: true,
        title: true,
        description: true,
        status: true,
        projectUuid: true,
        updatedAt: true,
        project: { select: { name: true } },
      },
    }),
    prisma.proposal.count({ where }),
  ]);

  const results: SearchResult[] = proposals.map(proposal => ({
    entityType: "proposal" as const,
    uuid: proposal.uuid,
    title: proposal.title,
    snippet: generateSnippet(proposal.description || proposal.title, query),
    status: proposal.status,
    projectUuid: proposal.projectUuid,
    projectName: proposal.project.name,
    updatedAt: proposal.updatedAt.toISOString(),
  }));

  return { results, count };
}

async function searchDocuments(
  companyUuid: string,
  query: string,
  projectUuids: string[] | null,
  limit: number
): Promise<{ results: SearchResult[]; count: number }> {
  const where: {
    companyUuid: string;
    OR: Array<{ title: { contains: string; mode: "insensitive" } } | { content: { contains: string; mode: "insensitive" } }>;
    projectUuid?: { in: string[] };
  } = {
    companyUuid,
    OR: [
      { title: { contains: query, mode: "insensitive" } },
      { content: { contains: query, mode: "insensitive" } },
    ],
  };

  if (projectUuids) {
    where.projectUuid = { in: projectUuids };
  }

  const [documents, count] = await Promise.all([
    prisma.document.findMany({
      where,
      take: limit,
      orderBy: { updatedAt: "desc" },
      select: {
        uuid: true,
        title: true,
        content: true,
        type: true,
        projectUuid: true,
        updatedAt: true,
        project: { select: { name: true } },
      },
    }),
    prisma.document.count({ where }),
  ]);

  const results: SearchResult[] = documents.map(doc => ({
    entityType: "document" as const,
    uuid: doc.uuid,
    title: doc.title,
    snippet: generateSnippet(doc.content || doc.title, query),
    status: doc.type,  // Use document type as status
    projectUuid: doc.projectUuid,
    projectName: doc.project.name,
    updatedAt: doc.updatedAt.toISOString(),
  }));

  return { results, count };
}

async function searchProjects(
  companyUuid: string,
  query: string,
  projectUuids: string[] | null,
  limit: number
): Promise<{ results: SearchResult[]; count: number }> {
  const where: {
    companyUuid: string;
    OR: Array<{ name: { contains: string; mode: "insensitive" } } | { description: { contains: string; mode: "insensitive" } }>;
    uuid?: { in: string[] } | string;
  } = {
    companyUuid,
    OR: [
      { name: { contains: query, mode: "insensitive" } },
      { description: { contains: query, mode: "insensitive" } },
    ],
  };

  if (projectUuids) {
    // For project scope: return only that specific project if it matches
    if (projectUuids.length === 1) {
      where.uuid = projectUuids[0];
    } else {
      // For group scope: return projects in the group
      where.uuid = { in: projectUuids };
    }
  }

  const [projects, count] = await Promise.all([
    prisma.project.findMany({
      where,
      take: limit,
      orderBy: { updatedAt: "desc" },
      select: {
        uuid: true,
        name: true,
        description: true,
        updatedAt: true,
      },
    }),
    prisma.project.count({ where }),
  ]);

  const results: SearchResult[] = projects.map(project => ({
    entityType: "project" as const,
    uuid: project.uuid,
    title: project.name,
    snippet: generateSnippet(project.description || project.name, query),
    status: "active",  // Projects don't have status, use "active"
    projectUuid: null,  // Project itself has no parent project
    projectName: null,
    updatedAt: project.updatedAt.toISOString(),
  }));

  return { results, count };
}

async function searchProjectGroups(
  companyUuid: string,
  query: string,
  groupUuid: string | null,
  limit: number
): Promise<{ results: SearchResult[]; count: number }> {
  const where: {
    companyUuid: string;
    OR: Array<{ name: { contains: string; mode: "insensitive" } } | { description: { contains: string; mode: "insensitive" } }>;
    uuid?: string;
  } = {
    companyUuid,
    OR: [
      { name: { contains: query, mode: "insensitive" } },
      { description: { contains: query, mode: "insensitive" } },
    ],
  };

  // For group scope: return only that specific group if it matches
  if (groupUuid) {
    where.uuid = groupUuid;
  }

  const [groups, count] = await Promise.all([
    prisma.projectGroup.findMany({
      where,
      take: limit,
      orderBy: { updatedAt: "desc" },
      select: {
        uuid: true,
        name: true,
        description: true,
        updatedAt: true,
      },
    }),
    prisma.projectGroup.count({ where }),
  ]);

  const results: SearchResult[] = groups.map(group => ({
    entityType: "project_group" as const,
    uuid: group.uuid,
    title: group.name,
    snippet: generateSnippet(group.description || group.name, query),
    status: "active",  // Project groups don't have status, use "active"
    projectUuid: null,
    projectName: null,
    updatedAt: group.updatedAt.toISOString(),
  }));

  return { results, count };
}

// ===== Main Search Function =====

export async function search(params: SearchParams): Promise<SearchResponse> {
  const {
    query,
    companyUuid,
    scope = "global",
    scopeUuid,
    entityTypes,
    limit = 20,
  } = params;

  // Validate scope requirements
  if ((scope === "group" || scope === "project") && !scopeUuid) {
    throw new Error(`scopeUuid is required for scope "${scope}"`);
  }

  // Determine which entity types to search
  const allTypes: EntityType[] = ["task", "idea", "proposal", "document", "project", "project_group"];
  const typesToSearch = entityTypes && entityTypes.length > 0 ? entityTypes : allTypes;

  // Resolve project UUIDs based on scope
  let projectUuids: string[] | null = null;
  let groupUuid: string | null = null;

  if (scope === "project" && scopeUuid) {
    projectUuids = [scopeUuid];
  } else if (scope === "group" && scopeUuid) {
    projectUuids = await resolveGroupProjects(companyUuid, scopeUuid);
    groupUuid = scopeUuid;
  }

  // Execute searches in parallel
  const searchPromises: Promise<{ results: SearchResult[]; count: number }>[] = [];
  const typeOrder: EntityType[] = [];

  for (const type of typesToSearch) {
    typeOrder.push(type);

    switch (type) {
      case "task":
        searchPromises.push(searchTasks(companyUuid, query, projectUuids, limit));
        break;
      case "idea":
        searchPromises.push(searchIdeas(companyUuid, query, projectUuids, limit));
        break;
      case "proposal":
        searchPromises.push(searchProposals(companyUuid, query, projectUuids, limit));
        break;
      case "document":
        searchPromises.push(searchDocuments(companyUuid, query, projectUuids, limit));
        break;
      case "project":
        searchPromises.push(searchProjects(companyUuid, query, projectUuids, limit));
        break;
      case "project_group":
        searchPromises.push(searchProjectGroups(companyUuid, query, groupUuid, limit));
        break;
    }
  }

  const searchResults = await Promise.all(searchPromises);

  // Combine results and build counts
  const allResults: SearchResult[] = [];
  const counts: SearchCounts = {
    tasks: 0,
    ideas: 0,
    proposals: 0,
    documents: 0,
    projects: 0,
    projectGroups: 0,
  };

  searchResults.forEach((result, index) => {
    allResults.push(...result.results);

    const type = typeOrder[index];
    switch (type) {
      case "task":
        counts.tasks = result.count;
        break;
      case "idea":
        counts.ideas = result.count;
        break;
      case "proposal":
        counts.proposals = result.count;
        break;
      case "document":
        counts.documents = result.count;
        break;
      case "project":
        counts.projects = result.count;
        break;
      case "project_group":
        counts.projectGroups = result.count;
        break;
    }
  });

  // Sort combined results by updatedAt desc and take top N
  allResults.sort((a, b) => {
    const dateA = new Date(a.updatedAt);
    const dateB = new Date(b.updatedAt);
    return dateB.getTime() - dateA.getTime();
  });

  const topResults = allResults.slice(0, limit);

  return {
    results: topResults,
    counts,
  };
}
