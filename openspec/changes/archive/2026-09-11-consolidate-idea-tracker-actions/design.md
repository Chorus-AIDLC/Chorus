## Context

The Tracker panel owns edit, derive, move, delete and verify state. StartDevelopmentButton and YoloButton own stage/presence gating, errors, pin-then-wake cwd pickers and Yolo confirmation. The existing header/footer arrangement is being consolidated, not redesigned. The seven human answers are authoritative. The incumbent shadcn components, spacing and semantic theme tokens remain the visual system.

## Goals / Non-Goals

Goals: one header Actions entry plus Close; no permanent footer; visible disabled operations with reasons; link/UUID utilities; preserved mutation behavior, keyboard accessibility and confirmations.

Non-goals: task/proposal/legacy ideas panel redesign, generic cross-panel action framework, new permissions or wake semantics, Markdown summary/new-tab utilities, changing assignment/lineage/content controls inside tabs.

## Decisions

1. Use shadcn DropdownMenu, right aligned, localized Actions label and chevron. Group progression, editing/organization, clipboard utilities, and destructive Delete last. Do not embed interactive buttons inside menu items. Let menu width fit localized labels within narrow viewports.
2. Keep dialogs/pickers mounted outside the dropdown content lifecycle. Prefer an optional backwards-compatible trigger render adapter in existing stage-action components to reusing their logic; a local hook extraction is acceptable if default button behavior/tests remain unchanged. Selecting Yolo opens its existing confirmation; menu unmount must not destroy it or the cwd picker. Use explicit focus return to the Actions trigger after dialog close.
3. Menu items remain present but disabled for stage, offline, pending mutation, theme/container and edit-lock reasons. Do not turn absent permission into permission. Verify uses canVerifyElaboration; Start Development and Yolo reuse their shared predicates/presence resolution. Theme progression remains non-executable with a derive-instead reason. Pending operations cannot double-fire. Show reasons with tooltip and accessible description; support keyboard discovery rather than relying only on disabled elements' pointer events.
4. Edit Save/Cancel move into the form body. Hide the menu while editing, matching existing header editing behavior, and keep Close's existing cancel-edit semantics. Verify success/error feedback and container guidance move into the body/toasts, not a replacement footer.
5. Copy a canonical absolute Tracker URL for the current project and idea: `/projects/<projectUuid>/dashboard?panel=<ideaUuid>`. Exclude incidental search filters, tab, hash and unrelated query values. Copy UUID exactly. Await clipboard writes, catch missing/rejected Clipboard API and show translated errors without false success. No insecure legacy clipboard fallback is required.
6. Tests use actual Radix menu interactions where possible, plus shared control regression tests. Exercise tooltip accessibility, action availability, confirmation/cwd picker survival, clipboard success/failure, form controls and no footer. Browser verification covers English/Chinese, both themes, keyboard and narrow layouts.

## Risks / Trade-offs

- Radix focus and portal lifetimes can close a dialog accidentally → keep modal owners outside menu content and test keyboard activation/cancel.
- Disabled native menu items are skipped by keyboard → provide discoverable reasons using accessible descriptions and a focusable aria-disabled pattern with explicit event guards if needed; do not trigger mutations on Enter/Space/click.
- Reusing stage controls affects legacy consumers → optional rendering only; existing button mode retains visibility, purple Yolo styling and behavior.
- Header width and Chinese labels → truncate title, shrink-proof controls, viewport-constrained menu.
- Pencil MCP was not exposed in the headless environment; the owner explicitly waived design synchronization on 2026-09-11, so no encrypted `.pen` bytes are edited.

## Migration Plan

No schema or data migration. Deploy as frontend changes; rollback the scoped component/locale changes if necessary. No automatic PR push or merge. Archive OpenSpec only after all tasks are verified and mirror cumulative specs to Chorus.

## Open Questions

No remaining product decisions. The owner waiver removes Pencil synchronization from the delivery scope.
