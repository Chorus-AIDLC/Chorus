"use client";

// Placeholder client component for /projects/[uuid]/graph.
// Renders the page shell + a localized empty-state. The real force-directed
// knowledge-graph canvas lands in a sibling task and will replace the body
// below — this file only owns the route shell.
//
// NOTE: projectUuid is plumbed through so the canvas task can swap the empty
// state for the real canvas without changing the page contract.

import { useTranslations } from "next-intl";
import { Network } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AnimatedEmptyState } from "@/components/animated-empty-state";

interface ResourceGraphPlaceholderProps {
  projectUuid: string;
}

export function ResourceGraphPlaceholder(_props: ResourceGraphPlaceholderProps) {
  const t = useTranslations();
  // _props.projectUuid is intentionally received but unused at this stage;
  // the canvas task will consume it to fetch /api/projects/[uuid]/resource-graph.
  void _props;

  return (
    <div className="p-4 md:p-8">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-[#2C2C2C]">{t("graph.title")}</h1>
          <p className="mt-1 text-sm text-[#6B6B6B]">{t("graph.subtitle")}</p>
        </div>
        <Badge variant="secondary">{t("graph.comingSoon")}</Badge>
      </div>

      {/* Empty state — replaced by the real canvas in the rendering task. */}
      <AnimatedEmptyState>
        <Card className="flex flex-col items-center justify-center p-12 text-center border-[#E5E0D8]">
          <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-[#EEF2FF]">
            <Network className="h-8 w-8 text-[#4F46E5]" />
          </div>
          <h3 className="mb-2 text-lg font-medium text-[#2C2C2C]">{t("graph.emptyTitle")}</h3>
          <p className="max-w-sm text-sm text-[#6B6B6B]">{t("graph.emptyDesc")}</p>
        </Card>
      </AnimatedEmptyState>
    </div>
  );
}
