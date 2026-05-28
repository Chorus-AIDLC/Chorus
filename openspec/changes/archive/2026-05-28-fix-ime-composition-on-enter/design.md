# Design: IME composition guard

## Context

React's `onKeyDown` fires during IME composition. `KeyboardEvent.key` is `"Enter"` and `KeyboardEvent.keyCode` is `229` while a candidate word is being chosen. If the handler runs its submit logic on Enter without checking, the form submits, the dialog closes, and the user loses their in-progress text — exactly what GitHub issue #280 reports.

The standard fix is one line: check `event.nativeEvent.isComposing` (or `keyCode === 229` as a Safari/legacy fallback) and bail out early. The decision driving this proposal is *where* that line lives.

## Decision: a `lib/ime.ts` helper, not inline, not a hook

Three options were on the table:

1. **inline** `if (e.nativeEvent.isComposing) return;` in each of the 7 handlers.
2. **helper** `isImeComposing(e)` exported from `src/lib/ime.ts`.
3. **higher-order hook** `useEnterSubmit(callback)` that wraps the whole `Enter && !shiftKey && callback()` pattern.

Helper wins. Inline duplicates the same condition 7 times and gives no test surface — if the detection condition ever needs adjusting (a new browser quirk, mobile IME), there are 7 places to update. Higher-order hook over-fits: the 7 handlers are not all identical (mention-editor needs `!popupRef.current && onSubmit`, global-search calls `navigateToResult(results[selectedIndex])`, elaboration's "Other" needs `!shiftKey && !ctrlKey && !metaKey`). Folding all of them through one hook would require either a permissive callback signature that re-implements the differences inside the callback (no readability win) or N variant hooks (worse than inline). Helper sits at the right level: each handler keeps its own logic; only the shared bit — IME detection — is shared.

## `isImeComposing` contract

```typescript
export function isImeComposing(
  e: React.KeyboardEvent | KeyboardEvent
): boolean {
  const native = "nativeEvent" in e ? e.nativeEvent : e;
  return native.isComposing || e.keyCode === 229;
}
```

- Accepts both React synthetic events and raw DOM `KeyboardEvent` (the Tiptap `handleKeyDown` callback receives a raw event, not a React one).
- `nativeEvent.isComposing` is the W3C UI Events condition; supported by Chrome, Firefox, Safari, Edge.
- `keyCode === 229` is the legacy condition retained for Safari < 13 historical bug where `isComposing` was unreliable, and as a belt-and-suspenders signal in environments where `nativeEvent.isComposing` is missing. The cost of keeping it is one `||` operand and zero risk: `keyCode` is `229` only during composition.
- Pure function, no closures, no state. Deterministic on the input event.

## Per-handler integration shape

The pattern at every call site is identical:

```typescript
onKeyDown={(e) => {
  if (isImeComposing(e)) return;
  if (e.key === "Enter" && /* existing condition */) {
    /* existing body */
  }
}}
```

For `mention-editor.tsx:479` (Tiptap `editorProps.handleKeyDown` — receives `(view, event: KeyboardEvent)`):

```typescript
handleKeyDown: (_view, event) => {
  if (isImeComposing(event)) return false;
  if (event.key === "Enter" && !event.shiftKey && !popupRef.current && onSubmit) {
    event.preventDefault();
    onSubmit();
    return true;
  }
  return false;
}
```

For `mention-editor.tsx:288` (Tiptap suggestion popup) the early return is `return false` (let Tiptap handle the keystroke through to the editor — the IME composition needs to flow through to confirm the candidate, not be swallowed by the popup):

```typescript
if (isImeComposing(event)) return false;
if (event.key === "Enter") { /* existing select-mention */ }
```

For `mention-editor.tsx:288`, returning `false` (rather than `true`) is critical: returning `true` tells Tiptap "I handled this, don't propagate," which would prevent the IME from completing its candidate confirmation. The browser needs the keystroke to flow naturally to the IME during composition.

## Testing strategy

| Layer | Coverage |
|---|---|
| `src/lib/__tests__/ime.test.ts` | helper truth table: composing=true → true; keyCode=229 → true; Enter+!composing → false; non-Enter → false; React event vs raw event input shapes |
| `src/components/__tests__/create-project-group-dialog.test.tsx` | (issue origin) typing then pressing Enter while `nativeEvent.isComposing=true` does NOT call `handleSubmit`; same press with `isComposing=false` DOES call it |
| `src/components/__tests__/global-search.test.tsx` | (highest CJK exposure) Enter during composition does NOT call `navigateToResult`; Enter outside composition DOES |

Per the elaboration decision, the remaining 5 handlers are validated by the helper's own unit tests + the convention in CLAUDE.md, not individual component tests.

## Defense-in-depth: `CLAUDE.md` convention

Add one bullet under "Frontend UI Rules" so any future agent or human writing a new `onKeyDown` Enter handler knows the contract: route the IME check through `isImeComposing` rather than inlining or omitting it. This is cheap (1 line of doc) and matches how the existing i18n + shadcn/ui rules in that section are framed (assertions, not tooling).

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Helper misses an event shape (e.g., a wrapper that exposes a synthetic-like object without `nativeEvent`) | Type signature accepts both forms; runtime `"nativeEvent" in e` narrowing handles synthetic vs raw |
| Tiptap framework already filters composing events, so adding the guard is redundant | Verified by reading the Tiptap source path used here: `editorProps.handleKeyDown` and the suggestion plugin both forward raw KeyboardEvents during composition. Guard is needed. |
| Future onKeyDown handlers added without the guard | CLAUDE.md convention + the fact that all current handlers go through one helper makes drift visible in code review |

## Out of scope (deferred, not lost)

- Mobile virtual keyboard IME testing (different platform event shapes; needs device matrix).
- Cmd/Ctrl+K and other global shortcuts (separate concern: those don't conflict with IME the same way).
- ESLint custom rule for `onKeyDown` patterns (high implementation cost; revisit if regressions reappear).
