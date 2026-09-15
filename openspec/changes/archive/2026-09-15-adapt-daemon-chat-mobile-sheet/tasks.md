## 1. Responsive conversation surface

- [x] 1.1 Render the controlled Agent Daemon conversation as the shared near-full-height bottom Sheet below `sm` with a 16px top gap, preserving the existing Dialog at `sm` and wider.
- [x] 1.2 Add handle-only pointer drag dismissal at a 96px threshold with cancellation/snap-back cleanup, reduced-motion handling, and no body-scroll gesture interception.

## 2. Verification

- [x] 2.1 Add focused tests for mobile/desktop primitive selection, accessible semantics, backdrop/close behavior, and handle-only drag dismissal.
- [x] 2.2 Run the focused frontend tests, lint/type checks for changed files, OpenSpec validation, Impeccable detector, and browser acceptance at mobile and desktop widths in both light and dark themes.
