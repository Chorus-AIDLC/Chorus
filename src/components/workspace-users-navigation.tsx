"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Users } from "lucide-react";
import { authFetch } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";

interface WorkspaceIdentity {
  user?: { authType?: string; workspaceAdmin?: boolean };
  company?: { localAuthEnabled?: boolean };
}

export function canManageWorkspaceUsers(identity: WorkspaceIdentity | null): boolean {
  return identity?.user?.authType === "local" && identity.user.workspaceAdmin === true &&
    identity.company?.localAuthEnabled === true;
}

// Read the current database-backed projection, not navigation hints or JWT roles.
export function useWorkspaceUsersAccess() {
  const [access, setAccess] = useState<"loading" | "allowed" | "denied" | "error">("loading");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setAccess("loading");
    void authFetch("/api/auth/me", { cache: "no-store" }).then(async (response) => {
      if (response.status === 401 || response.status === 403) {
        if (!cancelled) setAccess("denied");
        return;
      }
      if (!response.ok) throw new Error();
      const result = await response.json();
      if (!result.success) throw new Error();
      if (!cancelled) setAccess(canManageWorkspaceUsers(result.data) ? "allowed" : "denied");
    }).catch(() => { if (!cancelled) setAccess("error"); });
    return () => { cancelled = true; };
  }, [attempt]);
  return { access, retry: () => setAttempt((value) => value + 1) };
}

export function WorkspaceUsersNavigation({ pathname, mobile = false }: { pathname: string; mobile?: boolean }) {
  const t = useTranslations("workspaceUsers");
  const { access } = useWorkspaceUsersAccess();
  if (access !== "allowed") return null;
  const active = pathname === "/settings/users" || pathname.startsWith("/settings/users/");
  return (
    <Button asChild variant="ghost" size="sm" className={`w-full justify-start gap-2.5 ${mobile ? "h-10 text-[15px]" : "text-[13px]"} ${active ? "bg-secondary font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
      <Link href="/settings/users" aria-current={active ? "page" : undefined}>
        <Users className={`${mobile ? "h-5 w-5" : "h-4 w-4"} ${active ? "text-primary" : ""}`} />
        {t("title")}
      </Link>
    </Button>
  );
}
