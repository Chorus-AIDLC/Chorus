"use client";

import { useOptionalAuth } from "@/contexts/auth-context";
import { UserAvatar, type UserAvatarProps } from "@/components/ui/user-avatar";

export function UserIdentityAvatar(props: UserAvatarProps) {
  const auth = useOptionalAuth();
  const currentUser = auth?.user && auth.user.uuid === props.userUuid ? auth.user : null;
  return <UserAvatar {...props} name={currentUser?.name ?? props.name} avatarSeed={currentUser?.avatarSeed ?? props.avatarSeed} />;
}
