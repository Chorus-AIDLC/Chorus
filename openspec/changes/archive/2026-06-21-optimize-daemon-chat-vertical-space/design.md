# Design: Daemon chat window vertical-space optimization

## Overview

A front-end-only refinement of the daemon chat surface (`DaemonChat` + `TranscriptView` + the `ComposeField`/`ConversationReplyBox` composer). Three changes, one theme — reclaim vertical space by cutting chrome:

1. Drop the redundant visible header subtitle; tighten outer padding/gap so content top-aligns.
2. Move the running-status (running marker + elapsed time) into the transcript header; remove the standalone footer `ExecutionRow` card.
3. Fold Interrupt / Resume / Send into one bottom-right action row on the input box, and stop disabling the textarea while a turn runs.

No backend, schema, endpoint, or permission change. Everything reuses the shipped daemon-session pipeline: the instruction endpoint, the `/api/daemon/control` interrupt + `/api/daemon/resume` resume endpoints, the execution snapshot, and the transcript SSE.

## Key decisions (from elaboration)

| # | Decision | Rationale |
|---|----------|-----------|
| Q1 | **Send-while-running: input stays usable; Send always present, Interrupt appears beside it while running, Resume after a user-interrupt.** (option b) | Owner choice. Chat-like — the user can type a follow-up/correction mid-run. Cost is up to two buttons in the corner at once (Send + Interrupt), accepted. |
| Q2 | **Running status (running marker + elapsed time) moves into the transcript header.** (option b) | Owner choice. Frees the footer to be purely input + actions, maximizing transcript height. The header already shows a running pulse — extend it with elapsed time. |
| Q3 | **No deep-link in the status.** (option b) | Owner choice. The header conversation title (with its Idea badge) already identifies the conversation and is the jump-off point; the status stays minimal. |
| Q4 | **Mobile (`< lg`) syncs the same layout.** (option a) | Owner choice. Mobile vertical space is tighter still; same "drop card, fold actions into input" via the composer's `stacked` variant. |
| — | **Interrupt keeps its confirmation `AlertDialog`.** (hard constraint) | Destructive op; a misclick must never silently kill a running agent. Non-negotiable regardless of layout. |
| — | **Running-state visibility is preserved, not dropped.** (hard constraint) | Removing the card must not lose "what's running / how long" — Q2 gives it a home in the header. |

## Architecture

### Current layout (what changes)

```
DaemonChat (daemon-chat.tsx)
 └ outer container: px-4 py-5 … lg:py-7, gap-6
    ├ <header>  <h2>title</h2>  <p>subtitle</p>        ← subtitle removed; py/gap tightened
    └ two-pane body
        └ TranscriptView (right pane)
            ├ header: title + status badge + "running" pulse   ← add elapsed time here (Q2)
            │         + collapsible connection details (unchanged)
            ├ body: turn bands (ScrollArea)                     (unchanged)
            └ footer:
                ├ controllableExecutions.map(ExecutionRow)      ← standalone card REMOVED
                └ ConversationReplyBox (Textarea + Send)         ← gains action row (Q1)
```

### Target layout

```
DaemonChat
 └ outer container: tightened py/gap (content top-aligned)
    ├ <header>  <h2>title</h2>                               (single line — no subtitle)
    └ two-pane body
        └ TranscriptView
            ├ header: title + status badge + running pulse + ELAPSED TIME   (Q2)
            ├ body: turn bands                                              (unchanged)
            └ footer: ConversationReplyBox ONLY
                 └ ComposeField
                     ├ Textarea (NOT disabled while running — Q1)
                     └ action row (bottom-right):
                         Send  [+ Interrupt while running] [+ Resume if user-interrupted]
```

### Running-status home (Q2)

`TranscriptView` already derives `currentTurn` (the running turn, else the newest) and renders a "running" pulse when `currentTurn.status === "running"`. It also already computes `controllableExecutions` from `sessionExecutions`. To carry elapsed time in the header:

- Pick the conversation's running execution (the `running` entry already in `controllableExecutions`, running-first).
- In the header's status line, when running, render the existing pulse **plus** the elapsed time using the existing `useElapsedMono()` / `nowMs` formatter (the same one `ExecutionRow` uses today) off that execution's `startedAt`.
- No deep link (Q3): the elapsed time is plain text beside the pulse; the `<h3>` title above it is the only navigational affordance.

This keeps the "how long has it been running" signal that the card used to provide, in a lighter single-line form, satisfying the hard constraint.

### Consolidated action row (Q1)

