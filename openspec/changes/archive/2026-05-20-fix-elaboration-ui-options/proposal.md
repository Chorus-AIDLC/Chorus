## Why

The Elaboration answer panel (`src/components/elaboration-panel.tsx`) is the surface every PM Agent and human collaborator hits during requirements gathering — and it has two friction bugs that show up on every comprehensive (10-15 question) round:

1. **Long option labels truncate.** The option button is built on top of shadcn `Button`, which defaults to `whitespace-nowrap`. Any label longer than the panel width gets cut off, so the user picks an option without seeing the full text.
2. **The "Other" free-text path has no inline confirm.** When the user picks Other, they type into the input and have nothing to do but reach for the right-arrow chevron at the top of the card. There is no inline confirm button, and pressing Enter does nothing — so a one-handed flow ("type, Enter, next question") is not possible.

The cumulative effect on a 10-question elaboration is enough friction that PM Agents have started preferring `chorus_pm_skip_elaboration` even when elaboration would help. This change removes the friction without touching the data model or any MCP tool.

## What Changes

- **Wrap long option labels.** Apply `whitespace-normal` + `break-words` to the label/description spans so the option button height grows with the content. Both labels and descriptions wrap; selection chevron stays right-aligned at the top.
- **Add an inline ✓ confirm button to the Other input row.** When Other is selected and the input is shown, render a small icon button to the right of the input. Clicking it commits the current `customText` and auto-advances to the next question — same effect as picking a regular option. The button is `disabled` when the input is empty (after `.trim()`).
- **Bind Enter to the same confirm action** while the Other input has focus. Enter submits the current answer and auto-advances. Identical effect to clicking ✓.
- **Suppress confirm/Enter on the last question.** When the user is on the last question and Other is selected, the inline ✓ MUST be hidden (or disabled) and the Enter key MUST do nothing in the input. The user is forced to click the bottom-right "Submit Answers" button to commit the whole round, which prevents accidental whole-round submission via stray Enter.
- **i18n.** Add an aria-label key for the confirm button under `elaboration.*` in both `messages/en.json` and `messages/zh.json`.

Non-goals: redesigning the panel layout, supporting multi-select on a single question, undo, mobile-specific behavior beyond the wrap (the wrap already addresses small screens).

## Capabilities

### New Capabilities

- `elaboration-answer-ui`: client-side affordance contract for the elaboration answer panel — covers long-option wrap behavior, Other-input inline confirm button, Enter-to-advance, last-question Enter suppression, and the i18n keys for the confirm aria-label.

### Modified Capabilities

(none — no backend or MCP-tool change)

## Impact

- **Updated file**: `src/components/elaboration-panel.tsx` — wrap option spans; add inline confirm icon button + Enter `onKeyDown` handler in the Other branch; gate confirm/Enter on last-question.
- **Updated files**: `messages/en.json`, `messages/zh.json` — add `elaboration.confirmAnswerAria` key.
- **No backend change**: the `chorus_answer_elaboration` payload is unchanged. Submission of the whole round still happens via `submitElaborationAnswersAction` exactly as today.
- **No data-model change**: no Prisma schema edit, no new MCP tool.
- **Risks**: the behavior of Enter inside an input is normally "submit form"; the panel is not in a `<form>` element, so we control it. Risk is suppressed by an explicit `e.preventDefault()` in the Enter handler.
