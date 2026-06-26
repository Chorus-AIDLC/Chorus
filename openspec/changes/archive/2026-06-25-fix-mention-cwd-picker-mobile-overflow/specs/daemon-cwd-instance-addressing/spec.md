# daemon-cwd-instance-addressing — delta

## ADDED Requirements

### Requirement: The instance-picker dialog stays usable on a short viewport

The `@`-mention cwd picker dialog SHALL remain fully operable regardless of the visible viewport height, including when a mobile soft keyboard or browser URL bar shrinks the visible viewport.
The dialog is shown when a mentioned agent has two or more online instances. The dialog's
title and its action footer (the Cancel control and the Pin-instance / confirm control) SHALL
always be visible and clickable; only the instance list SHALL scroll when the instances do not
all fit. The dialog SHALL cap its height to the visible viewport using a dynamic-viewport
height unit (e.g. `svh`/`dvh`) rather than a static layout-viewport unit (`vh`), so the cap
tracks the soft keyboard. The dialog SHALL NOT overflow past the top or bottom edge of the
visible viewport, and the confirm control SHALL NOT be pushed off-screen with no means to
reach it.

#### Scenario: Many instances on a short mobile viewport keep the confirm button reachable

- **WHEN** an owner opens the `@`-mention cwd picker for an agent with enough online
  instances that the picker's natural height exceeds the visible (soft-keyboard-shortened)
  mobile viewport
- **THEN** the dialog's height is capped to the visible viewport, the instance list scrolls
  inside the dialog, and the Pin-instance confirm button remains visible and clickable at
  the bottom of the dialog

#### Scenario: Selecting a cwd on mobile enables and exposes the confirm button

- **WHEN** an owner selects one of the cwd rows in the `@`-mention cwd picker on a mobile
  viewport
- **THEN** the Pin-instance confirm button becomes enabled AND is within the visible
  viewport so the owner can tap it to pin the chosen instance

#### Scenario: A short instance list renders without an internal scrollbar

- **WHEN** an owner opens the `@`-mention cwd picker for an agent whose online instances all
  fit within the viewport-capped dialog height
- **THEN** the dialog renders the full list with the title and footer visible and introduces
  no internal scrolling beyond what the content needs
