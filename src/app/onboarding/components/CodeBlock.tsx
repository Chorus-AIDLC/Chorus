"use client";

import { useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Check, Copy } from "lucide-react";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";

interface CodeBlockProps {
  code: string;
  language?: string;
}

export function CodeBlock({ code: codeContent, language }: CodeBlockProps) {
  const t = useTranslations("common");
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(codeContent);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = codeContent;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [codeContent]);

  const markdown = `\`\`\`${language || ""}\n${codeContent}\n\`\`\``;

  return (
    <div className="relative">
      <div className="absolute right-2 top-2 z-10">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleCopy}
          className="h-7 gap-1.5 px-2 text-xs text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800"
        >
          {copied ? (
            <>
              <Check className="size-3.5" />
              {t("copied")}
            </>
          ) : (
            <>
              <Copy className="size-3.5" />
              {t("copy")}
            </>
          )}
        </Button>
      </div>
      <Streamdown plugins={{ code }}>{markdown}</Streamdown>
    </div>
  );
}
