"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Download, FileText, FileType, FileSpreadsheet, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { useDocumentExport } from "@/hooks/use-document-export";
import type { ExportableDocument, ExportFormat } from "@/types/export";

interface ExportDropdownBaseProps {
  variant?: "default" | "ghost" | "compact";
}

interface ExportDropdownWithDoc extends ExportDropdownBaseProps {
  document: ExportableDocument;
  documentUuid?: never;
}

interface ExportDropdownWithUuid extends ExportDropdownBaseProps {
  document?: never;
  documentUuid: string;
}

type ExportDropdownProps = ExportDropdownWithDoc | ExportDropdownWithUuid;

export function ExportDropdown({ document, documentUuid, variant = "default" }: ExportDropdownProps) {
  const t = useTranslations();
  const { exportDocument, isExporting, exportError } = useDocumentExport();
  const [activeFormat, setActiveFormat] = useState<ExportFormat | null>(null);

  async function handleExport(format: ExportFormat) {
    setActiveFormat(format);
    try {
      let doc = document;
      if (!doc && documentUuid) {
        const res = await fetch(`/api/documents/${documentUuid}`);
        const json = await res.json();
        if (!json.success || !json.data) {
          toast.error(t("export.exportError"));
          return;
        }
        const d = json.data;
        doc = {
          title: d.title,
          content: d.content ?? "",
          type: d.type,
          version: d.version,
          createdAt: d.createdAt,
          updatedAt: d.updatedAt,
          createdByName: d.createdBy?.name ?? "",
          projectName: d.project?.name ?? "",
        };
      }
      if (doc) {
        await exportDocument(doc, format);
      }
    } finally {
      setActiveFormat(null);
      if (exportError) {
        toast.error(exportError);
      }
    }
  }

  const formats: { format: ExportFormat; labelKey: string; icon: typeof FileText }[] = [
    { format: "md", labelKey: "export.formatMd", icon: FileText },
    { format: "pdf", labelKey: "export.formatPdf", icon: FileType },
    { format: "docx", labelKey: "export.formatDocx", icon: FileSpreadsheet },
  ];

  const isCompact = variant === "compact";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant={variant === "ghost" ? "ghost" : "outline"}
          size={isCompact ? "sm" : "default"}
          className={
            isCompact
              ? "h-6 text-[11px] text-muted-foreground hover:text-foreground"
              : "border-[#E5E0D8] text-[#6B6B6B] gap-1.5"
          }
          disabled={isExporting}
        >
          {isExporting ? (
            <Loader2 className={`${isCompact ? "h-3 w-3" : "h-4 w-4"} animate-spin`} />
          ) : (
            <Download className={isCompact ? "h-3 w-3" : "h-4 w-4"} />
          )}
          {!isCompact && t("export.exportDocument")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {formats.map(({ format, labelKey, icon: Icon }) => (
          <DropdownMenuItem
            key={format}
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              handleExport(format);
            }}
            disabled={isExporting}
          >
            {activeFormat === format ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Icon className="h-4 w-4" />
            )}
            {t(labelKey)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
