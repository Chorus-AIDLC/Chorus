# Technical Design: Add complete Japanese (ja) locale

## Overview

Three coordinated pieces, all on the app's `messages/` + `src/i18n/` surface:

1. **Register `ja`** — two lines in `src/i18n/config.ts` (`locales` array + `localeNames`). Everything downstream (both switchers, `request.ts`, `locale-context.tsx`, browser auto-detect) is already `locales`-driven, so no other code changes.
2. **Translate** — new `messages/ja.json`, all 1482 keys, natural Japanese, ICU placeholders preserved, plural blocks flattened. This is the bulk of the work.
3. **Parity guard** — add the `ja` import + `MESSAGES` map entry to `src/i18n/__tests__/locale-parity.test.ts` so the hard-coded loader checks `ja` (the key-set / non-empty / ICU-arg logic is already `locales`-driven and needs no change).

There is **no runtime code change** beyond the two config lines: the locale plumbing already lists locales dynamically.

## Locale registration (exact edits)

`src/i18n/config.ts`:

```ts
export const locales = ['en', 'zh', 'ko', 'ja'] as const;   // add 'ja'

export const localeNames: Record<Locale, string> = {
  en: 'English',
  zh: '中文',
  ko: '한국어',
  ja: '日本語',                                             // add
};
```

`detectBrowserLocale()` already does `navigator.language.split('-')[0]` and returns it if it's in `locales`, so `ja-JP` browsers resolve to `ja` automatically once registered. No change needed there.

## Translation glossary (elaboration Q4=b: です・ます 敬体 + kanji/wago-first)

Confirmed with the owner: elaboration **Q4=b**, whose option is literally "です・ます 敬体 + 汉字/和语术语（着想/課題/提案/文書 等）", and the confirmation comment 81c70fdb presented this same kanji/wago table. The owner resolved elaboration and clicked Yolo without requesting any katakana substitution, so the four example nouns are used **as the owner chose them**. Principle: use the owner's kanji/和語 terms; keep **katakana only** for terms that have no natural kanji (agent, project, session, dashboard, comment, theme…); use **です・ます** polite form throughout; keep every ICU placeholder verbatim.

| English | 日本語 | Notes |
|---|---|---|
| Idea | 着想 | Owner's Q4=b example word — use as chosen. |
| Proposal | 提案 | Owner's Q4=b example word. |
| Task | 課題 | Owner's Q4=b example word — use as chosen. |
| Document | 文書 | Owner's Q4=b example word — use as chosen (not ドキュメント). |
| Agent | エージェント | No natural kanji — katakana. |
| Project | プロジェクト | No natural kanji — katakana. |
| Session | セッション | No natural kanji — katakana. |
| Comment | コメント | Katakana is the standard product term. |
| Elaborate / Elaboration | 詳細化 | |
| Proposal review / Verify | 検証 / レビュー | "Verify a task" → 検証; "review" as an activity → レビュー. |
| Execute / Development | 実行 / 開発 | |
| Approve / Reject | 承認 / 却下 | |
| Acceptance criteria | 受け入れ基準 | |
| Priority (high/medium/low) | 優先度（高/中/低） | |
| Status (open/in progress/done…) | ステータス（未着手/進行中/完了…） | |
| Done / Completed | 完了 | |
| Theme (container idea) | テーマ | Matches the `ideaTracker.lineage.*` "Theme" concept; no natural kanji. |
| Dashboard | ダッシュボード | |
| Settings | 設定 | |
| Notification | 通知 | |

> **Glossary fidelity.** The four nouns the owner listed in Q4=b (着想 / 課題 / 提案 / 文書) are used verbatim — no katakana substitution. Kanji/wago is preferred wherever the term has a natural Japanese equivalent; katakana is used **only** where there is no natural kanji (agent / project / session / dashboard / comment / theme). This applies uniformly across all 49 namespaces.

Apply the glossary consistently; the same English concept must map to the same Japanese term across all 49 namespaces.

## ICU placeholder rules

- Simple placeholders (`{title}`, `{count}`, `{name}`, `{done}`, `{total}`, `{hosts}`, …) MUST appear **unchanged** in the Japanese string.
- The 20 keys containing ICU `plural`/`select` blocks MUST be **flattened** to a single natural Japanese phrase using the bare argument placeholder — Japanese has no grammatical plural, same as `zh`/`ko`. This is parity-guard-safe: the AST extractor collects the argument *name* (`count`, `name`, `hosts`) from both the `en` `{count, plural, …}` source and the flattened `{count}` value, yielding the same argument set.

