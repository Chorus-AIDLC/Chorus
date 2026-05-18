// src/services/agent.service.ts
// Agent Service Layer (ARCHITECTURE.md §3.1 Service Layer)
// UUID-Based Architecture: All operations use UUIDs

import { prisma } from "@/lib/prisma";
import { generateApiKey } from "@/lib/api-key";
import { computeEffectivePermissions } from "@/lib/authz/permissions";
import type { Permission } from "@/lib/authz/types";

export interface AgentListParams {
  companyUuid: string;
  skip: number;
  take: number;
}

export interface AgentCreateParams {
  companyUuid: string;
  name: string;
  roles: string[];
  ownerUuid: string;
  persona?: string | null;
  systemPrompt?: string | null;
  permissions?: string[];
}

export interface AgentUpdateParams {
  name?: string;
  roles?: string[];
  persona?: string | null;
  systemPrompt?: string | null;
  permissions?: string[];
}

export interface ApiKeyCreateParams {
  companyUuid: string;
  agentUuid: string;
  name?: string | null;
  expiresAt?: Date | null;
}

// List agents query
export async function listAgents({ companyUuid, skip, take }: AgentListParams) {
  const [agents, total] = await Promise.all([
    prisma.agent.findMany({
      where: { companyUuid },
      skip,
      take,
      orderBy: { createdAt: "desc" },
      select: {
        uuid: true,
        name: true,
        roles: true,
        permissions: true,
        persona: true,
        ownerUuid: true,
        lastActiveAt: true,
        createdAt: true,
        _count: { select: { apiKeys: true } },
      },
    }),
    prisma.agent.count({ where: { companyUuid } }),
  ]);

  return { agents, total };
}

// Get Agent details
export async function getAgent(companyUuid: string, uuid: string) {
  return prisma.agent.findFirst({
    where: { uuid, companyUuid },
    include: {
      apiKeys: {
        where: { revokedAt: null },
        select: {
          uuid: true,
          keyPrefix: true,
          name: true,
          lastUsed: true,
          expiresAt: true,
          createdAt: true,
        },
      },
    },
  });
}

// Get Agent by UUID (for validation)
export async function getAgentByUuid(companyUuid: string, uuid: string) {
  return prisma.agent.findFirst({
    where: { uuid, companyUuid },
    select: { uuid: true, name: true, roles: true, permissions: true },
  });
}

// Create Agent
export async function createAgent({
  companyUuid,
  name,
  roles,
  ownerUuid,
  persona,
  systemPrompt,
  permissions,
}: AgentCreateParams) {
  return prisma.agent.create({
    data: {
      companyUuid,
      name,
      roles,
      ownerUuid,
      persona,
      systemPrompt,
      ...(permissions !== undefined && { permissions }),
    },
    select: {
      uuid: true,
      name: true,
      roles: true,
      permissions: true,
      persona: true,
      systemPrompt: true,
      ownerUuid: true,
      createdAt: true,
    },
  });
}

// Update Agent (by UUID, optionally scoped by company)
export async function updateAgent(uuid: string, data: AgentUpdateParams, companyUuid?: string) {
  // If companyUuid provided, verify agent belongs to company first
  if (companyUuid) {
    const agent = await prisma.agent.findFirst({
      where: { uuid, companyUuid },
      select: { uuid: true },
    });
    if (!agent) {
      throw new Error("Agent not found");
    }
  }

  return prisma.agent.update({
    where: { uuid },
    data,
    select: {
      uuid: true,
      name: true,
      roles: true,
      permissions: true,
      persona: true,
      systemPrompt: true,
      ownerUuid: true,
      lastActiveAt: true,
      createdAt: true,
    },
  });
}

// Sync API key names when agent name changes
export async function syncApiKeyNames(agentUuid: string, name: string) {
  return prisma.apiKey.updateMany({
    where: { agentUuid, revokedAt: null },
    data: { name },
  });
}

// Delete Agent (by UUID)
export async function deleteAgent(uuid: string) {
  return prisma.agent.delete({ where: { uuid } });
}

