## Architecture

This is a single-component, client-only change. All work lives in `src/components/elaboration-panel.tsx`. No service-layer, MCP, REST, Prisma, or i18n-config changes beyond two new translation keys.

### Component map

```
ElaborationPanel
└── RoundCard
    └── PendingRoundContent          ← all changes happen inside this branch
        ├── question text + nav (left/right chevron, Enter is NOT bound here)
        ├── options list             ← long-option wrap fix lives here
        │     └── Button (label / description spans get whitespace-normal)
        ├── Other input row          ← inline ✓ confirm button + Enter handler live here
        │     ├── pencil icon (toggles Other)
        │     ├── Input              ← onKeyDown for Enter
        │     └── ✓ icon button      ← new
        └── footer (category + Submit Answers big button — unchanged)
```

`AnsweredRoundContent` is read-only Q/A text and is not in scope.

## Data flow

The component already keeps round answers in local state:

```
answers: Record<questionId, AnswerInput>
AnswerInput { questionId, selectedOptionId, customText }
```

A regular option click goes through `handleSelectOption(questionId, optionId)`:

1. write `selectedOptionId: optionId, customText: null` into local state,
2. schedule `goTo(currentIndex + 1, "left")` after `SLIDE_ANIMATION_MS`.

Picking the Other "option" (`optionId === OTHER_OPTION_ID`) writes `selectedOptionId: null, customText: prev?.customText ?? ""` and **does not** auto-advance — that is the behavior we are extending.

This change adds a new local function `handleConfirmOther(questionId)` (or inlines the same effect):

1. Read the current `customText` from `answers[questionId]`.
2. If `customText` is missing or `.trim()` is empty → no-op.
3. If `currentIndex === questions.length - 1` (last question) → no-op (the user must use the bottom-right Submit Answers button).
4. Otherwise → schedule `goTo(currentIndex + 1, "left")` after `SLIDE_ANIMATION_MS`. The state already has the `customText`, so nothing new needs to be written.

The ✓ icon button calls `handleConfirmOther`; the Input's `onKeyDown` calls `handleConfirmOther` when `e.key === "Enter"`, after `e.preventDefault()`.

Whole-round submission stays exactly as today — `Submit Answers` → `submitElaborationAnswersAction` with `Object.values(answers)`.

## UI contract

### Option label / description wrap

The current option button uses `flex w-full items-center justify-between … h-auto`. The label / description spans inherit `whitespace-nowrap` from shadcn `Button`. Fix: apply `whitespace-normal break-words` directly on the inner text spans (lines ~424-432). Container width comes from the parent panel — no width adjustment needed. The `ArrowRight` indicator stays right-aligned via `justify-between`; with multi-line text we keep the icon top-aligned (`items-start` on the right column) so it doesn't visually drift mid-line on tall labels.

### Inline ✓ button

Lives inside the Other row, to the right of the `<Input>`, only when `isOtherSelected` is true. Visual style mirrors the up/down chevron buttons in the question header:

- shadcn `Button variant="ghost" size="icon"`,
- `Check` icon from `lucide-react` (already a peer dep),
- `h-7 w-7`, neutral text color matching `#6B6B6B`,
- `disabled` when `(answers[question.questionId]?.customText ?? "").trim() === ""`,
- `aria-label` from `t("confirmAnswerAria")`.

When the panel is on the **last question**, the ✓ button is hidden entirely (don't disable, hide). Hiding is preferred to disabling so the user is not confused into thinking the button is just temporarily unavailable — the bottom-right Submit Answers button is what they need.

### Enter handler

The Input gets a new `onKeyDown` handler:

```ts
function handleOtherInputKeyDown(e) {
  if (e.key !== "Enter") return;
  if (e.shiftKey || e.ctrlKey || e.metaKey) return;     // leave modifiers free
  e.preventDefault();
  if (currentIndex === questions.length - 1) return;    // last-question suppression
  handleConfirmOther(question.questionId);
}
```

`preventDefault()` is required because the input is `type="text"`. Although the panel is not inside a `<form>`, some browsers still emit the form-submit event when an input is the only one in its accessibility tree; preventing default is cheap insurance.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Wrap breaks the existing single-line aesthetic on common short labels | `whitespace-normal` only matters when content is long. Short labels render identically. |
| Enter inside the input accidentally triggers ancestor `Collapsible` toggle | The Collapsible trigger is a sibling button, not an ancestor of the input. `e.preventDefault()` on Enter further insulates us. |
| User holds Enter and rapidly advances through multiple questions | Acceptable — same as auto-advance on regular option click, which is already a single click. The user can still go back via the left chevron. |
| Confirm fires while an animation is in flight | Same `setTimeout(..., SLIDE_ANIMATION_MS)` guard the existing path uses — no new race. |
| New i18n key falls back to the key string when missing | We add the key to BOTH `en.json` and `zh.json` in this change; CI grep test enforced. |

## Out of scope

- Multi-line free-text answer (would require switching `<Input>` to `<Textarea>` and changing Enter semantics).
- Validation of `customText` content beyond emptiness.
- Visual redesign of the panel itself.
- Mobile-specific layout — the wrap fix already addresses the worst case.
