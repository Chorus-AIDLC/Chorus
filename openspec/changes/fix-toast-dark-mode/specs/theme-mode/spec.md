# theme-mode Specification

## ADDED Requirements

### Requirement: Notification toasts SHALL adapt to the active theme

Notification toasts SHALL render correctly under both the light and dark themes. Toasts are the transient `sonner` pills triggered by user actions such as save / copy / error. The toast
background, title text, description text, border, action/close buttons, and elevation shadow
SHALL all follow the currently active theme, so that a toast is never light-on-light or
otherwise low-contrast in dark mode.

The toast surface colors SHALL be driven by the app's semantic design tokens (the same
`--color-card` / `--color-foreground` / `--color-border` / `--primary` family used elsewhere),
NOT by the toast library's built-in fixed `#fff` (light) or `#000` (dark) defaults. Because the
library ships its own theme CSS at a specificity that outranks a plain stylesheet override, the
implementation SHALL both (a) drive the library's theming API from the resolved app theme and
(b) lock the surface colors to the design tokens by a mechanism that wins over the library's
per-theme defaults. The resolved theme passed to the library SHALL be the concrete `light` or
`dark` value (never `system`), so it tracks the class-driven theme rather than the OS media
query. The toast's visual style SHALL remain neutral — this requirement introduces no
per-type semantic coloring (no success=green / error=red / warning=amber / info=blue).

Light-mode toast appearance SHALL remain visually equivalent to before this change.

#### Scenario: Toast is legible in dark mode

- **GIVEN** dark mode is active (`.dark` on `<html>`)
- **WHEN** an action triggers a notification toast
- **THEN** the toast MUST render with the dark card surface (the warm dark token, neither `#fff`
  nor pure `#000`)
- **AND** the title and description text MUST render with the dark foreground/muted tokens at a
  legible contrast against that surface
- **AND** the toast MUST remain visually distinct as an elevated surface (its shadow MUST NOT be
  effectively invisible against the dark background)

#### Scenario: Toast is unchanged in light mode

- **GIVEN** light mode is active (no `dark` class on `<html>`)
- **WHEN** an action triggers a notification toast
- **THEN** the toast MUST render with the light card surface and dark text as before
- **AND** its appearance MUST be visually equivalent to the pre-change light-mode toast

#### Scenario: Live theme switch reflows the toast palette

- **GIVEN** a user switches the theme via the sidebar theme control
- **WHEN** a notification toast is shown after the switch
- **THEN** the toast MUST render using the palette of the newly-selected theme
- **AND** the library MUST receive the resolved concrete theme (`light` or `dark`), not `system`
