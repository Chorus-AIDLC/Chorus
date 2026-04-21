"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { ExportDropdown } from "@/components/export-dropdown";
import type { ExportableDocument } from "@/types/export";

interface DocumentActionsProps {
  documentUuid: string;
  projectUuid: string;
  exportDoc?: ExportableDocument;
}

export function DocumentActions({ documentUuid, exportDoc }: DocumentActionsProps) {
  const t = useTranslations();
  const router = useRouter();

  return (
    <div className="flex gap-2">
      {exportDoc ? (
        <ExportDropdown document={exportDoc} />
      ) : (
        <ExportDropdown documentUuid={documentUuid} />
      )}
      <Button
        variant="outline"
        className="border-[#E5E0D8] text-[#6B6B6B]"
        onClick={() => router.back()}
      >
        {t("common.back")}
      </Button>
    </div>
  );
}