// List API Keys
export async function listApiKeys(companyUuid: string, skip: number, take: number, ownerUuid?: string) {
  const where = {
    companyUuid,
    revokedAt: null,
    ...(ownerUuid && { agent: { ownerUuid } }),
  };

  const [apiKeys, total] = await Promise.all([
    prisma.apiKey.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: "desc" },
      include: {
        agent: { select: { uuid: true, name: true, roles: true, permissions: true, persona: true } },
      },
    }),
    prisma.apiKey.count({ where }),
  ]);

  return { apiKeys, total };
}

// Create API Key (UUID-based)
export async function createApiKey({
  companyUuid,
  agentUuid,
  name,
  expiresAt,
}: ApiKeyCreateParams) {
  const { key, hash, prefix } = generateApiKey();

  const apiKey = await prisma.apiKey.create({
    data: {
      companyUuid,
      agentUuid,
      keyHash: hash,
      keyPrefix: prefix,
      name,
      expiresAt,
    },
    select: {
      uuid: true,
      keyPrefix: true,
      name: true,
      expiresAt: true,
      createdAt: true,
    },
  });

  // Return plaintext key (only visible at creation time)
  return { ...apiKey, key };
}

// Get API Key details
export async function getApiKey(companyUuid: string, uuid: string, ownerUuid?: string) {
  return prisma.apiKey.findFirst({
    where: {
      uuid,
      companyUuid,
      ...(ownerUuid && { agent: { ownerUuid } }),
    },
    select: { uuid: true, agentUuid: true, revokedAt: true },
  });
}

// Revoke API Key (by UUID)
export async function revokeApiKey(uuid: string) {
  return prisma.apiKey.update({
    where: { uuid },
    data: { revokedAt: new Date() },
  });
}

// Get Agents owned by user (for claim modal)
export async function getAgentsByOwner(companyUuid: string, ownerUuid: string) {
  return prisma.agent.findMany({
    where: { companyUuid, ownerUuid },
    select: {
      uuid: true,
      name: true,
      roles: true,
    },
    orderBy: { name: "asc" },
  });
}

// Get Agents by role (for assignment)
// Supports two role formats: "developer" and "developer_agent"
// ownerUuid: when provided, only returns Agents created by this user
export async function getAgentsByRole(companyUuid: string, role: string, ownerUuid?: string) {
  return prisma.agent.findMany({
    where: {
      companyUuid,
      ...(ownerUuid && { ownerUuid }),
      OR: [
        { roles: { has: role } },
        { roles: { has: `${role}_agent` } },
      ],
    },
    select: {
      uuid: true,
      name: true,
      roles: true,
      ownerUuid: true,
    },
    orderBy: { name: "asc" },
  });
}

// Get assignable agents (for assignment modals).
// Filters by *effective* permission (preset + custom), not by legacy
// `roles[]` preset name — so e.g. a custom agent that was granted
// `task:write` directly still shows up in the task picker.
// `ownerUuid` scopes to agents the caller created.
export async function getAssignableAgents(
  companyUuid: string,
  permission: Permission,
  ownerUuid?: string,
) {
  const agents = await prisma.agent.findMany({
    where: {
      companyUuid,
      ...(ownerUuid && { ownerUuid }),
    },
    select: {
      uuid: true,
      name: true,
      roles: true,
      permissions: true,
      ownerUuid: true,
    },
    orderBy: { name: "asc" },
  });

  return agents
    .filter((a) =>
      computeEffectivePermissions(a.roles, a.permissions).has(permission),
    )
    .map(({ uuid, name, roles, ownerUuid }) => ({
      uuid,
      name,
      roles,
      ownerUuid,
    }));
}

// Get all users in company (for assignment)
export async function getCompanyUsers(companyUuid: string) {
  return prisma.user.findMany({
    where: { companyUuid },
    select: {
      uuid: true,
      name: true,
      email: true,
    },
    orderBy: { name: "asc" },
  });
}
