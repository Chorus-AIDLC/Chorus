import { requireAuth } from "@/lib/auth";
import { parseBody, withErrorHandler } from "@/lib/api-handler";
import { success } from "@/lib/api-response";
import { issueLocalUserCredential } from "@/services/local-user.service";

export const POST = withErrorHandler<{ uuid: string }>(requireAuth(async (request, context, auth) => {
  const { uuid } = await context.params;
  const response = success(await issueLocalUserCredential(auth, uuid, await parseBody<unknown>(request)));
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}));
