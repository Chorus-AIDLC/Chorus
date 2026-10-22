// src/app/api/auth/identify/route.ts
// Email Identification API - Determine if Super Admin, default auth, or Company OIDC

import { NextRequest } from "next/server";
import { withErrorHandler, parseBody } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { isSuperAdminEmail } from "@/lib/super-admin";
import { isDefaultAuthEnabled, getDefaultUserEmail } from "@/lib/default-auth";
import { parseHost } from "@/lib/oidc-utils";
import * as companyService from "@/services/company.service";
import { IdentifyResponse, IdentifyRoleOption } from "@/types/admin";

import { prisma } from "@/lib/prisma";
import { throttleAuth } from "@/lib/auth-throttle";

interface IdentifyRequest {
  identifier?: string;
  email?: string;
}

export const POST = withErrorHandler(async (request: NextRequest) => {
  const body = await parseBody<IdentifyRequest>(request);

  const raw = body.identifier ?? body.email;
  const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  const limited = await throttleAuth(request, "identify", email);
  if (limited) return limited;
  // Preserve legacy email validation while new identifier callers receive a
  // generic unknown-identity response for malformed usernames.
  if (body.identifier === undefined && (!body.email || typeof body.email !== "string")) return errors.validationError({ email: "Email is required" });
  if (body.identifier === undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return errors.validationError({ email: "Invalid email format" });
  if (!email || email.length > 254 || /\s/.test(email)) {
    return success({ type: "not_found", message: "No organization found for this identifier" });
  }
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

  // Exhaustively collect every login path this email can take, in a stable
  // order: super_admin first, then default_auth, then one oidc entry per
  // company in the order returned by getCandidateCompaniesForEmail.
  const isSuperAdmin = isEmail && isSuperAdminEmail(email);
  const isDefaultAuth =
    isEmail && isDefaultAuthEnabled() && email === getDefaultUserEmail();
  const candidates = isEmail ? await companyService.getCandidateCompaniesForEmail(email) : [];
  const localMatches = await prisma.user.findMany({
    where: {
      authType: "local", deletedAt: null, status: { not: "deleted" },
      ...(email.includes("@") ? { localEmail: email } : { username: email }),
      company: { localAuthEnabled: true, oidcEnabled: false },
    },
    select: { company: { select: { uuid: true, name: true } } },
    orderBy: { companyUuid: "asc" },
  });

  const roles: IdentifyRoleOption[] = [];
  if (isSuperAdmin) {
    roles.push({ kind: "super_admin" });
  }
  if (isDefaultAuth) {
    roles.push({ kind: "default_auth" });
  }
  for (const c of candidates) {
    roles.push({
      kind: "oidc",
      company: {
        uuid: c.uuid,
        name: c.name,
        oidcIssuer: c.oidcIssuer,
        oidcClientId: c.oidcClientId,
      },
    });
  }

  const localCompanies = new Map(localMatches.map(({ company }) => [company.uuid, company]));
  for (const company of localCompanies.values()) roles.push({ kind: "local", company });

  // 0 roles → not_found.
  if (roles.length === 0) {
    const response: IdentifyResponse = {
      type: "not_found",
      message: "No organization found for this identifier",
    };
    return success(response);
  }

  // A single resolvable path returns its exact existing shape.
  if (roles.length === 1) {
    const only = roles[0];
    if (only.kind === "super_admin") {
      const response: IdentifyResponse = { type: "super_admin" };
      return success(response);
    }
    if (only.kind === "default_auth") {
      const response: IdentifyResponse = { type: "default_auth" };
      return success(response);
    }
    const response: IdentifyResponse = only.kind === "local"
      ? { type: "local", company: only.company }
      : { type: "oidc", company: only.company! };
    return success(response);
  }

  // 2+ oidc companies and NO super_admin/default_auth → oidc_multi_match.
  if (!isSuperAdmin && !isDefaultAuth && localCompanies.size === 0) {
    const response: IdentifyResponse = {
      type: "oidc_multi_match",
      candidates: candidates.map((c) => ({
        uuid: c.uuid,
        name: c.name,
        oidcIssuerHost: parseHost(c.oidcIssuer),
      })),
    };
    return success(response);
  }

  // super_admin and/or default_auth present alongside ≥1 other distinct path.
  //
  // Note: oidc entries here carry the full company payload (oidcIssuer +
  // oidcClientId) inline, whereas the oidc_multi_match branch above redacts to
  // oidcIssuerHost and defers the full config to /api/auth/company-oidc. This
  // divergence is intentional. oidcIssuer and oidcClientId are not secrets —
  // they are sent to the browser in every OIDC authorize redirect, and the
  // single-oidc branch already returns them inline. The multi_role OIDC case is
  // dominated by "super_admin + exactly one company", which is byte-identical to
  // the single-oidc branch; redacting it would add a fetch round-trip and a
  // type split for no real confidentiality gain. The picker reuses the same
  // inline startOidcRedirect path as the single-oidc branch.
  const response: IdentifyResponse = {
    type: "multi_role",
    roles,
  };
  return success(response);
});
