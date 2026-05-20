# elaboration-answer-ui Specification

## Purpose
TBD - created by archiving change fix-elaboration-ui-options. Update Purpose after archive.
## Requirements
### Requirement: Long option labels SHALL wrap to multiple lines instead of truncating

When an `ElaborationQuestion.option.label` or `option.description` is longer than the available row width inside the elaboration panel, the option button MUST render the text on multiple lines and grow its height to fit the content.

#### Scenario: Option label longer than panel width

- **GIVEN** an elaboration round is in `pending_answers` and the user is viewing a question whose first option has a label of ~120 characters
- **WHEN** the question is rendered inside `PendingRoundContent`
- **THEN** the option button MUST render the full label text without horizontal truncation or `text-overflow: ellipsis`
- **AND** the rendered label span MUST have CSS `white-space: normal` (or equivalent — i.e. NOT `nowrap`)
- **AND** the rendered label span MUST allow long unbroken tokens to wrap (`overflow-wrap: break-word` or `word-break: break-word`)
- **AND** the option button height MUST grow to contain all rendered lines (no clipping, no scroll within the button)

#### Scenario: Short option labels still render on a single line

- **GIVEN** a question whose options all have labels under 30 characters
- **WHEN** the question is rendered
- **THEN** each option button MUST render its label on a single visible line (no spurious wrapping)
- **AND** the visual height of each option button MUST be unchanged from the pre-change baseline (modulo sub-pixel rendering)

### Requirement: The Other input row SHALL show an inline confirm button when an answer is being typed

When the user has selected the synthetic Other option on a non-last question, the elaboration panel MUST render an inline confirm button to the right of the Other text input. The button MUST be disabled while the input is empty, and clicking it MUST commit the current `customText` answer and auto-advance to the next question.

#### Scenario: User selects Other and the inline confirm button appears

- **GIVEN** a question with at least one regular option AND the user clicks the pencil/Other affordance to select Other
- **WHEN** the Other row enters its input mode
- **THEN** an inline confirm icon button MUST be rendered to the right of the `<Input>` in the same Other row
- **AND** the icon button MUST use the `Check` icon from `lucide-react`
- **AND** the icon button MUST carry an accessible label sourced from `t("elaboration.confirmAnswerAria")`
- **AND** the icon button MUST be `disabled` when `(answers[question.questionId]?.customText ?? "").trim() === ""`

#### Scenario: User clicks the inline confirm button with non-empty text on a non-last question

- **GIVEN** Other is selected on question N (where N is not the last question)
- **AND** the user has typed `"hybrid approach"` into the Other input
- **WHEN** the user clicks the inline confirm icon button
- **THEN** local state for that question MUST already be `{ selectedOptionId: null, customText: "hybrid approach" }` (it was set on each keystroke)
- **AND** the panel MUST advance to question N+1 within `SLIDE_ANIMATION_MS` (~200ms)
- **AND** no network request to `submitElaborationAnswersAction` MUST be issued by this click — the round is only submitted via the bottom-right Submit Answers button

#### Scenario: User clicks the inline confirm button with empty text

- **GIVEN** Other is selected and the input value (post-`.trim()`) is empty
- **WHEN** the user clicks the inline confirm icon button
- **THEN** the click MUST be a no-op — no state change, no advance, no network call
- **AND** the button MUST be visually `disabled` to communicate this

### Requirement: Pressing Enter inside the Other input SHALL behave like clicking the inline confirm button

While the Other input has focus, pressing the Enter key (without modifier keys) MUST have the same effect as clicking the inline confirm icon button — commit current `customText` and auto-advance, subject to the same emptiness and last-question rules.

#### Scenario: User presses Enter with non-empty text on a non-last question

- **GIVEN** Other is selected on question N (not last)
- **AND** the user has typed `"my answer"` into the Other input
- **WHEN** the user presses Enter without holding Shift / Ctrl / Meta
- **THEN** the keystroke MUST call `e.preventDefault()`
- **AND** the panel MUST advance to question N+1
- **AND** no network request MUST be issued

#### Scenario: Enter with empty text is a no-op

- **GIVEN** Other is selected and the input value (post-`.trim()`) is empty
- **WHEN** the user presses Enter
- **THEN** the keystroke MUST call `e.preventDefault()`
- **AND** the panel MUST NOT advance
- **AND** no network request MUST be issued

#### Scenario: Enter with a modifier key is left to default behavior

- **GIVEN** Other is selected
- **WHEN** the user presses Shift+Enter, Ctrl+Enter, or Meta+Enter
- **THEN** the new keydown handler MUST NOT call `preventDefault`
- **AND** the panel MUST NOT advance based on this keystroke

### Requirement: On the last question with Other selected, Enter and the inline confirm SHALL be suppressed

To prevent accidental whole-round submission via stray Enter or icon-button clicks when the user means to type more, the inline confirm button MUST be hidden and the Enter key MUST be a no-op when the user is on the last question of the round and Other is selected. The user is forced to click the bottom-right Submit Answers button explicitly.

#### Scenario: Last question with Other selected — confirm button is hidden

- **GIVEN** a round whose `currentIndex === questions.length - 1` and Other is selected on that question
- **WHEN** the Other input mode renders
- **THEN** the inline confirm icon button MUST NOT be rendered in the DOM (hidden, not just `disabled`)

#### Scenario: Last question with Other selected — Enter does nothing

- **GIVEN** the same state as above
- **WHEN** the user presses Enter inside the Other input
- **THEN** the new keydown handler MUST call `e.preventDefault()`
- **AND** MUST NOT advance the panel
- **AND** MUST NOT trigger `submitElaborationAnswersAction`
- **AND** the user MUST still be able to click the bottom-right Submit Answers button to submit the whole round

### Requirement: The new aria-label string SHALL be available in both English and Chinese locales

The translation key `elaboration.confirmAnswerAria` MUST be present in both `messages/en.json` and `messages/zh.json` and MUST be referenced via `useTranslations("elaboration")` rather than hardcoded.

#### Scenario: i18n key coverage

- **WHEN** a reviewer greps `messages/en.json` and `messages/zh.json` for `confirmAnswerAria`
- **THEN** the key MUST be present in BOTH locale files
- **AND** the value in each file MUST be a non-empty string
- **AND** the string `confirmAnswerAria` MUST NOT appear hardcoded inside any `.tsx` file under `src/` (only via `t("confirmAnswerAria")`)

