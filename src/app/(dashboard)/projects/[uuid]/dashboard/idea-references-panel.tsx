"use client";

// Read-only references content for an idea-tracker row (Thread B). Purely
// presentational: IdeaCard (which hosts the Collapsible and stays mounted
// across toggles) owns the lazy fetch and passes the result down. Rendered
// inside a <CollapsibleContent> below the row, it shows each reference
// READ-ONLY (type badge + title-as-external-link + notes). No add/edit/delete
// here — that CRUD lives on the idea detail panel's ReferencesSection.
//
// Dark-mode: type badges reuse the shared hue-matched palette (light + dark);
// all other surfaces use semantic tokens, so it reads correctly in BOTH themes.

import { useTranslations } from "next-intl";
import { Link as LinkIcon, ExternalLink, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  referenceTypeConfig as typeConfig,
  isKnownReferenceType as isKnownType,
} from "@/components/reference-type-config";
import type { ReferenceArtifactResponse } from "@/services/reference-artifact.service";

interface IdeaReferencesContentProps {
  references: ReferenceArtifactResponse[];
  isLoading: boolean;
}

export function IdeaReferencesContent({
  references,
  isLoading,
}: IdeaReferencesContentProps) {
  const t = useTranslations();

  return (
    <div className="space-y-2">
      {isLoading ? (
        <p className="flex items-center gap-1.5 text-xs italic text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t("references.loading")}
        </p>
      ) : references.length === 0 ? (
        <p className="text-xs italic text-muted-foreground">
          {t("references.empty")}
        </p>
      ) : (
        references.map((ref) => {
          const cfg = isKnownType(ref.type) ? typeConfig[ref.type] : null;
          const TypeIcon = cfg?.icon ?? LinkIcon;
          return (
            <div
              key={ref.uuid}
              className="rounded-lg border border-border bg-background p-2.5"
            >
              <div className="mb-1 flex items-center gap-2">
                <Badge
                  className={`gap-1 border-0 text-[10px] font-medium ${
                    cfg?.badgeClass ?? "bg-secondary text-muted-foreground"
                  }`}
                >
                  <TypeIcon className="h-3 w-3" />
                  {cfg ? t(cfg.labelKey) : ref.type}
                </Badge>
              </div>
              <a
                href={ref.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
              >
                <span className="truncate">{ref.title}</span>
                <ExternalLink className="h-3 w-3 shrink-0" />
              </a>
              {ref.notes && (
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {ref.notes}
                </p>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
