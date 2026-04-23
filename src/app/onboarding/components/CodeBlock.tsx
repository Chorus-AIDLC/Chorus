"use client";

import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";

interface CodeBlockProps {
  code: string;
  language?: string;
}

export function CodeBlock({ code: codeContent, language }: CodeBlockProps) {
  const markdown = `\`\`\`${language || ""}\n${codeContent}\n\`\`\``;

  return <Streamdown plugins={{ code }}>{markdown}</Streamdown>;
}
