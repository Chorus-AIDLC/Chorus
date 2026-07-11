"use client";

import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { FileText } from "lucide-react";
import { useTranslations } from "next-intl";
import { PresenceIndicator } from "@/components/ui/presence-indicator";
import { ExportDropdown } from "@/components/export-dropdown";
import { formatDateTime } from "@/lib/format-date";
import { docTypeConfig } from "./doc-type-config";

interface DocumentGridProps {
  documents: Array<{
    uuid: string;
    title: string;
    type: string;
    version: number;
    updatedAt: string | Date;
  }>;
  projectUuid: string;
}

export function DocumentGrid({ documents, projectUuid }: DocumentGridProps) {
  const t = useTranslations();

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {documents.map((doc) => {
        const typeConf = docTypeConfig[doc.type];
        const Icon = typeConf?.icon || FileText;
        return (
          <PresenceIndicator key={doc.uuid} entityType="document" entityUuid={doc.uuid}>
            <Card className="group relative flex flex-col border-border transition-all hover:border-primary hover:shadow-md">
              <Link
                href={`/projects/${projectUuid}/documents/${doc.uuid}`}
                className="flex flex-1 flex-col p-5 pb-0"
              >
                <div className="mb-3 flex items-start gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-secondary">
                    <Icon className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="font-medium text-foreground leading-snug group-hover:text-primary line-clamp-2">
                      {doc.title}
                    </h3>
                    <div className="mt-1 flex items-center gap-2 text-xs text-[#9A9A9A]">
                      <span>v{doc.version}</span>
                      <span>·</span>
                      <span>{t("documents.updated", { date: formatDateTime(doc.updatedAt) })}</span>
                    </div>
                  </div>
                </div>
              </Link>
              <div className="flex items-center justify-between border-t border-secondary px-5 py-2.5">
                <Badge className={`text-[11px] ${typeConf?.color || ""}`}>
                  {t(typeConf?.labelKey || "documents.typeOther")}
                </Badge>
                <div
                  onClick={(e) => e.stopPropagation()}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <ExportDropdown documentUuid={doc.uuid} variant="compact" />
                </div>
              </div>
            </Card>
          </PresenceIndicator>
        );
      })}
    </div>
  );
}
