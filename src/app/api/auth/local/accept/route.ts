import { parseBody, withErrorHandler } from "@/lib/api-handler";
import { success } from "@/lib/api-response";
import { throttleAuth } from "@/lib/auth-throttle";
import { acceptLocalCredential } from "@/services/local-user.service";

// Token is supplied only in the POST body. This endpoint never creates a session.
export const POST = withErrorHandler(async request => {
  const body = await parseBody<unknown>(request);
  const token = body && typeof body === "object" && "token" in body && typeof body.token === "string" ? body.token : "invalid";
  const limited = await throttleAuth(request, "accept", token);
  if (limited) return limited;
  const response = success(await acceptLocalCredential(body));
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
});
