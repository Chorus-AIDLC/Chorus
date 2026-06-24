"use client";

import { useEffect, useMemo, useState } from "react";
import { Streamdown, type Components } from "streamdown";

import {
  streamdownPlugins,
  streamdownControls,
} from "@/lib/streamdown-plugins";

// Custom-tag passthrough for Streamdown. The default markdown surfaces pass none
// of these, so their render is byte-identical to before. The comment mention path
// (ContentWithMentions' opt-in `renderMention`) passes a `<chorus-mention>` custom
// tag mapping so an agent @mention renders as a real, interactive React node
// (MentionBadge) instead of imperatively-injected DOM — which a Radix Popover
// cannot live inside. `literalTagContent` keeps the tag's child label out of the
// markdown parser, and `allowedTags` whitelists the tag + its attributes through
// Streamdown's sanitizer.
export interface MarkdownContentProps {
  children: string;
  /** react-markdown-style element overrides (e.g. a custom `<chorus-mention>`). */
  components?: Components;
  /** Custom tags + permitted attributes allowed through sanitization. */
  allowedTags?: Record<string, string[]>;
  /** Tags whose children are treated as plain text (no markdown parsing). */
  literalTagContent?: string[];
}

function useDarkClass(): boolean {
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    const root = document.documentElement;
    const update = () => setIsDark(root.classList.contains("dark"));
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  return isDark;
}

export function MarkdownContent({
  children,
  components,
  allowedTags,
  literalTagContent,
}: MarkdownContentProps) {
  const isDark = useDarkClass();

  const mermaidOptions = useMemo(
    () => ({ config: { theme: isDark ? "dark" : "default" } as const }),
    [isDark],
  );

  // Mermaid caches its singleton inside Streamdown; passing a new `mermaid` prop
  // updates config but does not re-paint already-rendered SVGs. The `key` forces
  // React to tear down and rebuild the subtree on theme change, which is what
  // actually triggers the repaint. Don't drop the key while keeping the prop —
  // the prop alone won't repaint cached diagrams and the bug returns silently.
  //
  // `components`/`allowedTags`/`literalTagContent` are forwarded only when set
  // (the default markdown surfaces pass none, so their render stays byte-stable).
  return (
    <Streamdown
      key={isDark ? "dark" : "light"}
      plugins={streamdownPlugins}
      controls={streamdownControls}
      mermaid={mermaidOptions}
      components={components}
      allowedTags={allowedTags}
      literalTagContent={literalTagContent}
    >
      {children}
    </Streamdown>
  );
}
