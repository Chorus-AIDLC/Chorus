"use client";

// Renders the two external "resource" entry points — the GitHub repository and
// the localized documentation site — as icon+text buttons. Used on the settings
// page header and the onboarding wizard footer so users can always find where
// to read the docs or view the source.

import { Github, BookOpen } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { useLocale } from "@/contexts/locale-context";
import { cn } from "@/lib/utils";

const GITHUB_URL = "https://github.com/Chorus-AIDLC/Chorus";
const DOCS_BASE = "https://doc.chorus-ai.dev";

// The docs site serves `en` at the unprefixed root and every other locale under
// a `/<locale>` path prefix (zh / ja / ko). Keep this in lockstep with the app's
// supported locale set in src/i18n/config.ts.
export function docsUrlForLocale(locale: string): string {
  return locale === "en" ? DOCS_BASE : `${DOCS_BASE}/${locale}`;
}

interface ResourceLinksProps {
  /**
   * Layout variant. "inline" packs the buttons tightly for a header row;
   * "footer" centers them for the onboarding wizard footer. Button styling is
   * identical across variants so the two placements read as one system.
   */
  variant?: "inline" | "footer";
  className?: string;
}

export function ResourceLinks({
  variant = "inline",
  className,
}: ResourceLinksProps) {
  const t = useTranslations("resourceLinks");
  const { locale } = useLocale();

  const docsUrl = docsUrlForLocale(locale);

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2",
        variant === "footer" && "justify-center gap-3",
        className,
      )}
    >
      <Button variant="outline" size="sm" asChild>
        <a
          href={GITHUB_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t("githubAria")}
        >
          <Github className="h-4 w-4" />
          {t("github")}
        </a>
      </Button>
      <Button variant="outline" size="sm" asChild>
        <a
          href={docsUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t("docsAria")}
        >
          <BookOpen className="h-4 w-4" />
          {t("docs")}
        </a>
      </Button>
    </div>
  );
}
