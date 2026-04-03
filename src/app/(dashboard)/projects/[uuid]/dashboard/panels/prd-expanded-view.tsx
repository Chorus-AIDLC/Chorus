"use client";

import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { Loader2, FileText, ChevronDown, ChevronRight, AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { TaskDag } from "@/components/task-dag";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import { getPrdExpandedViewDataAction, type PrdExpandedViewData } from "./actions";

const docTypeI18nKeys: Record<string, string> = {
  prd: "documents.typePrd",
  spec: "documents.typeSpec",
  design: "documents.typeDesign",
  note: "documents.typeNote",
  other: "documents.typeOther",
};

interface PrdExpandedViewProps {
  ideaUuid: string;
  projectUuid: string;
}

export function PrdExpandedView({ ideaUuid, projectUuid }: PrdExpandedViewProps) {
  const t = useTranslations();
  const [data, setData] = useState<PrdExpandedViewData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedDocs, setExpandedDocs] = useState<Set<string>>(new Set());

  useEffect(() => {
    async function load() {
      setIsLoading(true);
      setError(null);
      const result = await getPrdExpandedViewDataAction(ideaUuid, projectUuid);
      if (result.success && result.data) {
        setData(result.data);
        // Auto-expand the first document
        if (result.data.documents.length > 0) {
          setExpandedDocs(new Set([result.data.documents[0].uuid]));
        }
      } else {
        setError(result.error || t("common.genericError"));
      }
      setIsLoading(false);
    }
    load();
  }, [ideaUuid, projectUuid, t]);

  const toggleDoc = (uuid: string) => {
    setExpandedDocs((prev) => {
      const next = new Set(prev);
      if (next.has(uuid)) {
        next.delete(uuid);
      } else {
        next.add(uuid);
      }
      return next;
    });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-[#9A9A9A]" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="flex items-center gap-2 text-sm text-red-600">
          <AlertTriangle className="h-4 w-4" />
          <span>{error}</span>
        </div>
      </div>
    );
  }

  if (!data || (data.documents.length === 0 && data.tasks.length === 0)) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <FileText className="h-8 w-8 text-[#E5E0D8] mb-3" />
        <p className="text-sm text-[#9A9A9A]">{t("panel.prdExpanded.noDocuments")}</p>
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="space-y-5 p-1">
        {/* Documents Section */}
        {data.documents.length > 0 && (
          <div>
            <span className="text-[11px] font-medium uppercase tracking-wide text-[#9A9A9A]">
              {t("panel.prdExpanded.documents")}
            </span>
            <div className="mt-2 space-y-2">
              {data.documents.map((doc) => (
                <Collapsible
                  key={doc.uuid}
                  open={expandedDocs.has(doc.uuid)}
                  onOpenChange={() => toggleDoc(doc.uuid)}
                >
                  <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-lg bg-[#FAF8F4] px-3 py-2.5 hover:bg-[#F0EDE5] transition-colors text-left">
                    {expandedDocs.has(doc.uuid) ? (
                      <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[#6B6B6B]" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[#6B6B6B]" />
                    )}
                    <FileText className="h-3.5 w-3.5 shrink-0 text-[#C67A52]" />
                    <span className="text-xs font-medium text-[#2C2C2C] truncate flex-1">
                      {doc.title}
                    </span>
                    <Badge variant="outline" className="text-[9px] shrink-0">
                      {t(docTypeI18nKeys[doc.type] || doc.type)}
                    </Badge>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="mt-1 rounded-lg border border-[#E5E0D8] bg-white px-4 py-3">
                      {doc.content ? (
                        <div className="prose prose-sm max-w-none text-[13px] leading-relaxed text-[#2C2C2C]">
                          <Streamdown plugins={{ code }}>{doc.content}</Streamdown>
                        </div>
                      ) : (
                        <p className="text-xs text-[#9A9A9A] italic">
                          {t("common.noContent")}
                        </p>
                      )}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              ))}
            </div>
          </div>
        )}

        {/* Task DAG Section */}
        {data.tasks.length > 0 && (
          <div>
            <span className="text-[11px] font-medium uppercase tracking-wide text-[#9A9A9A]">
              {t("panel.prdExpanded.taskDag")}
            </span>
            <div className="mt-2">
              <TaskDag
                tasks={data.tasks}
                edges={data.edges}
                readonly
                height={220}
              />
            </div>
          </div>
        )}
      </div>
    </ScrollArea>
  );
}
