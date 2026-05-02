// src/app/api/agents/[uuid]/route.ts
// Agents API - Detail, Update, Delete (ARCHITECTURE.md §5.1)
// UUID-Based Architecture: All operations use UUIDs

import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { withErrorHandler, parseBody } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, isUser } from "@/lib/auth";
import { isValidPermission, computeEffectivePermissions } from "@/lib/authz/permissions";

type RouteContext = { params: Promise<{ uuid: string }> };

// GET /api/agents/[uuid] - Agent Detail
export const GET = withErrorHandler<{ uuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }

    // Only users can view Agent details
    if (!isUser(auth)) {
      return errors.forbidden("Only users can view agent details");
    }

    const { uuid } = await context.params;

    const agent = await prisma.agent.findFirst({
      where: { uuid, companyUuid: auth.companyUuid },
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

    if (!agent) {
      return errors.notFound("Agent");
    }

    return success({
      uuid: agent.uuid,
      name: agent.name,
      roles: agent.roles,
      permissions: agent.permissions,
      effectivePermissions: Array.from(
        computeEffectivePermissions(agent.roles, agent.permissions),
      ),
      persona: agent.persona,
      systemPrompt: agent.systemPrompt,
      ownerUuid: agent.ownerUuid,
      lastActiveAt: agent.lastActiveAt?.toISOString() || null,
      apiKeys: agent.apiKeys.map((k) => ({
        uuid: k.uuid,
        prefix: k.keyPrefix,
        name: k.name,
        lastUsed: k.lastUsed?.toISOString() || null,
        expiresAt: k.expiresAt?.toISOString() || null,
        createdAt: k.createdAt.toISOString(),
      })),
      createdAt: agent.createdAt.toISOString(),
    });
  }
);

// PATCH /api/agents/[uuid] - Update Agent
export const PATCH = withErrorHandler<{ uuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }

    // Only users can update Agents
    if (!isUser(auth)) {
      return errors.forbidden("Only users can update agents");
    }

    const { uuid } = await context.params;

    const agent = await prisma.agent.findFirst({
      where: { uuid, companyUuid: auth.companyUuid },
    });

    if (!agent) {
      return errors.notFound("Agent");
    }

    const body = await parseBody<{
      name?: string;
      roles?: string[];
      persona?: string | null;
      systemPrompt?: string | null;
      permissions?: string[];
    }>(request);

    const updateData: {
      name?: string;
      roles?: string[];
      persona?: string | null;
      systemPrompt?: string | null;
      permissions?: string[];
    } = {};

    if (body.name !== undefined) {
      if (body.name.trim() === "") {
        return errors.validationError({ name: "Name cannot be empty" });
      }
      updateData.name = body.name.trim();
    }

    if (body.roles !== undefined) {
      const validRoles = ["pm_agent", "developer_agent", "admin_agent"];
      for (const role of body.roles) {
        if (!validRoles.includes(role)) {
          return errors.validationError({
            roles: "Roles must be pm_agent, developer_agent, or admin_agent",
          });
        }
      }
      if (body.roles.length === 0) {
        return errors.validationError({
          roles: "At least one role is required",
        });
      }
      updateData.roles = body.roles;
    }

    if (body.permissions !== undefined) {
      for (const p of body.permissions) {
        if (!isValidPermission(p)) {
          return errors.badRequest(`Invalid permission: ${p}`);
        }
      }
      updateData.permissions = body.permissions;
    }

    if (body.persona !== undefined) {
      updateData.persona = body.persona?.trim() || null;
    }

    if (body.systemPrompt !== undefined) {
      updateData.systemPrompt = body.systemPrompt?.trim() || null;
    }

    const updated = await prisma.agent.update({
      where: { uuid: agent.uuid },
      data: updateData,
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

    return success({
      uuid: updated.uuid,
      name: updated.name,
      roles: updated.roles,
      permissions: updated.permissions,
      effectivePermissions: Array.from(
        computeEffectivePermissions(updated.roles, updated.permissions),
      ),
      persona: updated.persona,
      systemPrompt: updated.systemPrompt,
      ownerUuid: updated.ownerUuid,
      lastActiveAt: updated.lastActiveAt?.toISOString() || null,
      createdAt: updated.createdAt.toISOString(),
    });
  }
);

// DELETE /api/agents/[uuid] - Delete Agent
export const DELETE = withErrorHandler<{ uuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }

    // Only users can delete Agents
    if (!isUser(auth)) {
      return errors.forbidden("Only users can delete agents");
    }

    const { uuid } = await context.params;

    const agent = await prisma.agent.findFirst({
      where: { uuid, companyUuid: auth.companyUuid },
      select: { uuid: true },
    });

    if (!agent) {
      return errors.notFound("Agent");
    }

    // Delete Agent (API Keys will be cascade-deleted)
    await prisma.agent.delete({
      where: { uuid: agent.uuid },
    });

    return success({ deleted: true });
  }
);
