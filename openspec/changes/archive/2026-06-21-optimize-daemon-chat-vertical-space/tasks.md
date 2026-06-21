# Tasks: optimize-daemon-chat-vertical-space

## 1. Header chrome + top-align
- [ ] 1.1 `daemon-chat.tsx`: remove the visible `<p>{t("subtitle")}</p>` from the header (desktop + mobile branches); keep the `<h2>` title
- [ ] 1.2 `daemon-chat.tsx`: tighten outer container vertical padding (`py-5`/`md:py-6`/`lg:py-7`) and header→body `gap-6` so two-pane content top-aligns
- [ ] 1.3 Verify `connections-modal.tsx` hidden `DialogDescription` still resolves `t("subtitle")` (a11y intact) — `daemonChat.subtitle` key retained in both locales

## 2. Running status into transcript header
- [ ] 2.1 `transcript-view.tsx`: in the header status line, render the running execution's live elapsed time beside the existing running pulse (reuse `useElapsedMono()`/`nowMs`); no deep-link
- [ ] 2.2 Reduced-motion respected for the pulse (already `motion-safe`); elapsed updates live

## 3. Composer action row (Interrupt/Resume/Send) + send-while-running
- [ ] 3.1 `execution-row.tsx`: export `InterruptButton` (with its `AlertDialog`) and `ResumeButton` as reusable controls (no behavior change; standalone `ExecutionRow` and other call sites untouched)
- [ ] 3.2 `send-instruction-box.tsx`: generalize `ComposeField` right side into an action row — Send always present; accept an optional controllable execution and render Interrupt (running) / Resume (user-interrupted) beside Send; crash → keep "auto-recovers" hint
- [ ] 3.3 `send-instruction-box.tsx`: stop disabling the textarea on running state (keep hard-disable only for origin offline); preserve Enter-to-send + `isImeComposing` guard
- [ ] 3.4 `send-instruction-box.tsx`: honor `inline` (desktop) vs `stacked` (mobile) layout for the action row

## 4. Remove standalone footer card
- [ ] 4.1 `transcript-view.tsx`: drop the `controllableExecutions.map(ExecutionRow)` block from the footer; feed the controllable execution into `ConversationReplyBox` instead so its action row hosts Interrupt/Resume

## 5. i18n + design
- [ ] 5.1 Add any new user-facing string (e.g. header elapsed-time label) to `messages/en.json` + `messages/zh.json`; confirm no hardcoded text; `daemonChat.subtitle` retained
- [ ] 5.2 Update `docs/design.pen` daemon chat mock(s): no visible subtitle, top-aligned content, header running status, consolidated input action row (desktop + mobile)

## 6. Integration checkpoint
- [ ] 6.1 E2E (real browser, desktop + mobile widths): idle → Send only; running → Send + Interrupt (confirm dialog fires) + header elapsed; user-interrupt → Resume; crash → auto-recovers hint, no Resume; offline → composer disabled with reason; send-while-running appends a turn; content top-aligned, no visible subtitle
