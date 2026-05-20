"use client";

import { code } from "@streamdown/code";
import { mermaid } from "@streamdown/mermaid";

export const streamdownPlugins = { code, mermaid } as const;

export const streamdownControls = {
  mermaid: {
    fullscreen: true,
    download: true,
    copy: true,
    panZoom: true,
  },
} as const;
