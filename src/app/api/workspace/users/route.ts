import { requireAuth } from "@/lib/auth";
import { parseBody, withErrorHandler } from "@/lib/api-handler";
import { paginated, success } from "@/lib/api-response";
import { createLocalUser, listLocalUsers } from "@/services/local-user.service";

export const GET = withErrorHandler(requireAuth(async (request, _context, auth) => {
  const query = new URL(request.url).searchParams;
  const page = Number(query.get("page") ?? 1);
  const pageSize = Number(query.get("pageSize") ?? 20);
  const { users, total } = await listLocalUsers(auth, page, pageSize);
  const response = paginated(users, page, pageSize, total);
  response.headers.set("Cache-Control", "no-store");
  return response;
}));
export const POST = withErrorHandler(requireAuth(async (request, _context, auth) => {
  const result = await createLocalUser(auth, await parseBody<unknown>(request));
  const response = success(result);
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}));
