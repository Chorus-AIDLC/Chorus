"use client";

import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { ArrowLeft, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { MarkdownContent } from "@/components/markdown-content";
import { normalizeNewlines, DOC_TYPE_I18N_KEYS } from "./utils";
import { PANEL_WIDTH_PX } from "../utils";

interface DocumentPanelProps {
  title: string;
  type: string;
  content: string;
  mode?: "overlay" | "sidebyside";
  onClose: () => void;
  onBack?: () => void;
}

export function DocumentPanel({ title, type, content, mode = "overlay", onClose, onBack }: DocumentPanelProps) {
  const tDocs = useTranslations("documents");

  const [hasAnimated, setHasAnimated] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setHasAnimated(true), 300);
    return () => clearTimeout(timer);
  }, []);

  // Esc key: close this panel only (bubble phase — modals/dialogs on top get priority)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const isSideBySide = mode === "sidebyside";

  return (
    <>
      {/* Backdrop — only in overlay mode (sidebyside uses parent's backdrop) */}
      {!isSideBySide && (
        <div
          className="fixed inset-0 z-40 bg-black/20"
          onClick={onClose}
        />
      )}

      {/* Panel — full-width on mobile, fixed 480px from md (768px) up. Matches
          the idea-detail-panel sidebar's `w-full md:w-[480px]` convention so all
          three panels share one breakpoint. */}
      <div
        className={`fixed top-14 md:top-0 flex h-[calc(100%-3.5rem)] md:h-full w-full md:w-[480px] flex-col bg-card shadow-xl border-l border-border ${
          isSideBySide
            ? `z-40 ${hasAnimated ? "" : "animate-in slide-in-from-right duration-300"}`
            : `z-50 right-0 ${hasAnimated ? "" : "animate-in slide-in-from-right duration-300"}`
        }`}
        style={isSideBySide ? { right: `${PANEL_WIDTH_PX}px` } : undefined}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-secondary px-6 py-5">
          {onBack && (
            <Button
              variant="ghost"
              size="icon"
              className="mr-2 h-8 w-8 shrink-0"
              onClick={onBack}
            >
              <ArrowLeft className="h-4 w-4 text-muted-foreground" />
            </Button>
          )}
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-semibold text-foreground truncate">
              {title}
            </h2>
            <div className="mt-1.5">
              <Badge
                variant="outline"
                className="text-[10px] font-medium border-border text-muted-foreground bg-secondary px-2 py-0.5 font-mono"
              >
                {tDocs(DOC_TYPE_I18N_KEYS[type] || "typeOther")}
              </Badge>
            </div>
          </div>
          <Button
            variant="outline"
            size="icon"
            className="ml-4 h-8 w-8 shrink-0 border-border"
            onClick={onClose}
          >
            <X className="h-4 w-4 text-muted-foreground" />
          </Button>
        </div>

        {/* Content */}
        <ScrollArea className="flex-1 min-h-0 [&_[data-slot=scroll-area-viewport]>div]:!block">
          <div className="px-6 py-5 text-[13px] leading-relaxed text-foreground prose prose-sm max-w-none [&_h1]:text-lg [&_h1]:font-semibold [&_h1]:mt-4 [&_h1]:mb-2 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:mt-3 [&_h2]:mb-1.5 [&_h3]:text-sm [&_h3]:font-medium [&_h3]:mt-2 [&_h3]:mb-1 [&_p]:text-[13px] [&_p]:text-foreground/80 [&_p]:my-1.5 [&_li]:text-[13px] [&_li]:text-foreground/80 [&_ul]:my-1 [&_ol]:my-1 [&_strong]:text-foreground [&_code]:text-[12px] [&_code]:bg-secondary [&_code]:text-foreground [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_pre]:bg-secondary [&_pre]:text-foreground [&_pre]:p-3 [&_pre]:rounded-lg [&_pre]:my-2 [&_a]:text-primary">
            <MarkdownContent>{normalizeNewlines(content)}</MarkdownContent>
          </div>
        </ScrollArea>
      </div>
    </>
  );
}
