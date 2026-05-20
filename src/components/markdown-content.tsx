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

  // Mermaid caches its singleton inside Streamdown; passing a new `mermaid` prop
  // updates config but does not re-paint already-rendered SVGs. The `key` forces
  // React to tear down and rebuild the subtree on theme change, which is what
  // actually triggers the repaint. Don't drop the key while keeping the prop —
  // the prop alone won't repaint cached diagrams and the bug returns silently.
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
