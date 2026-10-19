"use client";

import { useOptionalAuth } from "@/contexts/auth-context";

export function UserIdentityName({ userUuid, name }: { userUuid?: string; name?: string }) {
  const auth = useOptionalAuth();
  const currentUser = auth?.user && auth.user.uuid === userUuid ? auth.user : null;
  return <>{currentUser?.name || name}</>;
}
