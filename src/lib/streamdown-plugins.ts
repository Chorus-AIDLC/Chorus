"use client";

import { code, createCodePlugin } from "@streamdown/code";
import { mermaid } from "@streamdown/mermaid";

// Streamdown's code plugin emits a SINGLE set of Shiki CSS vars (--sdm-c / -bg /
// -fg / -tbg) from the FIRST (default) theme in its `themes` tuple, and
// globals.css consumes those vars unconditionally. So a code block always paints
// with whatever theme sits in slot 0. The default plugin is ["github-light",
// "github-dark"] → slot 0 is light → code blocks stay light even in dark mode.
//
// Fix: build the plugin per-theme. In dark we put github-dark in BOTH slots so
// the emitted --sdm-* vars carry dark syntax colors + a dark code background.
// MarkdownContent picks the right one and remounts (its `key`) on theme flip, so
// Shiki re-tokenizes with the correct palette. Light is unchanged (default plugin).
export const codePluginLight = code; // default: ["github-light", "github-dark"]
export const codePluginDark = createCodePlugin({
  themes: ["github-dark", "github-dark"],
});

export function streamdownPluginsFor(isDark: boolean) {
  return { code: isDark ? codePluginDark : codePluginLight, mermaid } as const;
}

// Back-compat static export (light) for any non-theme-aware caller.
export const streamdownPlugins = { code, mermaid } as const;

export const streamdownControls = {
  mermaid: {
    fullscreen: true,
    download: true,
    copy: true,
    panZoom: true,
  },
} as const;
