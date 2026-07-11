# Technical Design: Complete Korean locale coverage

## Overview

Three coordinated pieces of work, all on the app's `messages/` i18n surface:

1. **Data backfill** — add 42 missing keys to `messages/ko.json` (pure translation, no code).
2. **Quality review** — focused proofread of Korean strings.
3. **Parity guard** — a Vitest test enforcing key-set + ICU-placeholder equality across `en` / `zh` / `ko`, plus removing `zh`'s orphan `ideas.completed`.

There is **no runtime code change**: the locale plumbing (`src/i18n/config.ts` `locales` array already lists `ko`, `src/i18n/request.ts`, `src/contexts/locale-context.tsx`) and both switchers (`src/app/(dashboard)/settings/page.tsx`, `src/components/sidebar-preferences.tsx`) already iterate `locales` dynamically, so `ko` is picked up automatically. The switcher work is verification only.

## The 42 missing keys (authoritative list)

Grouped by namespace, with English source values. The translator must preserve every `{placeholder}` verbatim.

### `theme.*` (4 — dark-mode toggle, PR #414/#417)
| key | en |
|---|---|
| `theme.toggleLabel` | "Theme" |
| `theme.light` | "Light" |
| `theme.dark` | "Dark" |
| `theme.system` | "System" |

### `references.*` (25 — reference artifacts, PR #418)
| key | en |
|---|---|
| `references.title` | "References" |
| `references.empty` | "Link official docs, a reference implementation, or an issue thread to ground this in evidence." |
| `references.loading` | "Loading references..." |
| `references.add` | "Add" |
| `references.addReference` | "Add reference" |
| `references.editReference` | "Edit reference" |
| `references.deleteReference` | "Delete reference" |
| `references.deleteConfirm` | "This will permanently remove the reference \"{title}\". This action cannot be undone." |
| `references.typeLabel` | "Type" |
| `references.typeDocs` | "Docs" |
| `references.typeRepo` | "Repository" |
| `references.typeIssuePr` | "Issue / PR" |
| `references.typePaperBlog` | "Paper / Blog" |
| `references.urlLabel` | "URL" |
| `references.urlPlaceholder` | "https://example.com/..." |
| `references.urlRequired` | "URL is required" |
| `references.titleLabel` | "Title" |
| `references.titlePlaceholder` | "Enter a short title" |
| `references.titleRequired` | "Title is required" |
| `references.notesLabel` | "Notes" |
| `references.notesPlaceholder` | "Optional summary or why this is relevant" |
| `references.addFailed` | "Failed to add reference" |
| `references.updateFailed` | "Failed to update reference" |
| `references.deleteFailed` | "Failed to delete reference" |
| `references.countLabel` | "{count, plural, one {# reference} other {# references}}" |

### `ideaTracker.lineage.* / ideaTracker.newIdea.*` (9 — container/theme idea + decompose)
| key | en |
|---|---|
| `ideaTracker.lineage.container` | "Theme" |
| `ideaTracker.lineage.containerDescription` | "A theme groups related child ideas and sets shared direction. It can elaborate, but the real work happens in the ideas you derive from it — a theme doesn't write its own proposal." |
| `ideaTracker.lineage.containerBadge` | "Theme" |
| `ideaTracker.lineage.typeIdea` | "IDEA" |
| `ideaTracker.lineage.typeTheme` | "THEME" |
| `ideaTracker.lineage.makeContainer` | "Make this a theme" |
| `ideaTracker.lineage.containerHint` | "Themes move forward by deriving child ideas." |
| `ideaTracker.lineage.childrenDone` | "{done}/{total} done" |
| `ideaTracker.newIdea.decompose` | "Help me break this into child ideas" |
| `ideaTracker.newIdea.decomposeHint` | "Creates a theme and asks the agent to propose child ideas for you to confirm." |

### `graph.zoom.*` (3 — graph zoom controls)
| key | en |
|---|---|
| `graph.zoom.in` | "Zoom in" |
| `graph.zoom.out` | "Zoom out" |
| `graph.zoom.fit` | "Fit to view" |

> Count note: the reference table above lists 42 leaf keys total (4 + 25 + 3 = 32 under theme/references/graph, plus 10 under ideaTracker — the diff tool reports 42 because `ideaTracker` contributes 10, not 9; the implementer must reconcile against the live diff, not this prose count). **Source of truth is the runtime diff** (see Task 1 AC), not this document — regenerate it at implementation time in case `en.json` shifts again before merge.

## ICU placeholder rules

- `{title}`, `{count}`, `{done}`, `{total}` must appear **unchanged** in the Korean string.
- `references.countLabel` uses an ICU `plural` block. Korean has no grammatical plural (like Chinese). Follow the `zh.json` precedent: flatten to a single natural phrasing using the bare `{count}` placeholder rather than duplicating `one`/`other`. This is compatible with the parity guard: the ICU-aware extractor (see below) captures the argument name `count` from BOTH the `{count, plural, ...}` en source AND the flattened `{count}` locale value, so both sides yield the argument set `{count}`. Verify the chosen phrasing matches how `zh.json` handles the same key.

## Terminology (match #411's established glossary)

