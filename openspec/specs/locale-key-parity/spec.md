# locale-key-parity Specification

## Purpose
Keep every app locale file (`messages/*.json`, driven by `src/i18n/config.ts` `locales`) in exact parity — identical leaf-key sets, non-empty values, and matching named ICU arguments — enforced by an automated test so a new feature can't silently ship an untranslated or drifted locale.
## Requirements
### Requirement: Locale files SHALL expose an identical key set

Every app locale file under `messages/` (currently `en.json`, `zh.json`, `ko.json`, and any locale registered in `src/i18n/config.ts`'s `locales` array) SHALL contain exactly the same set of leaf translation keys. No locale may have a key absent from another, and no locale may carry a key that others lack.

#### Scenario: A locale is missing a key present in the reference locale

- **WHEN** a locale file lacks a leaf key that exists in `en.json`
- **THEN** the automated parity test fails and its message lists the missing key(s) for that locale

#### Scenario: A locale carries an orphan key

- **WHEN** a locale file contains a leaf key that does not exist in `en.json` (e.g. a stray `ideas.completed`)
- **THEN** the automated parity test fails and its message lists the extra key(s) for that locale

#### Scenario: All locales are in parity

- **WHEN** every registered locale file has the identical leaf-key set
- **THEN** the parity test passes

### Requirement: Locale values SHALL be non-empty strings

Every leaf value in every registered locale file SHALL be a string whose trimmed length is greater than zero. An empty or whitespace-only translation is treated as a missing key because the UI would render a blank.

#### Scenario: A locale has an empty translation

- **WHEN** any leaf value in a locale file is an empty string or only whitespace
- **THEN** the parity test fails and identifies the offending key and locale

### Requirement: Named ICU placeholders SHALL match across locales

For each translation key, the set of named ICU arguments present in every locale's value SHALL equal the set present in the reference (`en`) value for that key. A named ICU argument is the top-level argument name of any ICU element — a simple placeholder (`{title}`, `{count}`), a `number`/`date`/`time` argument, or the argument of a `plural`/`select`/`selectordinal` block (the `count` in `{count, plural, ...}`). ICU structural keywords (`plural`, `select`, `selectordinal`), category selectors (`one`, `other`, `=0`, …), the count marker `#`, and any **literal text inside plural/select sub-messages** are NOT arguments and MUST be excluded.

The extractor SHALL derive this set by parsing the message into its ICU AST and collecting element argument names — it MUST NOT use a flat brace regex. A brace regex cannot distinguish an argument name from literal words that appear inside plural sub-messages: e.g. `en` `proposalValidation.errorCount` = `"{count} {count, plural, one {error} other {errors}}"` — the only argument is `count`, but a regex that captures identifiers after `{` also wrongly yields `error` and `errors`, and a locale that flattens to `"오류 {count}개"` legitimately yields only `count`, so the sets falsely differ and the guard reds CI on an already-shipped correct translation. Parsing the AST yields exactly `{count}` for both sides. The project already depends (transitively, via `next-intl`) on `@formatjs/icu-messageformat-parser`; use its `parse` and walk `plural`/`select` option sub-messages recursively, collecting only element argument names.

Because only the argument name is collected — never the sub-message text — a locale MAY render an ICU `plural` block as a single flattened phrase using the bare `{count}` placeholder (as Korean and Chinese do) and still match the `en` source's `{count, plural, ...}`: both yield the argument set `{count}`.

#### Scenario: A translation drops a required placeholder

- **WHEN** a locale's value for a key omits a named ICU argument that the `en` value contains
- **THEN** the parity test fails and identifies the key, locale, and missing argument

#### Scenario: A translation flattens an ICU plural block but keeps the placeholder

- **WHEN** `en` defines `references.countLabel` as `{count, plural, one {# reference} other {# references}}` and a locale renders it as a single phrase using the bare `{count}` placeholder
- **THEN** the parity test passes because the AST extractor yields the argument set `{count}` for BOTH the ICU-block `en` source and the flattened locale value

#### Scenario: The reference locale embeds literal words inside a plural block

- **WHEN** extracting arguments from an `en` value whose plural/select sub-messages contain literal words (e.g. `proposalValidation.errorCount` = `"{count} {count, plural, one {error} other {errors}}"`, or `tasks.blockedTooltip` embedding `{dependency}`/`{dependencies}`)
- **THEN** the extractor yields only the real argument name (`count`), never the sub-message literals, so a locale that flattens to `"오류 {count}개"` matches and the guard stays green on already-shipped correct translations

### Requirement: Korean SHALL cover all app UI strings

`messages/ko.json` SHALL provide a Korean translation for every key present in `en.json`, including the strings introduced for the theme toggle (`theme.*`), reference artifacts (`references.*`), theme/decompose idea affordances (`ideaTracker.lineage.*`, `ideaTracker.newIdea.*`), and graph zoom controls (`graph.zoom.*`). Translations SHALL preserve all ICU placeholders and use terminology consistent with the existing Korean glossary.

#### Scenario: A Korean user views a previously-untranslated surface

- **WHEN** a user with locale `ko` opens the references panel, the theme switcher, the idea tracker theme controls, or the graph zoom buttons
- **THEN** every label, placeholder, and message renders in Korean rather than a raw key string or an English fallback

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

