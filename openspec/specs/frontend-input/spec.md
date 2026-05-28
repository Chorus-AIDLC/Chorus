# frontend-input Specification

## Purpose
TBD - created by archiving change fix-ime-composition-on-enter. Update Purpose after archive.
## Requirements
### Requirement: Enter-as-submit handlers SHALL ignore IME composition

Any frontend keyboard handler that treats the `Enter` key as a submit, navigate, advance, or confirm action SHALL short-circuit when the keystroke is part of an IME (Input Method Editor) composition session, so that CJK and other IME users can confirm candidate words without unintentionally triggering the action.

A keystroke is considered part of an IME composition session when **either** condition holds on the keyboard event:

- `event.nativeEvent.isComposing === true` (W3C UI Events; modern browsers), or
- `event.keyCode === 229` (legacy / Safari historical fallback).

The check SHALL be performed via the shared helper `isImeComposing(e)` exported from `src/lib/ime.ts`. Inline duplication of the condition is not permitted in new code; existing handlers SHALL be migrated to the helper.

#### Scenario: Chinese IME candidate confirmation in Project Group create dialog

- **WHEN** a user opens the "Create Project Group" dialog, types pinyin into the name `Input`, and presses `Enter` to confirm a Chinese IME candidate (so the keyboard event has `nativeEvent.isComposing === true`)
- **THEN** the dialog SHALL NOT submit, the dialog SHALL remain open, and the in-progress text SHALL be preserved

#### Scenario: Plain Enter still submits when not composing

- **WHEN** a user types ASCII text into the same name `Input` and presses `Enter` while no IME composition is active (`nativeEvent.isComposing === false` and `keyCode !== 229`)
- **THEN** the dialog SHALL submit as before — the IME guard SHALL NOT regress the non-IME path

#### Scenario: Tiptap mention editor during composition

- **WHEN** a user types into a `MentionEditor` with `onSubmit` configured, and presses `Enter` mid-IME-composition (`nativeEvent.isComposing === true`)
- **THEN** `onSubmit` SHALL NOT be called and the editor SHALL allow the IME to confirm the candidate naturally; the editor SHALL NOT consume the event (`handleKeyDown` returns `false`) so the keystroke flows through to the IME

#### Scenario: Global search Enter-to-navigate during composition

- **WHEN** a user types a Chinese query into the global search input, sees results, and presses `Enter` mid-composition to confirm a candidate (`nativeEvent.isComposing === true`)
- **THEN** `navigateToResult` SHALL NOT be called and the page SHALL NOT navigate; pressing `Enter` again outside composition SHALL navigate as before

#### Scenario: Helper accepts both React synthetic and raw DOM KeyboardEvent

- **WHEN** `isImeComposing` is called with either a `React.KeyboardEvent` (from a React `onKeyDown` prop) or a raw `KeyboardEvent` (from Tiptap's `editorProps.handleKeyDown` callback)
- **THEN** the helper SHALL return the same boolean result for equivalent events; consumers SHALL NOT need to unwrap or normalize the event before calling the helper

