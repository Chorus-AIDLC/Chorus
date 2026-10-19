// src/services/user.service.ts
// User service for OIDC-authenticated users
// UUID-Based Architecture: All operations use UUIDs

import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/api-handler";

function rejectManagedAccount(user: { authType?: string; status?: string; deletedAt?: Date | null } | null) {
  if (user && (user.authType === "local" || user.deletedAt || (user.status && user.status !== "active"))) {
    throw new ApiError("UNAUTHORIZED", "Invalid credentials", 401);
  }
}

// User creation/update input from OIDC
export interface OidcUserInput {
  oidcSub: string;
  email: string;
  name?: string;
  companyUuid: string;
}

const oidcUserSelect = {
  id: true,
  uuid: true,
  email: true,
  name: true,
  avatarSeed: true,
  oidcSub: true,
  companyUuid: true,
  authType: true,
  status: true,
  deletedAt: true,
  company: { select: { uuid: true, name: true } },
} as const;

async function syncOidcName(userId: number, companyUuid: string, name: string | undefined) {
  if (name !== undefined) {
    await prisma.user.updateMany({
      where: { id: userId, companyUuid, nameCustomized: false },
      data: { name },
    });
  }
  return prisma.user.findUniqueOrThrow({ where: { id: userId }, select: oidcUserSelect });
}

// Find or create user by OIDC subject
export async function findOrCreateUserByOidc(input: OidcUserInput) {
  const { oidcSub, email, name, companyUuid } = input;
  const companyState = await prisma.company.findFirst({ where: { uuid: companyUuid }, select: { localAuthEnabled: true } });
  if (!companyState || companyState.localAuthEnabled) throw new ApiError("UNAUTHORIZED", "Invalid credentials", 401);

  // First try to find existing user by OIDC subject in this company
  const user = await prisma.user.findFirst({
    where: {
      oidcSub,
      companyUuid,
    },
    select: {
      id: true,
      uuid: true,
      email: true,
      name: true,
      avatarSeed: true,
      oidcSub: true,
      companyUuid: true,
      authType: true,
      status: true,
      deletedAt: true,
      company: {
        select: {
          uuid: true,
          name: true,
        },
      },
    },
  });

  if (user) {
    rejectManagedAccount(user);
    // Update user info if changed
    if (user.email !== email) {
      await prisma.user.update({
        where: { id: user.id },
        data: { email },
        select: {
          id: true,
          uuid: true,
          email: true,
          name: true,
          avatarSeed: true,
          oidcSub: true,
          companyUuid: true,
          authType: true,
          status: true,
          deletedAt: true,
          company: {
            select: {
              uuid: true,
              name: true,
            },
          },
        },
      });
    }
    return syncOidcName(user.id, companyUuid, name);
  }

  // Check if user exists by email (might have been pre-created)
  const existingByEmail = await prisma.user.findFirst({
    where: {
      email,
      companyUuid,
    },
  });

  if (existingByEmail) {
    rejectManagedAccount(existingByEmail);
    // Link OIDC subject to existing user
    await prisma.user.update({
      where: { id: existingByEmail.id },
      data: { oidcSub },
      select: {
        id: true,
        uuid: true,
        email: true,
        name: true,
        avatarSeed: true,
        oidcSub: true,
        companyUuid: true,
        company: {
          select: {
            uuid: true,
            name: true,
          },
        },
      },
    });
    return syncOidcName(existingByEmail.id, companyUuid, name);
  }

  // Create new user
  return prisma.user.create({
    data: {
      email,
      name,
      oidcSub,
      companyUuid,
    },
    select: {
      id: true,
      uuid: true,
      email: true,
      name: true,
      avatarSeed: true,
      oidcSub: true,
      companyUuid: true,
      authType: true,
      status: true,
      deletedAt: true,
      company: {
        select: {
          uuid: true,
          name: true,
        },
      },
    },
  });
}

// Find or create user for default auth (auto-provision company + user)
export async function findOrCreateDefaultUser(email: string) {
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) {
    throw new Error("Invalid email: no domain");
  }

  // Look for company by email domain (without requiring oidcEnabled)
  let company = await prisma.company.findFirst({
    where: {
      emailDomains: {
        has: domain,
      },
    },
    select: {
      id: true,
      uuid: true,
      name: true,
      localAuthEnabled: true,
    },
  });

  if (company?.localAuthEnabled) throw new ApiError("UNAUTHORIZED", "Invalid credentials", 401);

  // If no company, create one
  if (!company) {
    company = await prisma.company.create({
      data: {
        name: domain,
        emailDomains: [domain],
        oidcEnabled: false,
      },
      select: {
        id: true,
        uuid: true,
        name: true,
        localAuthEnabled: true,
      },
    });
  }

  const existing = await prisma.user.findFirst({ where: { companyUuid: company.uuid, OR: [{ email: { equals: email, mode: "insensitive" } }, { oidcSub: `default_${email.toLowerCase()}` }] } });
  rejectManagedAccount(existing);
  const oidcSub = `default_${email.toLowerCase()}`;
  const userSelect = {
    id: true,
    uuid: true,
    email: true,
    name: true,
    avatarSeed: true,
    oidcSub: true,
    companyUuid: true,
    company: {
      select: {
        uuid: true,
        name: true,
      },
    },
  } as const;

  // Upsert to handle concurrent requests safely
  const user = await prisma.user.upsert({
    where: {
      companyUuid_oidcSub: {
        companyUuid: company.uuid,
        oidcSub,
      },
    },
    update: {
      email,
    },
    create: {
      email,
      name: email.split("@")[0],
      oidcSub,
      companyUuid: company.uuid,
    },
    select: userSelect,
  });

  return user;
}

// Get user by UUID with company info
export async function getUserByUuid(userUuid: string) {
  return prisma.user.findUnique({
    where: { uuid: userUuid },
    select: {
      id: true,
      uuid: true,
      email: true,
      name: true,
      avatarSeed: true,
      oidcSub: true,
      companyUuid: true,
      authType: true,
      status: true,
      deletedAt: true,
      company: {
        select: {
          uuid: true,
          name: true,
          oidcIssuer: true,
          oidcClientId: true,
        },
      },
    },
  });
}

// Get company by UUID (for OIDC callback)
export async function getCompanyByUuid(uuid: string) {
  return prisma.company.findFirst({
    where: { uuid },
    select: {
      id: true,
      uuid: true,
      name: true,
      oidcIssuer: true,
      oidcClientId: true,
      oidcEnabled: true,
      localAuthEnabled: true,
    },
  });
}
