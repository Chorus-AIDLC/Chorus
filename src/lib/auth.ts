// src/lib/auth.ts
// Authentication middleware and utility functions (ARCHITECTURE.md §6)
// UUID-Based Architecture: All IDs are UUIDs

import { NextRequest, NextResponse } from "next/server";
import { extractApiKey, validateApiKey } from "./api-key";
import { errors } from "./api-response";
import type {
  AuthContext,
  AgentAuthContext,
  UserAuthContext,
  SuperAdminAuthContext,
  AgentRole,
} from "@/types/auth";
import type { Permission } from "@/lib/authz/types";
import { computeEffectivePermissions } from "@/lib/authz/permissions";
import { getSuperAdminFromRequest } from "./super-admin";
import { getUserSessionFromRequest } from "./user-session";
import { verifyOidcAccessToken, isOidcToken } from "./oidc-auth";

// Get auth context from request (UUID-based)
export async function getAuthContext(
  request: NextRequest
): Promise<AuthContext | null> {
  const authHeader = request.headers.get("authorization");

  // 1. Try Bearer Token authentication
  if (authHeader?.toLowerCase().startsWith("bearer ")) {
    const token = authHeader.substring(7).trim();

    // 1a. API Key authentication (Agent) - API Key starts with "cho_"
    if (token.startsWith("cho_")) {
      const result = await validateApiKey(token);
      if (result.valid && result.agent) {
        const effective = computeEffectivePermissions(
          result.agent.roles,
          result.agent.permissions,
        );
        const agentContext: AgentAuthContext = {
          type: "agent",
          companyUuid: result.agent.companyUuid,
          actorUuid: result.agent.uuid,
          roles: result.agent.roles as AgentRole[],
          permissions: Array.from(effective),
          ownerUuid: result.agent.ownerUuid ?? undefined,
          agentName: result.agent.name,
        };
        return agentContext;
      }
    }

    // 1b. OIDC Access Token authentication (regular user)
    if (isOidcToken(token)) {
      const userContext = await verifyOidcAccessToken(token);
      if (userContext) {
        return userContext;
      }
    }

    // 1c. Chorus JWT Token authentication (SuperAdmin or legacy compatibility)
    const userSession = await getUserSessionFromRequest(request);
    if (userSession) {
      return userSession;
    }
  }

  // 2. Try Session Cookie authentication -- when no Authorization header
  const userSession = await getUserSessionFromRequest(request);
  if (userSession) {
    return userSession;
  }

  // 3. Try OIDC Access Token Cookie authentication (for scenarios like EventSource that cannot send Authorization headers)
  const oidcCookieToken = request.cookies.get("oidc_access_token")?.value;
  if (oidcCookieToken && isOidcToken(oidcCookieToken)) {
    const oidcContext = await verifyOidcAccessToken(oidcCookieToken);
    if (oidcContext) {
      return oidcContext;
    }
  }

  return null;
}

// Check if context is Agent
export function isAgent(ctx: AuthContext): ctx is AgentAuthContext {
  return ctx.type === "agent";
}

// Check if context is User
export function isUser(ctx: AuthContext): ctx is UserAuthContext {
  return ctx.type === "user";
}

// Check if Agent has a specific role
export function hasRole(ctx: AuthContext, role: AgentRole): boolean {
  if (!isAgent(ctx)) return false;
  return ctx.roles.includes(role);
}

// Check if PM Agent
export function isPmAgent(ctx: AuthContext): boolean {
  return hasRole(ctx, "pm");
}

// Check if Developer Agent
export function isDeveloperAgent(ctx: AuthContext): boolean {
  return hasRole(ctx, "developer");
}

// Require authentication decorator factory
export function requireAuth<T>(
  handler: (
    request: NextRequest,
    context: { params: Promise<T> },
    auth: AuthContext
  ) => Promise<NextResponse>
) {
  return async (
    request: NextRequest,
    context: { params: Promise<T> }
  ): Promise<NextResponse> => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }
    return handler(request, context, auth);
  };
}

// Require user authentication
export function requireUser<T>(
  handler: (
    request: NextRequest,
    context: { params: Promise<T> },
    auth: UserAuthContext
  ) => Promise<NextResponse>
) {
  return async (
    request: NextRequest,
    context: { params: Promise<T> }
  ): Promise<NextResponse> => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }
    if (!isUser(auth)) {
      return errors.forbidden("This operation requires user authentication");
    }
    return handler(request, context, auth);
  };
}

