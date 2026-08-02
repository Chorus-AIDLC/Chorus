import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { withErrorHandler } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext } from "@/lib/auth";
import {
  CwdServiceError,
  DIRECTORY_ERROR_CODES,
  completeDirectoryRequest,
} from "@/services/project-agent-cwd.service";

const schema = z.discriminatedUnion("status", [
  z.object({
    requestUuid: z.string().min(1),
    connectionUuid: z.string().min(1),
    status: z.literal("succeeded"),
    items: z.array(z.object({ name: z.string(), path: z.string() })).optional(),
    nextCursor: z.string().nullable().optional(),
    normalizedPath: z.string().optional(),
  }),
  z.object({
    requestUuid: z.string().min(1),
    connectionUuid: z.string().min(1),
    status: z.literal("failed"),
    errorCode: z.enum(DIRECTORY_ERROR_CODES),
  }),
]);

export const POST = withErrorHandler(async (request: NextRequest) => {
  const auth = await getAuthContext(request);
  if (!auth) return errors.unauthorized();
  if (auth.type !== "agent") return errors.forbidden("Agent API key required");
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errors.validationError(parsed.error.flatten());

  const body = parsed.data;
  try {
    const directoryRequest = await completeDirectoryRequest({
      companyUuid: auth.companyUuid,
      agentUuid: auth.actorUuid,
      connectionUuid: body.connectionUuid,
      requestUuid: body.requestUuid,
      ...(body.status === "succeeded"
        ? {
            status: "success" as const,
            result: {
              items: body.items ?? [],
              nextCursor: body.nextCursor ?? null,
              normalizedPath: body.normalizedPath,
            },
          }
        : { status: "error" as const, errorCode: body.errorCode }),
    });
    return success({ request: directoryRequest });
  } catch (error) {
    if (!(error instanceof CwdServiceError)) throw error;
    return NextResponse.json(
      { success: false, error: { code: error.code, message: error.message } },
      { status: error.code === "NOT_FOUND" ? 404 : error.code === "VALIDATION_ERROR" ? 422 : 409 },
    );
  }
});
