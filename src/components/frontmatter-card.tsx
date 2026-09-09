"use client";

import { useTranslations } from "next-intl";

import type { FrontmatterEntry } from "@/lib/frontmatter";

export interface FrontmatterCardProps {
  entries: FrontmatterEntry[];
}

/**
 * Presentational metadata card for a Markdown document's leading YAML
 * frontmatter (see `splitFrontmatter`). Purely display: it knows nothing about
 * which keys exist — no per-key colouring, no status badges, no linkification.
 *
 * Styled with semantic theme tokens only (`border-border`, `bg-muted`,
 * `text-foreground`, `text-muted-foreground`), so light and dark are both
 * correct with no `dark:` variant. Do not introduce hardcoded hex or
 * fixed-palette classes (`bg-green-50` etc.) here — they would render
 * pale-on-dark.
 */
export function FrontmatterCard({ entries }: FrontmatterCardProps) {
  const t = useTranslations("markdown");

  return (
    <section
      aria-label={t("frontmatterLabel")}
      className="mb-4 rounded-lg border border-border bg-muted/40 px-4 py-3"
    >
      {/*
        A definition list is the correct semantics for key/value metadata and
        degrades to readable text for screen readers. Keys and values are user
        content, so they are never translated.
      */}
      <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
        {entries.map((entry, index) => (
          // Frontmatter may legally repeat a key; index keeps rows stable.
          <div key={`${entry.key}-${index}`} className="grid grid-cols-subgrid col-span-2">
            <dt className="font-mono text-xs leading-5 text-muted-foreground break-words">
              {entry.key}
            </dt>
            <dd className="leading-5 text-foreground break-words">
              {entry.value === "" ? (
                // An empty value still carries information (the key is present),
                // so show an em-dash placeholder rather than collapsing the row
                // into an ambiguous blank.
                <span aria-hidden="true">—</span>
              ) : (
                entry.value
              )}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
