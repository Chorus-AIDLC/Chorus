"use client";

// Live reader for the `.dark` class on <html>.
//
// next-themes toggles a `.dark` class on <html> (attribute="class"); most of the
// app themes purely through CSS (`dark:` utilities / token vars), but a few
// consumers must branch on the theme in JS because CSS `dark:` can't reach them:
//   - <canvas> painters (Canvas 2D can't read CSS custom properties)
//   - third-party components whose own stylesheet is unlayered and beats
//     Tailwind's layered utilities (e.g. @xyflow/react's `.react-flow.dark`
//     chrome, driven by its `colorMode` prop — not by class inheritance)
//
// This hook observes the class attribute so it stays correct across a
// light↔dark flip regardless of how the theme is driven. Mirrors the local
// `useDarkClass` in markdown-content.tsx (kept there to avoid a churny import
// in that file); this is the shared export for new consumers.

import { useEffect, useState } from "react";

export function useDarkClass(): boolean {
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
