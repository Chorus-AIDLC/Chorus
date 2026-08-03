"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { FolderLock, Settings } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ResolvedProjectAgentCwdTarget } from "@/services/project-agent-cwd.service";

interface FixedCwdAnchorProps {
  target: ResolvedProjectAgentCwdTarget;
}

export function FixedCwdAnchor({ target }: FixedCwdAnchorProps) {
  const t = useTranslations("fixedCwdAnchor");
  const params = useParams<{ uuid: string }>();

  return (
    <div
      role="region"
      aria-label={t("title")}
      className="space-y-2 rounded-lg border border-border bg-background p-3"
    >
      <div className="flex items-center gap-2 text-xs font-medium text-foreground">
        <FolderLock className="h-4 w-4 text-primary" aria-hidden />
        {t("title")}
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[11px]">
        <dt className="text-muted-foreground">{t("host")}</dt>
        <dd className="truncate font-mono text-foreground">{target.host ?? t("unknown")}</dd>
        <dt className="text-muted-foreground">{t("cwd")}</dt>
        <dd className="break-all font-mono text-foreground">{target.cwd ?? t("unknown")}</dd>
        <dt className="text-muted-foreground">{t("status")}</dt>
        <dd className="text-foreground">{t(`availability.${target.availability}`)}</dd>
      </dl>
      <Link
        href={`/projects/${params.uuid}/dashboard?settings=agent-cwds`}
        className="inline-flex items-center gap-1.5 text-[11px] font-medium text-primary hover:underline"
      >
        <Settings className="h-3.5 w-3.5" aria-hidden />
        {t("manage")}
      </Link>
    </div>
  );
}
