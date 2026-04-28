// src/services/company.service.ts
// Company Service Layer (Super Admin Operations)
// UUID-Based Architecture: All operations use UUIDs

import { prisma } from "@/lib/prisma";
import { CompanyCreateInput, CompanyUpdateInput } from "@/types/admin";

// ===== Pagination Params =====
export interface PaginationParams {
  skip: number;
  take: number;
}

// ===== List =====
export async function listCompanies({ skip, take }: PaginationParams) {
  const [companies, total] = await Promise.all([
    prisma.company.findMany({
      skip,
      take,
      orderBy: { createdAt: "desc" },
      select: {
        uuid: true,
        name: true,
        emailDomains: true,
        oidcEnabled: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: {
            users: true,
            agents: true,
          },
        },
      },
    }),
    prisma.company.count(),
  ]);

  return { companies, total };
}

// ===== Get Details (by UUID) =====
export async function getCompanyByUuid(uuid: string) {
  return prisma.company.findFirst({
    where: { uuid },
    select: {
      id: true,
      uuid: true,
      name: true,
      emailDomains: true,
      oidcIssuer: true,
      oidcClientId: true,
      oidcEnabled: true,
      createdAt: true,
      updatedAt: true,
      _count: {
        select: {
          users: true,
          agents: true,
          projects: true,
        },
      },
    },
  });
}

// ===== Find Company by Email Domain =====
export async function getCompanyByEmailDomain(email: string) {
  // Extract email domain
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) {
    return null;
  }

  // Find Company containing this domain
  return prisma.company.findFirst({
    where: {
      emailDomains: {
        has: domain,
      },
      oidcEnabled: true,
    },
    select: {
      uuid: true,
      name: true,
      oidcIssuer: true,
      oidcClientId: true,
    },
  });
}

// ===== Create =====
export async function createCompany(data: CompanyCreateInput) {
  // Process email domains (lowercase)
  const emailDomains = (data.emailDomains || []).map((d) => d.toLowerCase());

  // Determine if OIDC is enabled (requires issuer and clientId)
  const oidcEnabled = !!(data.oidcIssuer && data.oidcClientId);

  return prisma.company.create({
    data: {
      name: data.name,
      emailDomains,
      oidcIssuer: data.oidcIssuer || null,
      oidcClientId: data.oidcClientId || null,
      oidcEnabled,
    },
    select: {
      uuid: true,
      name: true,
      emailDomains: true,
      oidcIssuer: true,
      oidcClientId: true,
      oidcEnabled: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

// ===== Update =====
export async function updateCompany(id: number, data: CompanyUpdateInput) {
  // Process email domains (lowercase)
  const updateData: CompanyUpdateInput = { ...data };
  if (data.emailDomains) {
    updateData.emailDomains = data.emailDomains.map((d) => d.toLowerCase());
  }

  return prisma.company.update({
    where: { id },
    data: updateData,
    select: {
      uuid: true,
      name: true,
      emailDomains: true,
      oidcIssuer: true,
      oidcClientId: true,
      oidcEnabled: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

// ===== Delete =====
export async function deleteCompany(id: number) {
  // Note: this will delete the Company and all associated data
  // Since relationMode = "prisma" is used, cascade deletes must be handled manually
  return prisma.$transaction(async (tx) => {
    // Get company info
    const company = await tx.company.findUnique({
      where: { id },
      select: { uuid: true },
    });

    if (!company) {
      throw new Error("Company not found");
    }

    // Delete associated data (in dependency order) - use companyUuid
    const companyUuid = company.uuid;
    await tx.activity.deleteMany({ where: { companyUuid } });
    await tx.comment.deleteMany({ where: { companyUuid } });
    await tx.proposal.deleteMany({ where: { companyUuid } });
    await tx.task.deleteMany({ where: { companyUuid } });
    await tx.document.deleteMany({ where: { companyUuid } });
    await tx.idea.deleteMany({ where: { companyUuid } });
    await tx.project.deleteMany({ where: { companyUuid } });
    await tx.apiKey.deleteMany({ where: { companyUuid } });
    await tx.agent.deleteMany({ where: { companyUuid } });
    await tx.user.deleteMany({ where: { companyUuid } });

    // Finally delete the Company
    return tx.company.delete({ where: { id } });
  });
}

// ===== Statistics =====
export async function getCompanyStats() {
  const [totalCompanies, totalUsers, totalAgents] = await Promise.all([
    prisma.company.count(),
    prisma.user.count(),
    prisma.agent.count(),
  ]);

  return { totalCompanies, totalUsers, totalAgents };
}

// ===== Find All Candidate Companies for an Email (domain ∪ existing User.email) =====
export async function getCandidateCompaniesForEmail(
  email: string
): Promise<
  Array<{
    uuid: string;
    name: string;
    oidcIssuer: string;
    oidcClientId: string;
  }>
> {
  const normalized = email.trim().toLowerCase();
  const domain = normalized.split("@")[1];
  if (!domain) {
    return [];
  }

  const oidcReady = {
    oidcEnabled: true,
    oidcIssuer: { not: null },
    oidcClientId: { not: null },
  } as const;

  const [domainMatches, users] = await Promise.all([
    prisma.company.findMany({
      where: {
        emailDomains: { has: domain },
        ...oidcReady,
      },
      select: {
        uuid: true,
        name: true,
        oidcIssuer: true,
        oidcClientId: true,
      },
    }),
    prisma.user.findMany({
      where: { email: normalized },
      select: { companyUuid: true },
    }),
  ]);

  const userCompanyUuids = Array.from(
    new Set(users.map((u) => u.companyUuid))
  );

  const userCompanyMatches = userCompanyUuids.length
    ? await prisma.company.findMany({
        where: {
          uuid: { in: userCompanyUuids },
          ...oidcReady,
        },
        select: {
          uuid: true,
          name: true,
          oidcIssuer: true,
          oidcClientId: true,
        },
      })
    : [];

  const merged = new Map<
    string,
    { uuid: string; name: string; oidcIssuer: string; oidcClientId: string }
  >();
  for (const c of [...domainMatches, ...userCompanyMatches]) {
    if (!c.oidcIssuer || !c.oidcClientId) continue;
    if (!merged.has(c.uuid)) {
      merged.set(c.uuid, {
        uuid: c.uuid,
        name: c.name,
        oidcIssuer: c.oidcIssuer,
        oidcClientId: c.oidcClientId,
      });
    }
  }

  return Array.from(merged.values()).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
}

// ===== Find Company by Email Domain (without oidcEnabled restriction) =====
export async function getCompanyByEmailDomainAny(email: string) {
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) {
    return null;
  }

  return prisma.company.findFirst({
    where: {
      emailDomains: {
        has: domain,
      },
    },
    select: {
      id: true,
      uuid: true,
      name: true,
      oidcIssuer: true,
      oidcClientId: true,
      oidcEnabled: true,
    },
  });
}
