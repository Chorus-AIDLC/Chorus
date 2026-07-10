# page-navigation-progress Specification

## ADDED Requirements

### Requirement: A top-of-page progress bar SHALL appear during in-app navigation

The application SHALL display a slim horizontal progress bar pinned to the very top edge of the viewport, above all app chrome, whenever an in-app client-side navigation is in progress. The bar SHALL appear when a navigation starts and SHALL complete (fill and fade out) when the destination route has committed. This provides visible feedback for the otherwise silent pause while App Router fetches the route's payload and code.

#### Scenario: Slow navigation shows the bar

- **GIVEN** a user on any dashboard page
- **WHEN** they trigger a navigation whose route takes longer than the show-delay to become ready
- **THEN** the top progress bar MUST become visible while the route is loading
- **AND** the bar MUST fill to completion and fade out once the destination route has committed

#### Scenario: Bar sits above app chrome

- **WHEN** the progress bar is visible during a navigation
- **THEN** it MUST render pinned to the top edge of the viewport, above the sidebar and header chrome, and MUST NOT shift or reflow page content

### Requirement: The bar SHALL cover all in-app navigation entry points

The progress bar SHALL be driven by every in-app client-side navigation, regardless of how it was initiated: activating a `<Link>`, a programmatic `router.push` / `replace` / `back` / `forward`, and the browser Back / Forward buttons. Navigations to the current URL (same path and query) SHALL NOT trigger the bar. A full-page browser reload or first page load is out of scope and SHALL NOT be driven by this component (the browser's own loading indicator covers that case).

#### Scenario: Link click drives the bar

- **WHEN** the user clicks a sidebar or in-page `<Link>` that navigates to a different route
- **THEN** the progress bar MUST be driven by that navigation

#### Scenario: Programmatic navigation drives the bar

- **WHEN** application code performs a programmatic `router.push`, `replace`, `back`, or `forward` to a different route
- **THEN** the progress bar MUST be driven by that navigation

#### Scenario: Browser back and forward drive the bar

- **WHEN** the user presses the browser Back or Forward button to move between in-app routes
- **THEN** the progress bar MUST be driven by that navigation

#### Scenario: Same-URL navigation does not flash the bar

- **WHEN** a navigation resolves to the current URL (identical path and query)
- **THEN** the progress bar MUST NOT appear

### Requirement: Navigation progress SHALL be shown as an indeterminate auto-trickle

The bar SHALL represent progress as an indeterminate auto-incrementing (trickle) animation rather than a measured percentage of loaded bytes: on navigation start it SHALL advance to an initial position and creep toward near-complete while the route loads, then jump to full and fade out on route commit. The system SHALL NOT attempt to report true resource-loading progress.

#### Scenario: Bar trickles while loading and completes on commit

- **GIVEN** a navigation is in progress
- **WHEN** the destination route has not yet committed
- **THEN** the bar MUST advance automatically toward, but not reach, 100%
- **WHEN** the destination route commits
- **THEN** the bar MUST advance to 100% and then fade out

### Requirement: The bar SHALL use the brand primary color with a tail glow and adapt to light and dark themes

The bar SHALL be rendered as a slim (approximately 3px) line in the application's brand primary color, with a subtle tail glow. Its color SHALL be sourced from the `--primary` design token (used as `hsl(var(--primary))`) rather than a hardcoded hex value, so that the bar automatically renders the correct primary color in both the light and dark themes without any per-theme JavaScript branching. No visible spinner SHALL be shown.

#### Scenario: Bar uses the primary token in light theme

- **GIVEN** the app is in light theme
- **WHEN** the progress bar is visible
- **THEN** the bar and its glow MUST render in the light-theme primary color (the value of `--primary` under `:root`)

#### Scenario: Bar uses the dark primary in dark theme

- **GIVEN** the app is in dark theme (`.dark` on `<html>`)
- **WHEN** the progress bar is visible
- **THEN** the bar and its glow MUST render in the dark-theme primary color (the value of `--primary` under `.dark`), not the light-theme value

#### Scenario: No spinner is shown

- **WHEN** the progress bar is active
- **THEN** no circular spinner MUST be displayed — only the top bar

### Requirement: A short show-delay SHALL suppress the bar for fast navigations

The bar SHALL apply a short show-delay (approximately 120ms) before becoming visible, so that navigations which complete faster than the delay never render the bar. Only navigations slower than the delay SHALL surface the loading indicator, keeping instant page switches visually calm.

#### Scenario: Instant navigation does not flash the bar

- **GIVEN** a navigation that becomes ready faster than the show-delay
- **WHEN** the navigation completes
- **THEN** the progress bar MUST NOT have become visible (no flash)

#### Scenario: Slow navigation surfaces the bar after the delay

- **GIVEN** a navigation that takes longer than the show-delay to become ready
- **WHEN** the show-delay elapses while the route is still loading
- **THEN** the progress bar MUST become visible and animate until the route commits
