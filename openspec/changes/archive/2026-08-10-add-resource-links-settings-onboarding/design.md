## Context

The docs site (`https://doc.chorus-ai.dev`) is live and localized: `en` is the unprefixed root, and `zh` / `ja` / `ko` are path-prefixed (`/zh`, `/ja`, `/ko`). The GitHub repo is `https://github.com/Chorus-AIDLC/Chorus`. The app's active UI locale is available client-side via `useLocale()` from `@/contexts/locale-context` (persisted in `localStorage` under `chorus-locale`). The supported locale set is `['en', 'zh', 'ko', 'ja']` (`src/i18n/config.ts`).

Both target surfaces are client components:
- `src/app/(dashboard)/settings/page.tsx` — `"use client"`, already calls `useTranslations()` and `useLocale()`, header lives in a `mb-8` block with an `<h1>`.
- `src/app/onboarding/components/OnboardingWizard.tsx` — `"use client"`, renders step content inside a centered `max-w-2xl` column, already has a global skip `<Button>` below the steps.

## Goals / Non-Goals

**Goals**
- One reusable control, two placements, consistent look.
- Docs link resolves to the locale-matched docs URL; GitHub link is fixed.
- Links open in a new tab without leaking the referrer/opener.
- Fully i18n'd labels + accessible names across en/zh/ja/ko.
- Correct in both light and dark themes.

**Non-Goals**
- No sidebar or top help-menu entry (explicitly declined in elaboration).
- No extra resources (What's New, community/feedback).
- No server-side rendering of the control (locale is a client concern here).

## Decisions

### Component contract — `src/components/resource-links.tsx`

```tsx
"use client";
interface ResourceLinksProps {
  /** layout variant: "inline" for the settings header row, "footer" for the onboarding footer */
  variant?: "inline" | "footer";
  className?: string;
}
```

- Renders two `<Button asChild variant="outline" size="sm">` wrapping `<a href … target="_blank" rel="noopener noreferrer">`, each with a `lucide-react` icon (`Github`, `BookOpen`) + a translated label.
- Uses `useLocale()` to compute the docs href; uses `useTranslations("resourceLinks")` for labels + aria-labels.
- `variant` only tweaks container spacing/justification (`inline` → `flex gap-2`; `footer` → centered `flex gap-3`). Button styling is identical so the two placements read as one system.
- Uses semantic tokens only (`variant="outline"` already theme-aware) — no hardcoded hex, so light/dark both work for free.

### Docs URL resolution

Single pure helper, colocated in the component (small enough not to warrant its own module, but extractable):

```ts
const DOCS_BASE = "https://doc.chorus-ai.dev";
function docsUrlForLocale(locale: string): string {
  return locale === "en" ? DOCS_BASE : `${DOCS_BASE}/${locale}`;
}
```

`en` → root; every other supported locale (`zh`, `ja`, `ko`) → `/{locale}`. This matches the docs skill's documented locale layout. If an unexpected locale value ever appears, it degrades to `/{locale}` which is harmless (worst case a 404 the user can navigate back from) — but the supported set is fixed, so this won't happen in practice.

### GitHub URL

Constant `https://github.com/Chorus-AIDLC/Chorus`. No locale variance.

### Placement

- **Settings**: wrap the existing header `<h1>` + subtitle and the new `<ResourceLinks variant="inline" />` in a `flex items-start justify-between` row so the buttons sit top-right, title left. On narrow screens the buttons wrap below the title (`flex-wrap` / responsive), no layout break.
- **Onboarding**: render `<ResourceLinks variant="footer" />` once in `OnboardingWizard` **below** the step content and the existing skip link, so it is present on every step (steps 0–5). It sits outside the `AnimatePresence` step swap, so it does not animate in/out per step.

### Open behavior

`target="_blank"` + `rel="noopener noreferrer"` on both anchors — new tab, no opener/referrer leak. Chosen per elaboration (open in new tab, don't interrupt the current flow).

## Risks / Trade-offs

- **Locale drift**: if a new docs locale is added but not to `locales`, the docs link would 404 for that locale. Mitigation: `docsUrlForLocale` is driven by the same locale set the rest of the app uses, so they move together.
- **Onboarding footer crowding**: the wizard already has a skip link; adding a second row could feel busy. Mitigation: `footer` variant uses muted `outline` buttons and sits below skip, visually secondary to the primary step CTA.

## Migration Plan

Additive only — new component + two call sites + new i18n keys. No data migration, no flags. Ships in one change.

## Open Questions

None — all resolved in elaboration (scope = GitHub+Docs only; settings header top-right; onboarding persistent footer; icon+text; docs follows locale; new tab).
