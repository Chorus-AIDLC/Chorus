// Shared reference-type presentation config (icon + hue-matched badge palette +
// i18n label key) for the four supported web-link reference types. Extracted so
// the editable ReferencesSection (idea/proposal/task detail panels) and the
// read-only idea-tracker references panel render identical type badges without
// duplicating the palette.
//
// Dark-mode: every badge class carries a hue-matched `dark:` variant so it reads
// correctly in BOTH light and dark (a fixed-light-only class would render
// pale-on-dark). Types not in this map fall back to a semantic-token badge.

import { BookText, Github, GitPullRequest, Newspaper } from "lucide-react";

// Reference types must match REFERENCE_TYPES in reference-artifact.service.ts.
export const REFERENCE_TYPE_OPTIONS = [
  "docs",
  "repo",
  "issue_pr",
  "paper_blog",
] as const;
export type ReferenceTypeOption = (typeof REFERENCE_TYPE_OPTIONS)[number];

export const referenceTypeConfig: Record<
  ReferenceTypeOption,
  { labelKey: string; badgeClass: string; icon: typeof BookText }
> = {
  docs: {
    labelKey: "references.typeDocs",
    badgeClass: "bg-blue-50 text-blue-700 dark:bg-[#13253a] dark:text-[#5AA9F0]",
    icon: BookText,
  },
  repo: {
    labelKey: "references.typeRepo",
    badgeClass:
      "bg-green-50 text-green-700 dark:bg-[#14281a] dark:text-[#6FD19A]",
    icon: Github,
  },
  issue_pr: {
    labelKey: "references.typeIssuePr",
    badgeClass:
      "bg-purple-50 text-purple-700 dark:bg-[#281630] dark:text-[#C98FE0]",
    icon: GitPullRequest,
  },
  paper_blog: {
    labelKey: "references.typePaperBlog",
    badgeClass:
      "bg-amber-50 text-amber-700 dark:bg-[#332a12] dark:text-[#E0B44E]",
    icon: Newspaper,
  },
};

export function isKnownReferenceType(type: string): type is ReferenceTypeOption {
  return (REFERENCE_TYPE_OPTIONS as readonly string[]).includes(type);
}
