## ADDED Requirements

### Requirement: Japanese SHALL cover all app UI strings

`messages/ja.json` SHALL provide a Japanese translation for every key present in `en.json` (currently 1482 leaf keys), and `ja` SHALL be a registered locale in `src/i18n/config.ts`'s `locales` array with a `localeNames` display value of `日本語`. Translations SHALL preserve all named ICU placeholders and SHALL apply a consistent Japanese glossary (です・ます polite form; natural kanji/和語 terms where they exist, katakana for terms with no natural kanji such as agent/project/session). ICU `plural`/`select` blocks MAY be flattened to a single natural Japanese phrase using the bare argument placeholder, because Japanese has no grammatical plural.

#### Scenario: A Japanese user views any app surface

- **WHEN** a user whose locale is `ja` opens any localized surface — navigation, settings, the idea/proposal/task panels, references, notifications, onboarding, or the agent/daemon views
- **THEN** every label, placeholder, and message renders in Japanese rather than a raw key string or an English fallback

#### Scenario: A Japanese browser visitor with no stored preference

- **WHEN** a first-time visitor whose browser language is Japanese (`ja` / `ja-JP`) loads the app with no `chorus-locale` stored
- **THEN** `detectBrowserLocale()` resolves the locale to `ja` and the app renders in Japanese without any manual switch

#### Scenario: The Japanese translation flattens an ICU plural block

- **WHEN** `en` defines a key such as `references.countLabel` as `{count, plural, one {# reference} other {# references}}` and `ja.json` renders it as a single phrase using the bare `{count}` placeholder (e.g. `参考資料 {count}件`)
- **THEN** the parity test passes because the AST extractor yields the argument set `{count}` for both the ICU-block `en` source and the flattened `ja` value

### Requirement: The parity guard SHALL load and check every registered locale

The locale-parity test SHALL check every locale registered in `src/i18n/config.ts`'s `locales` array against the reference locale — it MUST NOT silently skip a registered locale because the locale's message file was not wired into the test's import map. When a new locale (such as `ja`) is added to `locales`, its message JSON SHALL be imported and present in the test's `MESSAGES` map so the identical-key-set, non-empty-value, and matching-ICU-argument assertions actually run against it.

#### Scenario: A locale is registered but its messages are not wired into the test

- **WHEN** a locale code is present in `locales` but absent from the parity test's `MESSAGES` import map
- **THEN** the parity test fails loudly (rather than passing while silently skipping that locale)

#### Scenario: Japanese is registered and wired

- **WHEN** `ja` is in `locales` and `messages/ja.json` is imported into the `MESSAGES` map
- **THEN** the parity test runs its full key-set / non-empty / ICU-argument checks against `ja` and passes only when `ja.json` is at full parity with `en.json`
