# Fix IME composition on Enter for all input fields

## Why

GitHub Issue [#280](https://github.com/Chorus-AIDLC/Chorus/issues/280) reports that creating a new Project Group with a Chinese IME breaks: pressing Enter to confirm a candidate word triggers form submission instead, the dialog closes, and the user loses their input mid-typing.

A full scan of `src/` shows this is not a localized regression — there are **7 input handlers** across 6 components that listen for `Enter` and execute submit / navigate / next-step actions without first checking IME composition state. None of them are protected today. Any user typing with Chinese, Japanese, or Korean IME will hit at least one of these on every interaction with the affected dialogs.

## What Changes

- **ADDED** capability `frontend-input` with a single normative requirement: every keyboard handler that treats `Enter` as a submit/action key MUST first check IME composition state and short-circuit during composition.
- New `src/lib/ime.ts` exporting `isImeComposing(e: React.KeyboardEvent | KeyboardEvent): boolean`. Detection: `e.nativeEvent.isComposing || e.keyCode === 229` (covers modern browsers + Safari historical bug).
- 7 onKeyDown handlers updated to call `isImeComposing(e)` before treating Enter as submit:
  1. `src/components/mention-editor.tsx:288` — Tiptap mention popup Enter-to-select
  2. `src/components/mention-editor.tsx:479` — Tiptap main editor onSubmit
  3. `src/components/create-project-group-dialog.tsx:103` — Issue #280 origin
  4. `src/components/create-project-dialog.tsx:118` — Project create
  5. `src/components/global-search.tsx:234` — Global search Enter-to-navigate
  6. `src/components/elaboration-panel.tsx:374` — "Other" answer Enter-to-next
  7. `src/app/(dashboard)/projects/[uuid]/dashboard/new-idea-dialog.tsx:87` — New Idea title
- Vitest tests: helper unit tests + keydown behavior tests for `create-project-group-dialog` (issue origin) and `global-search` (highest IME exposure).
- `CLAUDE.md` Frontend UI Rules section gains one bullet: any new Enter-as-submit handler must call `isImeComposing` first.

## Capabilities

- `frontend-input` (new): IME composition handling contract for input keyboard handlers.

## Impact

- **User-facing:** CJK IME users no longer get their dialogs closed mid-composition. No change for English/non-IME users (`isImeComposing` returns `false`).
- **Code:** +1 helper file (~15 LoC), 7 one-line guards added, 1 doc bullet. No API change, no schema change, no behavior change outside IME composition.
- **Risk:** very low. Helper is a pure function over event properties. Adding the guard cannot newly break a non-composing path; it can only add an early return for the composing path.
- **Out of scope:** mobile virtual keyboard IME, global keyboard shortcuts (Cmd+K and friends), ESLint custom rule.
