# theme-mode Specification

## ADDED Requirements

### Requirement: The app SHALL offer three theme modes — light, dark, and system

The application SHALL expose exactly three user-selectable theme modes: `light`, `dark`, and
`system`. In `system` mode the effective theme SHALL follow the operating system's
`prefers-color-scheme` media query, and SHALL update live when the OS preference changes while the
app is open, without a reload. The `dark` theme SHALL be applied by adding the `dark` class to the
document root element (`<html>`), consistent with the existing `@custom-variant dark (&:is(.dark *))`
declaration and the `useDarkClass` reader already present in the codebase.

#### Scenario: User selects Dark explicitly

- **WHEN** a user chooses the `dark` mode from the theme control
- **THEN** the `dark` class MUST be present on the `<html>` element
- **AND** the page MUST render using the dark token values
- **AND** the choice MUST override the OS `prefers-color-scheme` until changed

#### Scenario: System mode follows the OS and reacts to live changes

- **GIVEN** a user whose selected mode is `system`
- **WHEN** the OS `prefers-color-scheme` is `dark`
- **THEN** the `dark` class MUST be present on `<html>` and the page MUST render dark
- **WHEN** the OS preference then switches to `light` while the app is open
- **THEN** the `dark` class MUST be removed and the page MUST render light without a reload

#### Scenario: User selects Light explicitly

- **WHEN** a user chooses the `light` mode
- **THEN** the `dark` class MUST NOT be present on `<html>`
- **AND** the page MUST render light regardless of the OS `prefers-color-scheme`

### Requirement: The default theme SHALL be system for users with no stored preference

When no theme preference has been stored for the current device, the application SHALL default to
`system` mode. A user whose OS is set to light and who never interacts with the theme control SHALL
see the pre-existing light appearance unchanged.

#### Scenario: First visit with a light OS

- **GIVEN** a browser with no stored Chorus theme preference and an OS preference of `light`
- **WHEN** the app first loads
- **THEN** the effective mode MUST be `system`
- **AND** the page MUST render light (unchanged from today's appearance)

#### Scenario: First visit with a dark OS

- **GIVEN** a browser with no stored Chorus theme preference and an OS preference of `dark`
- **WHEN** the app first loads
- **THEN** the effective mode MUST be `system`
- **AND** the page MUST render dark

### Requirement: The selected theme SHALL persist per device in localStorage

The selected theme mode SHALL be persisted in the browser's `localStorage` under the key
`chorus-theme`, scoped to the device/browser. The system SHALL NOT persist the preference to any
server-side store, user record, or database column, and SHALL NOT require authentication to read or
apply the preference. On a subsequent visit in the same browser, the stored mode SHALL be restored.

#### Scenario: Preference survives reload in the same browser

- **GIVEN** a user who has selected `dark` mode
- **WHEN** the user reloads the app or reopens it later in the same browser
- **THEN** the stored `dark` mode MUST be restored from `localStorage` (`chorus-theme`)
- **AND** the page MUST render dark

#### Scenario: Preference is not synced across devices

- **GIVEN** a user who selected `dark` on device A
- **WHEN** the same user opens Chorus on a different device/browser B with no stored preference
- **THEN** device B MUST fall back to the default `system` mode
- **AND** no server record of the theme preference is created

### Requirement: The initial theme SHALL be applied before first paint with no flash

The correct theme SHALL be applied to the document before the first meaningful paint, so that there
is no flash of the wrong theme (FOUC) on load — including the case where the stored/effective theme
is `dark` but the server-rendered markup is theme-neutral. The document root element MUST tolerate the
pre-hydration class mutation without producing a React hydration error.

#### Scenario: Dark user sees no light flash on load

- **GIVEN** a user whose effective theme resolves to `dark`
- **WHEN** the app is loaded fresh
- **THEN** the first painted frame MUST already be dark (no visible light flash)
- **AND** the console MUST NOT report a hydration mismatch caused by the theme class

### Requirement: A theme control SHALL be available at the bottom of the sidebar

The application SHALL provide a theme-selection control located in the sidebar footer, allowing the
user to switch between `light`, `dark`, and `system`. The control SHALL be present in the main
dashboard sidebar (both its desktop and mobile presentations) and in the admin sidebar. All of its
visible text and accessible labels SHALL be internationalized via the app's i18n system, with keys
present in both the `en` and `zh` message catalogs. The control SHALL indicate the currently active
mode.

#### Scenario: Toggle is reachable and switches theme from the dashboard sidebar

- **GIVEN** an authenticated user viewing the dashboard
- **WHEN** the user opens the theme control in the sidebar footer and selects `dark`
- **THEN** the app MUST switch to dark immediately
- **AND** the control MUST reflect `dark` as the active mode
- **AND** the selection MUST be persisted per the persistence requirement

#### Scenario: Control labels are internationalized

- **GIVEN** the app locale is set to `zh`
- **WHEN** the user opens the theme control
- **THEN** the mode labels MUST render from the `zh` catalog (e.g. 浅色 / 深色 / 跟随系统)
- **AND** the same keys MUST also exist in the `en` catalog

### Requirement: All application surfaces SHALL render correctly in dark mode

Dark mode coverage SHALL extend to all page surfaces: the main dashboard app, the admin panel, the
login flow, the onboarding flow, and static/loading screens. No surface SHALL remain visually stuck
in the light appearance when dark mode is active. To support this, the `.dark` token set in the
global stylesheet SHALL define a value for every color token that the `:root` set defines (including
the chart and sidebar token groups), and any surface that hardcodes light-only colors instead of
semantic tokens SHALL be migrated to tokens or given dark-mode-aware values.

#### Scenario: Dark token set has parity with the light token set

- **GIVEN** the global stylesheet defines a set of color tokens under `:root`
- **WHEN** dark mode is active (`.dark` on `<html>`)
- **THEN** every color token defined under `:root` (including `--chart-*` and `--sidebar-*`) MUST
  have a corresponding value under `.dark`
- **AND** no component relying on those tokens MUST fall back to a light `:root` value in dark mode

#### Scenario: Previously hardcoded light-only screens render dark

- **GIVEN** the root loading screen and the idea card previously used literal light-only colors
- **WHEN** dark mode is active
- **THEN** those surfaces MUST render with dark-appropriate colors (via semantic tokens)
- **AND** their light-mode appearance MUST remain visually equivalent to before this change

#### Scenario: Login and onboarding render dark

- **GIVEN** dark mode is active
- **WHEN** an unauthenticated user views the login page or a new user views onboarding
- **THEN** those pages MUST render using the dark theme with no light-stuck regions
