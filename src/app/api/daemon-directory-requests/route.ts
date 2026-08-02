import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { withErrorHandler } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext } from "@/lib/auth";
import {
  CwdServiceError,
  createDirectoryRequest,
} from "@/services/project-agent-cwd.service";

const schema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("list"),
    agentUuid: z.string().min(1),
    targetConnectionUuid: z.string().min(1),
    prefix: z.string().min(1),
    cursor: z.string().optional(),
    limit: z.number().int().positive().max(100).optional(),
  }),
  z.object({
    operation: z.literal("validate"),
    agentUuid: z.string().min(1),
    targetConnectionUuid: z.string().min(1),
    cwd: z.string().min(1),
  }),
]);

export const POST = withErrorHandler(async (request: NextRequest) => {
  const auth = await getAuthContext(request);
  if (!auth) return errors.unauthorized();
  if (auth.type !== "user") return errors.forbidden("User session required");
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errors.validationError(parsed.error.flatten());
  try {
    const directoryRequest = await createDirectoryRequest({
      companyUuid: auth.companyUuid,
      userUuid: auth.actorUuid,
      ...parsed.data,
    });
    return success({ request: directoryRequest });
  } catch (error) {
    if (!(error instanceof CwdServiceError)) throw error;
    const status = error.code === "NOT_FOUND" ? 404 : error.code === "VALIDATION_ERROR" ? 422 : 409;
    return NextResponse.json(
      { success: false, error: { code: error.code, message: error.message } },
      { status },
    );
  }
});
