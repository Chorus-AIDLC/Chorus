## Why

Chorus ships in three app locales today — English, Chinese, and Korean (`ko` landed in #411/#419). Japanese-speaking users have no localized experience: they either read the app in English or, if their browser is set to Japanese, still fall through to the `en` default because `ja` is not a registered locale. This idea adds Japanese (`ja`) as a first-class fourth locale so a Japanese user can use the entire app in natural Japanese, at coverage parity with `en`/`zh`/`ko` (`en.json` currently has **1482 leaf keys**).

This is the direct sibling of the Korean work, but not the same shape: `ko` was a **42-key backfill** of an already-registered locale. `ja` is a **net-new locale** — the `ja` code isn't registered, `messages/ja.json` doesn't exist, and the parity guard's hard-coded locale import map has no `ja` entry. All three must be added together or the guard reds CI.

## What Changes

- **Register the `ja` locale** — add `'ja'` to the `locales` array and `ja: '日本語'` to `localeNames` in `src/i18n/config.ts`. Both language switchers (Settings page and bottom-left quick-settings) render `locales.map(...)` dynamically, so Japanese appears automatically with no switcher code change (same as `ko`). Browser auto-detection is **already live** — `detectBrowserLocale()` (config.ts) is wired in `src/contexts/locale-context.tsx`, so once `ja` is registered a first-time visitor with a Japanese browser gets Japanese for free. No server-side Accept-Language detection is added (confirmed in elaboration).
- **Create `messages/ja.json` with all 1482 keys** — a complete natural-Japanese translation, generated in `en.json` key order (insertion-ordered, byte-clean). Every named ICU placeholder is preserved verbatim; the 20 ICU `plural`/`select` blocks are flattened to a single natural phrasing with the bare placeholder (`{count}` etc.), exactly as `zh.json` and `ko.json` do — Japanese has no grammatical plural. A consistent Japanese glossary is applied across all strings (see design).
- **Extend the parity guard to cover `ja`** — the existing `src/i18n/__tests__/locale-parity.test.ts` checks (identical key set / non-empty values / matching named ICU args) are driven by the `locales` array and cover `ja` for free once registered, **but** the test also has a hard-coded `MESSAGES` import map (`en`/`zh`/`ko`) designed to "fail loudly" if a registered locale is missing from the map. Add the `ja` import + map entry so the guard actually loads and checks `ja.json`.
- **Focused quality self-check** — review the high-frequency UI surface (nav, buttons, status/priority labels, settings, error/toast messages, onboarding, idea/proposal/task panels) plus glossary-term consistency across all namespaces, aligning with the depth used for `ko` (elaboration Q3=b).

Out of scope (confirmed in elaboration): the marketing landing page `packages/landing` (separate en/zh-only i18n, ~177 keys — Q1=a); any server-side Accept-Language first-paint detection (Q2=a).

## Capabilities

### Modified Capabilities
- `locale-key-parity`: extend the enforced "every registered locale covers all app UI strings" invariant to include Japanese — `messages/ja.json` SHALL provide a translation for every `en.json` key with matching ICU placeholders, and the parity test SHALL load and check `ja` (not silently skip it).

## Impact

- **`src/i18n/config.ts`** — `ja` added to `locales`; `ja: '日本語'` added to `localeNames`.
- **`messages/ja.json`** — new file, 1482 keys, full Japanese translation.
- **`src/i18n/__tests__/locale-parity.test.ts`** — add `ja` import + `MESSAGES` map entry so the hard-coded loader covers `ja`.
- No runtime/schema/API changes. Switchers and auto-detection are picked up automatically (verified, not modified). `packages/landing` untouched.
