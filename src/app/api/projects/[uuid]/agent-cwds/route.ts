import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { withErrorHandler } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, isUser } from "@/lib/auth";
import type { UserAuthContext } from "@/types/auth";
import {
  CwdServiceError,
  clearProjectAgentCwdPreference,
  listProjectAgentCwdPreferences,
  saveProjectAgentCwdPreference,
} from "@/services/project-agent-cwd.service";

type RouteContext = { params: Promise<{ uuid: string }> };

function serviceError(error: unknown): NextResponse {
  if (!(error instanceof CwdServiceError)) {
    throw error;
  }
  if (error.code === "NOT_FOUND") return errors.notFound();
  const status = error.code === "VALIDATION_ERROR" ? 422 : error.code === "FORBIDDEN" ? 403 : 409;
  return NextResponse.json(
    { success: false, error: { code: error.code, message: error.message } },
    { status },
  );
}

async function requireUser(
  request: NextRequest,
): Promise<{ auth: UserAuthContext } | { error: NextResponse }> {
  const auth = await getAuthContext(request);
  if (!auth) return { error: errors.unauthorized() };
  if (!isUser(auth)) return { error: errors.forbidden("User session required") };
  return { auth };
}

export const GET = withErrorHandler(async (request: NextRequest, context: RouteContext) => {
  const authorized = await requireUser(request);
  if ("error" in authorized) return authorized.error;
  const { uuid } = await context.params;
  try {
    return success({
      agents: await listProjectAgentCwdPreferences(
        authorized.auth.companyUuid,
        authorized.auth.actorUuid,
        uuid,
      ),
    });
  } catch (error) {
    return serviceError(error);
  }
});

const saveSchema = z.object({
  agentUuid: z.string().min(1),
  validationRequestUuid: z.string().min(1),
});

export const PUT = withErrorHandler(async (request: NextRequest, context: RouteContext) => {
  const authorized = await requireUser(request);
  if ("error" in authorized) return authorized.error;
  const parsed = saveSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errors.validationError(parsed.error.flatten());
  const { uuid } = await context.params;
  try {
    const preference = await saveProjectAgentCwdPreference({
      companyUuid: authorized.auth.companyUuid,
      userUuid: authorized.auth.actorUuid,
      projectUuid: uuid,
      ...parsed.data,
    });
    return success({ preference });
  } catch (error) {
    return serviceError(error);
  }
});

const clearSchema = z.object({ agentUuid: z.string().min(1) });

export const DELETE = withErrorHandler(async (request: NextRequest, context: RouteContext) => {
  const authorized = await requireUser(request);
  if ("error" in authorized) return authorized.error;
  const parsed = clearSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errors.validationError(parsed.error.flatten());
  const { uuid } = await context.params;
  try {
    await clearProjectAgentCwdPreference({
      companyUuid: authorized.auth.companyUuid,
      userUuid: authorized.auth.actorUuid,
      projectUuid: uuid,
      agentUuid: parsed.data.agentUuid,
    });
    return success({ cleared: true });
  } catch (error) {
    return serviceError(error);
  }
});
