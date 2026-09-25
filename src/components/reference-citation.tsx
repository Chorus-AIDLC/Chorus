"use client";

import { useCallback, useSyncExternalStore, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isKnownReferenceType, referenceTypeConfig } from "@/components/reference-type-config";
import type { CitationStore } from "@/lib/reference-citation-store";
import { safeReferenceUrl } from "@/lib/reference-citations";
import { cn } from "@/lib/utils";

export function ReferenceCitation({
  uuid,
  store,
  children,
}: {
  uuid: string;
  store: CitationStore;
  children: ReactNode;
}) {
  const t = useTranslations();
  const subscribe = useCallback(
    (notify: () => void) => store.subscribe(uuid, notify),
    [store, uuid],
  );
  const snapshot = useCallback(() => store.snapshot(uuid), [store, uuid]);
  const state = useSyncExternalStore(subscribe, snapshot, store.serverSnapshot);
  const reference = state.status === "ready" ? state.reference : undefined;
  const href = reference ? safeReferenceUrl(reference.url) : undefined;
  const description = reference
    ? `${reference.title} — ${t(href ? "references.citationOpen" : "references.citationUnsafe")}`
    : t(`references.citation${state.status === "loading" ? "Loading" : state.status === "missing" ? "Missing" : "Error"}`);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <a
          href={href}
          target={href ? "_blank" : undefined}
          rel={href ? "noopener noreferrer" : undefined}
          role="link"
          tabIndex={0}
          aria-disabled={!href}
          aria-label={description}
          data-citation-state={state.status}
          onMouseEnter={() => store.refresh(uuid)}
          onFocus={() => store.refresh(uuid)}
          className={cn(
            "inline rounded-sm px-0.5 text-xs font-medium align-super focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            // Keep unavailable citations muted inside prose wrappers that color all anchors.
            href ? "text-primary hover:underline" : "text-muted-foreground aria-disabled:text-muted-foreground",
          )}
        >
          [{children}]
        </a>
      </TooltipTrigger>
      <TooltipContent
        sideOffset={4}
        className="max-w-[min(24rem,calc(100vw-2rem))] max-h-[var(--radix-tooltip-content-available-height)] overflow-y-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
      >
        {reference ? (
          <span className="flex flex-col gap-1">
            <span className="font-semibold">{reference.title}</span>
            <span>
              {isKnownReferenceType(reference.type)
                ? t(referenceTypeConfig[reference.type].labelKey)
                : reference.type}
            </span>
            <span>{reference.url}</span>
            {reference.notes?.trim() && <span>{reference.notes}</span>}
            {!href && <span>{t("references.citationUnsafe")}</span>}
          </span>
        ) : description}
      </TooltipContent>
    </Tooltip>
  );
}
