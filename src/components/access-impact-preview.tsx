"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface AccessRoleChange {
  userUuid: string;
  name?: string | null;
  email?: string | null;
  beforeRole: string;
  afterRole: string;
}

export interface AccessImpactSummary {
  affectedUserCount: number;
  gainedAccessCount: number;
  lostAccessCount: number;
  increasedPermissionsCount: number;
  decreasedPermissionsCount: number;
  affectedProjectCount: number;
}

interface AccessChanges {
  companyAccess?: "opened" | "closed" | "unchanged";
  fromVisibility?: string;
  visibility?: string;
  changes?: AccessRoleChange[];
}

export interface AccessImpact extends AccessChanges {
  confirmationToken: string;
  summary?: AccessImpactSummary;
  projects?: Array<AccessChanges & {
    projectUuid: string;
    name: string;
  }>;
}

const ROLE_LEVELS: Record<string, number> = { none: 0, viewer: 1, editor: 2, admin: 3 };

/** Older previews provide role changes without an aggregate summary. */
function summarizeChanges(preview: AccessImpact, kind: "project" | "group"): AccessImpactSummary {
  const affected = new Set<string>();
  const gained = new Set<string>();
  const lost = new Set<string>();
  const increased = new Set<string>();
  const decreased = new Set<string>();
  const subjects = [preview, ...(preview.projects ?? [])];
  for (const subject of subjects) {
    for (const change of subject.changes ?? []) {
      if (change.beforeRole === change.afterRole) continue;
      const before = ROLE_LEVELS[change.beforeRole];
      const after = ROLE_LEVELS[change.afterRole];
      if (before === undefined || after === undefined) continue;
      affected.add(change.userUuid);
      if (before === 0) gained.add(change.userUuid);
      else if (after === 0) lost.add(change.userUuid);
      else if (after > before) increased.add(change.userUuid);
      else decreased.add(change.userUuid);
    }
  }
  const isChanged = (subject: AccessChanges) =>
    subject.companyAccess === "opened" || subject.companyAccess === "closed"
    || (subject.fromVisibility !== undefined && subject.visibility !== undefined
      && subject.fromVisibility !== subject.visibility)
    || (subject.changes ?? []).some((change) => change.beforeRole !== change.afterRole);
  return {
    affectedUserCount: affected.size,
    gainedAccessCount: gained.size,
    lostAccessCount: lost.size,
    increasedPermissionsCount: increased.size,
    decreasedPermissionsCount: decreased.size,
    affectedProjectCount: kind === "group"
      ? new Set((preview.projects ?? []).filter(isChanged).map((project) => project.projectUuid)).size
      : Number(isChanged(preview)),
  };
}

/** Render aggregate impact while passing the original preview and token to the caller. */
export function AccessImpactPreview({
  url,
  onLoaded,
  kind = "project",
}: {
  url: string;
  onLoaded: (preview: AccessImpact | null) => void;
  kind?: "project" | "group";
}) {
  const t = useTranslations("accessImpact");
  const [preview, setPreview] = useState<AccessImpact | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setFailed(false);
    onLoaded(null);
    void (async () => {
      try {
        const response = await fetch(url);
        const body = await response.json();
        if (!response.ok || !body.success || !body.data?.confirmationToken) throw new Error();
        if (!cancelled) {
          setPreview(body.data);
          onLoaded(body.data);
        }
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => { cancelled = true; };
  }, [url, attempt, onLoaded]);

  if (failed) return (
    <div role="alert" className="space-y-2 text-sm text-destructive">
      <p>{t("loadFailed")}</p>
      <Button variant="outline" onClick={() => setAttempt((n) => n + 1)}>{t("retry")}</Button>
    </div>
  );
  if (!preview) return (
    <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />{t("loading")}
    </p>
  );
  const summary = preview.summary ?? summarizeChanges(preview, kind);
  const impacts = [
    ["gainedAccess", summary.gainedAccessCount],
    ["lostAccess", summary.lostAccessCount],
    ["increasedPermissions", summary.increasedPermissionsCount],
    ["decreasedPermissions", summary.decreasedPermissionsCount],
  ] as const;
  const categoriesOverlap = impacts.reduce((total, [, count]) => total + count, 0) > summary.affectedUserCount;
  return (
    <div data-testid="access-impact-preview" className="min-w-0 space-y-3 rounded-lg border border-border bg-muted/40 p-3 text-sm">
      <p className="font-medium">{t("title")}</p>
      {preview.companyAccess && <p>{t(`${kind === "group" ? "groupCompany" : "company"}.${preview.companyAccess}`)}</p>}
      <p>{summary.affectedUserCount === 0 ? t("noAffectedUsers") : t("affectedUsers", { count: summary.affectedUserCount })}</p>
      <div className="space-y-1 text-xs">
        {impacts.filter(([, count]) => count > 0).map(([type, count]) => (
          <p key={type}>{t(`${kind}.${type}`, { count })}</p>
        ))}
      </div>
      <p className="text-xs">{t(`${kind}.affectedProjects`, { count: summary.affectedProjectCount })}</p>
      {categoriesOverlap && <p className="text-xs text-muted-foreground">{t("overlapHint")}</p>}
      <p className="text-xs text-muted-foreground">{t("confirmationHint")}</p>
    </div>
  );
}
