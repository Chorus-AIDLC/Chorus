import { NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandler, parseBody } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { throttleAuth } from "@/lib/auth-throttle";
import { getCookieOptions } from "@/lib/cookie-utils";
import { createUserAccessToken, ACCESS_TOKEN_MAX_AGE } from "@/lib/user-session";
import { verifyLocalLoginCredentials } from "@/services/local-user.service";

const schema = z.object({ companyUuid: z.string().uuid(), identifier: z.string().min(1).max(254), password: z.string().max(256) }).strict();

export const POST = withErrorHandler(async (request: NextRequest) => {
  const body = await parseBody<unknown>(request);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return errors.unauthorized("Invalid credentials");
  const limited = throttleAuth(request, "login", `${parsed.data.companyUuid}:${parsed.data.identifier.trim().toLowerCase()}`);
  if (limited) return limited;
  const account = await verifyLocalLoginCredentials(parsed.data.companyUuid, parsed.data.identifier, parsed.data.password);
  if (!account) return errors.unauthorized("Invalid credentials");
  const token = await createUserAccessToken({ type: "user", userUuid: account.uuid, companyUuid: account.companyUuid, email: account.email, name: account.name ?? undefined, oidcSub: `local_${account.uuid}`, authType: "local", sessionVersion: account.sessionVersion });
  const response = success({ user: { uuid: account.uuid, companyUuid: account.companyUuid, email: account.email, name: account.name, workspaceAdmin: account.workspaceAdmin } });
  response.cookies.set("user_session", token, getCookieOptions(ACCESS_TOKEN_MAX_AGE));
  // Do not let stale SSO cookies win over the explicitly selected local account.
  for (const name of ["oidc_access_token", "oidc_refresh_token", "oidc_client_id", "oidc_issuer"]) response.cookies.set(name, "", getCookieOptions(0));
  return response;
});
