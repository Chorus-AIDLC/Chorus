## 1. Active-session indicator interaction

- [x] 1.1 Refactor `ActiveSessionIndicator` so one actionable session directly invokes the existing exact-session chat handoff, while chooser cases use Radix's native touch/click state transition and mouse-only hover remains additive.
- [x] 1.2 Preserve status-only authorization, keyboard behavior, accessibility attributes, close timing, and parent Idea-card/graph event isolation across Tracker, sidebar, and graph surfaces.

## 2. Regression verification

- [x] 2.1 Extend the component tests with realistic touch pointer sequences for single- and multi-session activation, chooser selection, status-only sessions, and parent event isolation.
- [x] 2.2 Run the focused component suite plus frontend type/lint checks, then verify the multi-session chooser and single-session chat handoff at a mobile viewport.
