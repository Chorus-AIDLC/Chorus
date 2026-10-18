import { NextRequest } from "next/server";
import { z } from "zod";
import { getAuthContext, isUser } from "@/lib/auth";
import { withErrorHandler } from "@/lib/api-handler";
import { errors, success } from "@/lib/api-response";
import { updateUserAvatar } from "@/services/user-avatar.service";

const avatarInput = z.object({ avatarSeed: z.string().uuid() }).strict();

export const PATCH = withErrorHandler(async (request: NextRequest) => {
  const auth = await getAuthContext(request);
  if (!auth) return errors.unauthorized();
  if (!isUser(auth)) return errors.forbidden("Only users can update their avatar");

  const trustedOrigin = new URL(process.env.NEXTAUTH_URL || request.nextUrl.origin).origin;
  if (request.headers.get("origin") !== trustedOrigin) {
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
