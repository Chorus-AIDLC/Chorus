"use client";

import { useEffect, useMemo, useState } from "react";
import { Streamdown } from "streamdown";

import {
  streamdownPlugins,
  streamdownControls,
} from "@/lib/streamdown-plugins";

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

export function MarkdownContent({ children }: { children: string }) {
  const isDark = useDarkClass();

  const mermaidOptions = useMemo(
    () => ({ config: { theme: isDark ? "dark" : "default" } as const }),
    [isDark],
  );

  // Mermaid renders SVGs once and caches them; the plugin's singleton `getMermaid()` call
  // doesn't re-paint existing diagrams when theme changes. Forcing a fresh subtree per
  // theme is the cheapest correct fix — Streamdown is light enough to remount.
  return (
    <Streamdown
      key={isDark ? "dark" : "light"}
      plugins={streamdownPlugins}
      controls={streamdownControls}
      mermaid={mermaidOptions}
    >
      {children}
    </Streamdown>
  );
}
