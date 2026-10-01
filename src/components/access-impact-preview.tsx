"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface AccessRoleChange {
  userUuid: string;
  beforeRole: string;
  afterRole: string;
}

export interface AccessImpact {
  confirmationToken: string;
  companyAccess?: "opened" | "closed" | "unchanged";
  changes?: AccessRoleChange[];
  projects?: Array<{
    projectUuid: string;
    name: string;
    companyAccess?: "opened" | "closed" | "unchanged";
    changes?: AccessRoleChange[];
  }>;
}

/** Render the server's current diff and expose its token only after loading. */
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
  const renderChanges = (changes: AccessRoleChange[] = []) => (
    <ul className="space-y-1">
      {changes.map((change) => (
        <li key={change.userUuid} className="break-all text-xs">
          {change.userUuid}: {t(`roles.${change.beforeRole}`)} → {t(`roles.${change.afterRole}`)}
        </li>
      ))}
    </ul>
  );
  return (
    <div data-testid="access-impact-preview" className="min-w-0 space-y-3 rounded-lg border border-border bg-muted/40 p-3 text-sm">
      <p className="font-medium">{t("title")}</p>
      {preview.companyAccess && <p>{t(`${kind === "group" ? "groupCompany" : "company"}.${preview.companyAccess}`)}</p>}
      {renderChanges(preview.changes)}
      {preview.projects?.map((project) => (
        <div key={project.projectUuid} className="min-w-0 space-y-1">
          <p className="break-words font-medium">{project.name}</p>
          {project.companyAccess && <p className="text-xs">{t(`company.${project.companyAccess}`)}</p>}
          {renderChanges(project.changes)}
        </div>
      ))}
      <p className="text-xs text-muted-foreground">{t("confirmationHint")}</p>
    </div>
  );
}
