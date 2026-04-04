"use client";

import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { FileText } from "lucide-react";
import { useTranslations } from "next-intl";
import { PresenceIndicator } from "@/components/ui/presence-indicator";
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
      {documents.map((doc) => (
        <Link key={doc.uuid} href={`/projects/${projectUuid}/documents/${doc.uuid}`}>
          <PresenceIndicator entityType="document" entityUuid={doc.uuid}>
            <Card className="group cursor-pointer border-[#E5E0D8] p-5 transition-all hover:border-[#C67A52] hover:shadow-md">
              <div className="mb-3 flex items-start justify-between">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#F5F2EC]">
                  {(() => { const Icon = docTypeConfig[doc.type]?.icon || FileText; return <Icon className="h-5 w-5 text-[#6B6B6B]" />; })()}
                </div>
                <Badge className={docTypeConfig[doc.type]?.color || ""}>
                  {t(docTypeConfig[doc.type]?.labelKey || "documents.typeOther")}
                </Badge>
              </div>
              <h3 className="mb-1 font-medium text-[#2C2C2C] group-hover:text-[#C67A52]">{doc.title}</h3>
              <div className="flex items-center gap-3 text-xs text-[#9A9A9A]">
                <span>v{doc.version}</span>
                <span>·</span>
                <span>{t("documents.updated", { date: new Date(doc.updatedAt).toLocaleDateString() })}</span>
              </div>
            </Card>
          </PresenceIndicator>
        </Link>
      ))}
    </div>
  );
}
