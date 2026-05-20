"use client";

import { MarkdownContent } from "@/components/markdown-content";

interface CodeBlockProps {
  code: string;
  language?: string;
}

export function CodeBlock({ code: codeContent, language }: CodeBlockProps) {
  const markdown = `\`\`\`${language || ""}\n${codeContent}\n\`\`\``;

  return <MarkdownContent>{markdown}</MarkdownContent>;
}
