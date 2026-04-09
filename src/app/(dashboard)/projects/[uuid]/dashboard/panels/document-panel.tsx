"use client";

import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { ArrowLeft, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Streamdown } from "streamdown";
import { code as codePlugin } from "@streamdown/code";
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

      {/* Panel */}
      <div
        className={`fixed top-14 md:top-0 flex h-[calc(100%-3.5rem)] md:h-full w-full flex-col bg-white shadow-xl border-l border-[#E5E0D8] ${
          isSideBySide
            ? `z-40 ${hasAnimated ? "" : "animate-in slide-in-from-right duration-300"}`
            : `z-50 right-0 ${hasAnimated ? "" : "animate-in slide-in-from-right duration-300"}`
        }`}
        style={{
          width: `min(100%, ${PANEL_WIDTH_PX}px)`,
          ...(isSideBySide ? { right: `${PANEL_WIDTH_PX}px` } : {}),
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[#F5F2EC] px-6 py-5">
          {onBack && (
            <Button
              variant="ghost"
              size="icon"
              className="mr-2 h-8 w-8 shrink-0"
              onClick={onBack}
            >
              <ArrowLeft className="h-4 w-4 text-[#6B6B6B]" />
            </Button>
          )}
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-semibold text-[#2C2C2C] truncate">
              {title}
            </h2>
            <div className="mt-1.5">
              <Badge
                variant="outline"
                className="text-[10px] font-medium border-[#E5E0D8] text-[#6B6B6B] bg-[#F5F2EC] px-2 py-0.5 font-mono"
              >
                {tDocs(DOC_TYPE_I18N_KEYS[type] || "typeOther")}
              </Badge>
            </div>
          </div>
          <Button
            variant="outline"
            size="icon"
            className="ml-4 h-8 w-8 shrink-0 border-[#E5E0D8]"
            onClick={onClose}
          >
            <X className="h-4 w-4 text-[#6B6B6B]" />
          </Button>
        </div>

        {/* Content */}
        <ScrollArea className="flex-1 min-h-0 [&_[data-slot=scroll-area-viewport]>div]:!block">
          <div className="px-6 py-5 text-[13px] leading-relaxed text-[#2C2C2A] prose prose-sm max-w-none [&_h1]:text-lg [&_h1]:font-semibold [&_h1]:mt-4 [&_h1]:mb-2 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:mt-3 [&_h2]:mb-1.5 [&_h3]:text-sm [&_h3]:font-medium [&_h3]:mt-2 [&_h3]:mb-1 [&_p]:text-[13px] [&_p]:text-[#4A4A4A] [&_p]:my-1.5 [&_li]:text-[13px] [&_li]:text-[#4A4A4A] [&_ul]:my-1 [&_ol]:my-1 [&_strong]:text-[#2C2C2C] [&_code]:text-[12px] [&_code]:bg-[#F5F2EC] [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_pre]:bg-[#FAF8F4] [&_pre]:p-3 [&_pre]:rounded-lg [&_pre]:my-2">
            <Streamdown plugins={{ code: codePlugin }}>
              {normalizeNewlines(content)}
            </Streamdown>
          </div>
        </ScrollArea>
      </div>
    </>
  );
}
