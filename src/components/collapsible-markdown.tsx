"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { MarkdownContent } from "@/components/markdown-content";

const COLLAPSED_MAX_HEIGHT = 80; // px — roughly 3-4 lines of compact body text

interface CollapsibleMarkdownProps {
  content: string;
  /** Extra classes applied to the outer wrapper (spacing, typography). */
  className?: string;
}

/**
 * Renders markdown content with an expand/collapse toggle for long content.
 *
 * Unlike the character-slicing approach used for plain comments, this clamps
 * the *rendered* height so markdown syntax (headings, lists, code) is never cut
 * mid-token. The collapsed clamp is applied from first paint (no flash), and the
 * "Show more" toggle only appears when the content actually overflows.
 */
export function CollapsibleMarkdown({ content, className }: CollapsibleMarkdownProps) {
  const t = useTranslations();
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;

    const measure = () =>
      setOverflowing(el.scrollHeight > COLLAPSED_MAX_HEIGHT + 1);

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [content]);

  return (
    <div className={className}>
      <div
        ref={contentRef}
        className="overflow-hidden [&_h1]:text-sm [&_h1]:font-semibold [&_h1]:mt-2 [&_h1]:mb-1 [&_h2]:text-[13px] [&_h2]:font-semibold [&_h2]:mt-2 [&_h2]:mb-1 [&_h3]:text-[13px] [&_h3]:font-semibold [&_h3]:mt-1.5 [&_h3]:mb-0.5 [&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0.5 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0"
        style={expanded ? undefined : { maxHeight: COLLAPSED_MAX_HEIGHT }}
      >
        <MarkdownContent>{content}</MarkdownContent>
      </div>
      {overflowing && (
        <Button
          variant="link"
          size="sm"
          onClick={() => setExpanded((value) => !value)}
          className="h-auto p-0 text-[#E07A5F] text-xs font-medium mt-1"
        >
          {expanded ? t("common.showLess") : t("common.showMore")}
        </Button>
      )}
    </div>
  );
}