The 20 plural/select keys (authoritative — regenerate against the live `en.json` at implementation time in case it shifts):

```
tasks.blockedTooltip            proposals.revokeTasksToClose    proposals.revokeDocsToDelete
proposals.depCount              proposalValidation.errorCount   proposalValidation.warningCount
references.countLabel           projectGroups.deleteKeepProjects projectGroups.deleteWithProjects
groupDashboard.subtitle         onboarding.completion.permissionsCount
ideaTracker.panel.timeline.rounds  ideaTracker.panel.taskList.agentWorking
ideaTracker.panel.taskList.workersActive  daemonChat.agentSessionCount
agentPresence.onlineUnit        agentPresence.drilldown.instancesCount
agentPresence.drilldown.hostsCount  agentPresence.drilldown.queuedCount
mentionInstance.subtitle
```

`mentionInstance.subtitle` = `"{name} is live in {count, plural, ...} across {hosts, plural, ...}"` — has **three** arguments (`name`, `count`, `hosts`); the Japanese flatten must keep all three placeholders. A Japanese counter suffix is natural here: e.g. `"{name} が {hosts}台のホストの {count}個のインスタンスで稼働中"`.

Japanese counter words (助数詞) are encouraged for natural phrasing on count keys: 件 (generic items/ideas/tasks), 個 (instances), 台 (hosts/machines), 回 (rounds), 名 (agents/people). e.g. `references.countLabel` → `"参考資料 {count}件"`.

## Generation approach (reuse ko's proven method)

1. **Build `ja.json` in `en.json` key order** — walk `en.json` insertion-ordered, translate each leaf, emit the same nested structure. Byte-clean JSON, 2-space indent, matching the existing files.
2. **Never drop or add keys** — the output must have exactly the 1482 leaf keys of `en.json`. The parity guard is the backstop.
3. **Verify placeholders programmatically** before finishing: for each key, assert the set of named ICU args in the `ja` value equals `en`'s, using the same `@formatjs/icu-messageformat-parser` AST walk the parity test uses (NOT a brace regex — a regex over-extracts plural sub-message literals). This catches a dropped `{title}` before the test does.

## Parity guard change (exact)

`src/i18n/__tests__/locale-parity.test.ts` currently:

```ts
import en from "../../../messages/en.json";
import zh from "../../../messages/zh.json";
import ko from "../../../messages/ko.json";
const MESSAGES: Record<string, Messages> = { en: ..., zh: ..., ko: ... };
```

Add:

```ts
import ja from "../../../messages/ja.json";
const MESSAGES: Record<string, Messages> = { en: ..., zh: ..., ko: ..., ja: ja as Messages };
```

That's the only test edit — the key-set/non-empty/ICU-arg assertions already iterate `locales` from config, so they cover `ja` automatically once it's in the map. (The map exists precisely so a config-registered locale can't be silently skipped; leaving it out would make the guard throw `MESSAGES[loc]` undefined for `ja`.)

## Implementation order

1. **Task 1 — Register `ja` + generate `messages/ja.json`** (largest; no dependency). Includes the programmatic placeholder self-check.
2. **Task 2 — Extend parity guard + run full suite** (depends on Task 1; the test can only pass once `ja.json` is complete and registered). Also run `tsc`/lint.
3. **Task 3 — Focused quality self-check + switcher/auto-detect browser verification** (depends on Task 1; reads naturally after the translation exists).

## Risks & Mitigations

- **Risk: a placeholder dropped in a 1482-key hand translation.** *Mitigation:* Task 1's programmatic AST-based placeholder check + Task 2's parity guard both fail on any drift.
- **Risk: `en.json` gains keys before merge**, re-opening a gap. *Mitigation:* regenerate the key list at implementation time; the parity guard reds CI if `ja` is short even one key.
- **Risk: glossary inconsistency across 49 namespaces.** *Mitigation:* Task 3 does a terminology-consistency pass; the glossary table above is the single source of truth.
- **Risk: an ICU flatten produces invalid syntax.** *Mitigation:* follow the `zh`/`ko` precedent per key; the parser-based self-check would throw on an unparseable value; next-intl would surface it at runtime.
