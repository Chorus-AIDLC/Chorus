import { NextRequest, NextResponse } from "next/server";
import { withErrorHandler } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext } from "@/lib/auth";
import {
  CwdServiceError,
  getDirectoryRequest,
} from "@/services/project-agent-cwd.service";

type RouteContext = { params: Promise<{ uuid: string }> };

export const GET = withErrorHandler(async (request: NextRequest, context: RouteContext) => {
  const auth = await getAuthContext(request);
  if (!auth) return errors.unauthorized();
  if (auth.type !== "user") return errors.forbidden("User session required");
  const { uuid } = await context.params;
  try {
    return success({ request: await getDirectoryRequest(auth.companyUuid, auth.actorUuid, uuid) });
  } catch (error) {
    if (!(error instanceof CwdServiceError)) throw error;
    return NextResponse.json(
      { success: false, error: { code: error.code, message: error.message } },
      { status: error.code === "NOT_FOUND" ? 404 : 409 },
    );
  }
});