아이디어 (idea), 제안 (proposal), 작업 (task), 문서 (document), 에이전트 (agent), 구체화 (elaboration), 수락 기준 (acceptance criteria). "Theme" (container idea) should reuse whatever term #411/zh uses for the container concept if present; otherwise pick a natural Korean term and apply it consistently to `ideaTracker.lineage.container`, `containerBadge`, `typeTheme`, `makeContainer`.

## Parity guard design

Generalize the existing narrow `src/i18n/__tests__/report-locale-keys.test.ts` (which pins 3 specific keys in en+zh) into a full-coverage parity test. New test file (e.g. `src/i18n/__tests__/locale-parity.test.ts`):

1. **Flatten** each of `en.json`, `zh.json`, `ko.json` to a dotted-key → value map (recursive walk, same `resolveDeep`-style helper).
2. **Key-set equality**: assert `keys(zh) === keys(en)` and `keys(ko) === keys(en)` as sets. On failure, list the symmetric difference (missing + extra) per locale so the message is actionable.
3. **No empty values**: assert every leaf value is a non-empty (trimmed) string in every locale.
4. **Named-argument equality**: for each key, extract the set of named ICU arguments and assert the set matches `en`'s for that key. This catches a translator dropping `{title}` or `{count}`.

   > **⚠️ Extract from the ICU AST, NOT a brace regex.** Two regexes were considered and BOTH are wrong:
   > - `/\{(\w+)\}/g` matches only bare `{name}` — extracts **nothing** from `{count, plural, ...}`.
   > - `/\{\s*(\w+)\s*[,}]/g` fixes that but still over-extracts: it captures literal words inside plural/select sub-messages. Live example: `en` `proposalValidation.errorCount` = `"{count} {count, plural, one {error} other {errors}}"` → the regex yields `{count, error, errors}`, but the only real argument is `count`, and a correct ko flatten `"오류 {count}개"` yields `{count}` → the sets falsely differ → CI reds on an already-shipped-correct key. Confirmed during Task 1 on 4 live keys: `tasks.blockedTooltip`, `proposalValidation.errorCount`, `proposalValidation.warningCount`, `onboarding.completion.permissionsCount`.
   >
   > The only robust extractor parses the message and collects element argument names:
   >
   > ```ts
   > import { parse, TYPE } from "@formatjs/icu-messageformat-parser"; // transitive dep via next-intl
   > function namedArgs(message: string): Set<string> {
   >   const out = new Set<string>();
   >   const walk = (nodes: any[]) => {
   >     for (const n of nodes) {
   >       if (n.type === TYPE.argument || n.type === TYPE.number || n.type === TYPE.date || n.type === TYPE.time) {
   >         out.add(n.value);
   >       } else if (n.type === TYPE.plural || n.type === TYPE.select) {
   >         out.add(n.value);
   >         for (const opt of Object.values<any>(n.options)) walk(opt.value);
   >       } else if (n.type === TYPE.tag) {
   >         walk(n.children);
   >       }
   >     }
   >   };
   >   walk(parse(message));
   >   return out;
   > }
   > ```
   >
   > Verified against the live messages: this yields identical argument sets for en vs ko across ALL 1482 keys (0 mismatches, 0 parse errors), including every ICU-plural key. A parse error on any locale value should itself fail the test (a malformed ICU string is a real bug). `@formatjs/icu-messageformat-parser` is resolvable today (`require.resolve` succeeds) as a transitive dependency of `next-intl`; if a reviewer prefers not to rely on a transitive dep, add it as an explicit `devDependency` (same version next-intl already pins) — do not fall back to a regex.
5. Drive the locale list from `src/i18n/config.ts` `locales` so the test auto-covers any future 4th locale.

Decide whether to keep, fold, or delete the old `report-locale-keys.test.ts`: the full parity test subsumes its key-existence checks, but it also asserts specific en values (`"Report"`, `"REPORTS"`) that are UI contracts — keep those value-specific assertions (either in place or migrated), drop only the now-redundant existence loop.

To reach parity, `zh.json`'s `ideas.completed` (unused in code — grep-verified, no `t("ideas.completed")` call site) must be **removed**, not added to en+ko, since nothing references it.

## Implementation order

1. Backfill + quality review `ko.json` (Task 1) — largest, no dependency.
2. Parity guard test + `zh` orphan removal (Task 2) — depends on Task 1 (test must be green once ko is complete; if written first it fails until backfill lands, which is fine for TDD but the merged state needs both).
3. Switcher browser verification (Task 3) — independent; can run in parallel, but its AC references the completed ko strings so it reads naturally after Task 1.

## Risks & Mitigations

- **Risk: `en.json` gains new keys before this merges**, re-widening the gap. *Mitigation:* Task 1 AC regenerates the diff at implementation time; Task 2's guard will fail CI if anything is still missing — so the guard itself is the backstop.
- **Risk: translator "fixes" an ICU `plural` block into invalid syntax.** *Mitigation:* follow zh precedent exactly for `countLabel`; parity test checks placeholder names; next-intl compile would surface a malformed block at runtime.
- **Risk: parity test is too strict and blocks an intentional locale-specific key.** *Mitigation:* the project convention (CLAUDE.md) is that every UI string exists in *both/all* locales — there is no legitimate single-locale key, so strict equality is correct. Document this in the test header.