// Require specific Agent role
export function requireAgentRole<T>(
  role: AgentRole,
  handler: (
    request: NextRequest,
    context: { params: Promise<T> },
    auth: AgentAuthContext
  ) => Promise<NextResponse>
) {
  return async (
    request: NextRequest,
    context: { params: Promise<T> }
  ): Promise<NextResponse> => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }
    if (!isAgent(auth)) {
      return errors.forbidden("This operation requires agent authentication");
    }
    if (!hasRole(auth, role)) {
      return errors.forbidden(`This operation requires ${role} role`);
    }
    return handler(request, context, auth);
  };
}

// Check if an auth context holds a specific permission.
// SuperAdmin always passes; agents delegate to the precomputed effective permission set.
export function hasPermission(
  ctx: AgentAuthContext | SuperAdminAuthContext,
  permission: Permission,
): boolean {
  if (ctx.type === "super_admin") return true;
  return ctx.permissions.includes(permission);
}

// Gate an agent request by permission, passing users and super_admins through unchanged.
// For routes that serve both humans and agents: humans keep their existing access,
// agents must carry the required permission bit (super_admin bypasses).
// Returns null when the request is allowed; returns a 403 response when the agent lacks the permission.
export function checkAgentPermission(
  ctx: AuthContext | SuperAdminAuthContext,
  permission: Permission,
): NextResponse | null {
  if (ctx.type === "agent" && !hasPermission(ctx as AgentAuthContext, permission)) {
    return errors.forbidden(`Missing permission: ${permission}`);
  }
  return null;
}

// Require a specific fine-grained permission on the Agent/SuperAdmin context.
// Matches the shape of requireAgentRole / requireSuperAdmin. super_admin bypasses.
// Returns 401 when unauthenticated, 403 when the agent lacks the permission.
export function requireAgentPermission<T>(
  permission: Permission,
  handler: (
    request: NextRequest,
    context: { params: Promise<T> },
    auth: AgentAuthContext | SuperAdminAuthContext,
  ) => Promise<NextResponse>,
) {
  return async (
    request: NextRequest,
    context: { params: Promise<T> },
  ): Promise<NextResponse> => {
    const superAdmin = await getSuperAdminFromRequest(request);
    if (superAdmin) {
      return handler(request, context, superAdmin);
    }
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }
    if (!isAgent(auth)) {
      return errors.forbidden("This operation requires agent authentication");
    }
    if (!hasPermission(auth, permission)) {
      return errors.forbidden(`Missing permission: ${permission}`);
    }
    return handler(request, context, auth);
  };
}

// Check if context is the assignee of a resource (UUID-based)
export function isAssignee(
  ctx: AuthContext,
  assigneeType: string | null,
  assigneeUuid: string | null
): boolean {
  if (!assigneeType || !assigneeUuid) return false;

  if (isUser(ctx)) {
    // Direct user match
    if (assigneeType === "user" && assigneeUuid === ctx.actorUuid) {
      return true;
    }
  }

  if (isAgent(ctx)) {
    // Direct Agent match
    if (assigneeType === "agent" && assigneeUuid === ctx.actorUuid) {
      return true;
    }
    // Agent's Owner claim ("Assign to myself")
    if (
      assigneeType === "user" &&
      ctx.ownerUuid &&
      assigneeUuid === ctx.ownerUuid
    ) {
      return true;
    }
  }

  return false;
}

// Check if Super Admin
export function isSuperAdmin(
  ctx: AuthContext | SuperAdminAuthContext
): ctx is SuperAdminAuthContext {
  return ctx.type === "super_admin";
}

// Require Super Admin authentication
export function requireSuperAdmin<T>(
  handler: (
    request: NextRequest,
    context: { params: Promise<T> },
    auth: SuperAdminAuthContext
  ) => Promise<NextResponse>
) {
  return async (
    request: NextRequest,
    context: { params: Promise<T> }
  ): Promise<NextResponse> => {
    const auth = await getSuperAdminFromRequest(request);
    if (!auth) {
      return errors.unauthorized("Super Admin authentication required");
    }
    return handler(request, context, auth);
  };
}
