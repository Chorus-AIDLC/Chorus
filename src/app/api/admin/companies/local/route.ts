import { requireSuperAdmin } from "@/lib/auth";
import { parseBody, withErrorHandler } from "@/lib/api-handler";
import { success } from "@/lib/api-response";
import { bootstrapLocalCompany } from "@/services/local-user.service";

export const POST = withErrorHandler(requireSuperAdmin(async (request, _context, auth) => {
  const result = await bootstrapLocalCompany(auth, await parseBody<unknown>(request));
  const response = success(result);
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}));
