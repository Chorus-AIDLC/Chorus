import { NextRequest } from "next/server";
import { z } from "zod";
import { getAuthContext, isUser } from "@/lib/auth";
import { withErrorHandler } from "@/lib/api-handler";
import { errors, success } from "@/lib/api-response";
import { updateUserAvatar } from "@/services/user-avatar.service";

const avatarInput = z.object({ avatarSeed: z.string().uuid() }).strict();

function requestOrigin(request: NextRequest): string | null {
  const host = request.headers.get("host");
  if (host === null) return request.nextUrl.origin;
  try {
    const url = new URL(`${request.nextUrl.protocol}//${host}`);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export const PATCH = withErrorHandler(async (request: NextRequest) => {
  const auth = await getAuthContext(request);
  if (!auth) return errors.unauthorized();
  if (!isUser(auth)) return errors.forbidden("Only users can update their avatar");

  const configuredOrigin = process.env.NEXTAUTH_URL ? new URL(process.env.NEXTAUTH_URL).origin : null;
  const origin = request.headers.get("origin");
  if (!origin || (origin !== configuredOrigin && origin !== requestOrigin(request))) {
    return errors.forbidden("A trusted Origin is required");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errors.badRequest("Invalid JSON");
  }
  const input = avatarInput.safeParse(body);
  if (!input.success) return errors.badRequest("Expected only a valid avatarSeed UUID");

  const user = await updateUserAvatar(auth, input.data.avatarSeed);
  return success({ user });
});
