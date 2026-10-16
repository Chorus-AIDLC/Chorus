import { requireSuperAdmin } from "@/lib/auth";
import { parseBody, withErrorHandler } from "@/lib/api-handler";
import { success } from "@/lib/api-response";
import { getInitialAdmin, manageInitialAdmin } from "@/services/local-user.service";

export const GET = withErrorHandler<{ uuid: string }>(requireSuperAdmin(async (_request, context, auth) => {
  const { uuid } = await context.params;
  const response = success(await getInitialAdmin(auth, uuid));
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}));

export const POST = withErrorHandler<{ uuid: string }>(requireSuperAdmin(async (request, context, auth) => {
  const { uuid } = await context.params;
  const response = success(await manageInitialAdmin(auth, uuid, await parseBody<unknown>(request)));
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}));
