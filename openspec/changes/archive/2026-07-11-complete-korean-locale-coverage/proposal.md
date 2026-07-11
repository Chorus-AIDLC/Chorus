## Why

Commit #411 added Korean (`ko`) as the third app locale, but the translation is incomplete and unguarded: `ko.json` has 1440 leaf keys while `en.json` has 1482 — Korean is missing **42 keys** for features that landed around the same time (dark-mode toggle, reference artifacts, theme/decompose idea affordances, graph zoom). There is also no automated check keeping the three locales' key sets aligned, so `zh.json` has already drifted (a stray `ideas.completed` that `en` never had). Without a parity guard, every future feature silently re-introduces this gap. Korean users hit raw key strings on any surface the translation missed.

## What Changes

- **Backfill the 42 missing `ko` keys** — `theme.*` (4), `references.*` (25), `ideaTracker.lineage.*` / `ideaTracker.newIdea.*` (9), `graph.zoom.*` (3) — with natural Korean, preserving every ICU placeholder and flattening `plural` blocks the same way `zh.json` does (Korean has no grammatical plural).
- **Quality-review the Korean translation (focused)** — proofread the newly-added 42 entries plus the high-frequency UI surface (nav, buttons, status/priority labels, settings, error/toast messages) for naturalness and terminology consistency; spot-check the rest.
- **Add an automated locale-parity guard** — a Vitest test asserting all three locale files (`en`, `zh`, `ko`) have an **identical** set of leaf keys AND identical named ICU placeholders per key, so future drift fails CI instead of shipping. Remove the orphan `ideas.completed` from `zh.json` as part of bringing the sets into parity.
- **Verify the language switcher renders Korean** — the Settings picker and bottom-left quick-settings both iterate `locales` (already includes `ko`), so no code change is expected; this is a browser verification, with responsive polish only if the extra option crowds the layout.

Out of scope (confirmed in elaboration): automatic system-language detection / follow-system "System" tri-state (dropped this round; may become its own idea), and the marketing landing page `packages/landing`.

## Capabilities

### New Capabilities
- `locale-key-parity`: An enforced invariant that every app locale file exposes the same set of translation keys with matching ICU placeholders, backed by an automated test that fails on drift.

### Modified Capabilities
<!-- None. The existing i18n/locale-switcher behavior is unchanged at the requirement level; ko is data-only backfill and switcher rendering is already spec-neutral. -->

## Impact

- **`messages/ko.json`** — 42 keys added; focused quality edits to existing entries.
- **`messages/zh.json`** — remove orphan `ideas.completed`.
- **`src/i18n/__tests__/`** — new parity test (generalizes the existing narrow `report-locale-keys.test.ts` contract to a full key-set + placeholder check across all locales).
- No runtime/schema/API changes. Switcher UI verified, not modified (unless layout polish is needed).