`ComposeField` currently renders a footer with a disabled-reason on the left and a single Send button on the right. Generalize the right side into an **action row** that can host additional state-driven controls before Send:

- The composer is told this conversation's controllable execution (the `running` or user-`interrupted` one), if any.
- **Running** → render the Interrupt control (the existing `InterruptButton`, with its `AlertDialog`) to the left of Send.
- **User-interrupted** → render the Resume control (the existing `ResumeButton`) to the left of Send.
- **Crash-interrupted** → no Resume; the "auto-recovers" hint stays (today it lives on the card; it moves to a minimal inline hint or the header — kept visible, never silently dropped).
- **Send** is always present and independently gated (empty/pending), exactly as today.

**Textarea enable (send-while-running):** today `ComposeField` disables the textarea via `disabled || pending`. The hard-`disabled` path (origin offline) is unchanged. The change is that a *running turn* no longer disables it — there is no "running disables input" coupling to add; the composer simply isn't told to disable on run. The existing Enter-to-send + `isImeComposing` guard is preserved.

**Reusing the controls:** `InterruptButton` and `ResumeButton` are currently file-private to `execution-row.tsx`. Export them (or extract to a small shared module) so the composer renders the **same** controls — same `AlertDialog` confirmation, same `/api/daemon/control` + `/api/daemon/resume` calls, same toasts/`entityType`/`entityUuid` wiring. No behavioral divergence; only the mount point moves.

### Layout variants (Q4)

`ComposeField` already takes `layout: "inline" | "stacked"`. Desktop two-pane uses `inline` (action row on the same line as the footer); mobile drill-down uses `stacked` (action row drops below the textarea). The consolidated action row honors both: inline keeps Send + Interrupt/Resume on the footer's right; stacked stacks them under the textarea. Mobile thus gets the same "no card, actions in the input" outcome with no separate code path.

### Top-align (improvements 1 & 2)

Purely Tailwind spacing in `daemon-chat.tsx`:

- Header becomes a single line (subtitle `<p>` removed), so the header's intrinsic height drops.
- Reduce the outer container's vertical padding (`py-5`/`md:py-6`/`lg:py-7`) and the header→body `gap-6` to a tighter scale so the two-pane content's top edge sits near the modal top. Exact values are a visual-tuning detail for the implementer; the AC asserts the *outcome* (content top-aligned, no visible subtitle), not specific pixel values.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Deleting the subtitle accidentally breaks the Radix Dialog a11y "described-by". | The hidden `DialogDescription` in `connections-modal.tsx` is a **separate** node that also reads `t("subtitle")`; we delete only the visible `<p>` in `daemon-chat.tsx` and **keep the i18n key**. AC explicitly asserts the a11y description still resolves. |
| Interrupt loses its confirmation when moved into the input row. | Reuse the existing `InterruptButton` component verbatim — the `AlertDialog` travels with it. AC asserts the confirm dialog still appears. |
| Running state disappears with the card. | Q2 moves running + elapsed into the header. AC asserts running indication + elapsed time remain visible after the card is removed. |
| Two buttons (Send + Interrupt) crowd the corner, especially on mobile. | The `stacked` layout drops actions below the textarea on mobile; inline has room on desktop. Visual check on both widths. |
| Send-while-running implies a backend change. | It does not — the instruction endpoint already appends a `human_instruction` turn irrespective of run state. The change is only un-disabling the textarea. AC notes no backend change. |
| `InterruptButton`/`ResumeButton` were file-private; exporting them risks regressing the connection-deck/popover. | They are presentational + prop-driven already; export without changing their internals. The standalone `ExecutionRow` and its other call sites are untouched. |

## Implementation order

1. **Header chrome + top-align** (`daemon-chat.tsx`) — remove visible subtitle, tighten py/gap (desktop + mobile). Independently shippable; lowest risk.
2. **Running status into header** (`transcript-view.tsx`) — add elapsed time to the header status line from the running execution.
3. **Composer action row** (`send-instruction-box.tsx` + export controls from `execution-row.tsx`) — Send always present; Interrupt/Resume state-driven beside it; textarea no longer disabled while running; honor inline/stacked.
4. **Remove the standalone footer card** (`transcript-view.tsx`) — drop `controllableExecutions.map(ExecutionRow)` from the footer once (3) hosts the controls; feed the controllable execution into the composer instead.
5. **i18n + design.pen** — any new key in en+zh; update the daemon chat mock(s).
6. **Integration checkpoint** — desktop + mobile, idle/running/user-interrupted/crash/offline states verified end to end in a real browser.
