## Context

The group header opens one shared CreateProjectDialog. Its handleSubmit awaits cwd validation before entering a React transition; the button remains enabled during validation. Enter directly invokes handleSubmit without checking pending/success. The API creates one new project per request.

## Goals / Non-Goals

Prevent overlapping attempts originating in this dialog while preserving ordinary creation, cwd errors, input-method handling and group selection. Do not add global same-name uniqueness, server idempotency keys, or destructive duplicate cleanup.

## Decisions

Use a synchronous ref as the mutual-exclusion guard, acquired before the first await. Pair it with rendered busy state covering validation and request work. Both click and Enter must use the same guarded submission function. Use the existing creating copy and indicator. Snapshot the submitted inputs/group at attempt start.

Keep the guard through the existing 600ms success feedback and release only once the successful dialog has closed/reset. During an attempt disable cancel and suppress Escape/outside dismissal; prevent stale completion timers from affecting a new dialog or unmounted component. On validation failure (including rejection), request rejection, or API error, release the guard and show the existing appropriate error while preserving drafts. A reopened dialog after completion must accept a fresh submission.

Preserve IME composition guards and whitespace validation. Same project names remain valid across separate successful operations. No request is automatically retried on ambiguous network failure; manual retry retains current behavior.

## Risks

A React state flag alone is insufficient against same-tick events. Releasing at POST completion is insufficient during success feedback. A guard held after an error could permanently disable creation. Unmounting during the timer must not refresh or close a later dialog. Tests must exercise these boundaries, not just the button disabled attribute.

## Validation

Use controlled validation and fetch promises to assert exactly one validation sequence and at most one POST under repeated events, and compare payloads. Cover rapid clicks, repeated Enter and mixed entry points during validation/request/success; ordinary submission with groupUuid/cwd payload; blank title and IME; validation null/rejection, API error, network failure and retry; dismissal protection and reopening after success. Run related component tests, lint for changed code and typecheck. Verify the running local UI in a browser with isolated disposable data or intercepted project POSTs, both themes. Record any environment limitations accurately.

## Rollout

No migration. Ship the component fix through ordinary release. Do not push/merge without explicit approval.

The requester explicitly waived Pencil/design.pen synchronization for this bug fix on 2026-09-24 (Idea comment 0683e158-87ed-47a4-ad27-ab4aefecc4a9: “不用管pencil，继续推进chorus流程”). Accordingly, the former design-sync AC5 is removed from the active task criteria; no canvas update is claimed. Browser screenshots cover the existing light/dark busy presentation.
