// src/app/api/auth/check-default/route.ts
// Check if default auth is enabled

import { NextRequest } from "next/server";
import { withErrorHandler } from "@/lib/api-handler";
import { success } from "@/lib/api-response";
import { isDefaultAuthEnabled, getDefaultUserEmail } from "@/lib/default-auth";
import { isSuperAdminEmail } from "@/lib/super-admin";

export const GET = withErrorHandler(async (_request: NextRequest) => {
  const enabled = isDefaultAuthEnabled();

  // True iff default auth is enabled AND the default user email is also the
  // Super Admin email (case-insensitive, handled by isSuperAdminEmail). The
  // email itself is never echoed back to the client.
  const defaultEmail = getDefaultUserEmail();
  const superAdminCollision =
    enabled && defaultEmail != null && isSuperAdminEmail(defaultEmail);

  return success({ enabled, superAdminCollision });
});
