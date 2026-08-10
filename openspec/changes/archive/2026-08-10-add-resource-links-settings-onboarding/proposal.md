## Why

Chorus now has a dedicated documentation site (`https://doc.chorus-ai.dev`, localized for en / zh / ja / ko), but there is no in-product entry point to it or to the GitHub repository. Users who want to read the docs or find the source have to know the URLs by heart. Surfacing GitHub and Docs buttons where users naturally look for help — the settings page and the onboarding flow — closes that gap.

## What Changes

- Add a small **resource links** control that renders two external-link buttons, **GitHub** and **Docs** (icon + text), each opening in a new tab (`target="_blank"` + `rel="noopener noreferrer"`).
- The **Docs** button follows the current UI locale: `en` → `https://doc.chorus-ai.dev`, `zh` → `/zh`, `ja` → `/ja`, `ko` → `/ko`. The **GitHub** button always points at `https://github.com/Chorus-AIDLC/Chorus`.
- Render the control at the **top-right of the settings page header** (aligned with the page title).
- Render the control as a **persistent footer** in the onboarding wizard, visible on **every** step of the flow.
- Add the required i18n strings (`resourceLinks.github`, `resourceLinks.docs`, and aria labels) to all four locale files (en, zh, ja, ko).
- No new global entries (sidebar / help menu) and no extra links (What's New / community) — scope is intentionally the two buttons in the two locations.

## Capabilities

### New Capabilities
- `resource-links`: A reusable in-product control that surfaces the GitHub repository and the localized documentation site as external-link buttons, placed on the settings page and the onboarding wizard.

### Modified Capabilities
<!-- none — no existing spec's requirements change -->

## Impact

- **New component**: `src/components/resource-links.tsx` (client component; reads current locale via `useLocale`).
- **Modified**: `src/app/(dashboard)/settings/page.tsx` (header region) and `src/app/onboarding/components/OnboardingWizard.tsx` (persistent footer).
- **i18n**: new `resourceLinks.*` keys in `messages/{en,zh,ja,ko}.json`.
- **Dependencies**: none new — uses existing shadcn `Button`, `lucide-react` icons (`Github`, `BookOpen` / `ExternalLink`), and the existing `useLocale` context.
- No backend, API, schema, or permission changes.
