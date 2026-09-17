## MODIFIED Requirements

### Requirement: The conversation surface SHALL be a near-full-height bottom sheet on mobile with the reply input kept reachable

On a mobile-width viewport (below the `sm` breakpoint), the "View all" daemon conversation surface SHALL open from the bottom as a near-full-height sheet using the product's existing mobile Sheet visual language and entrance/exit motion. The sheet SHALL leave a fixed 16 CSS-pixel strip of backdrop visible above it, use rounded top corners and a visible top handle, and retain a height bounded by the dynamic viewport so mobile browser chrome and safe-area insets do not make the reply composer unreachable. The selected conversation's transcript SHALL fill the middle region and scroll within itself, and the reply/send input SHALL remain at the bottom of the bounded sheet without dead space below it.

The mobile sheet SHALL close when the user clicks/taps the exposed backdrop, presses Escape, activates the explicit close control, or drags the sheet's top handle downward at least 96 CSS pixels. Drag recognition SHALL be limited to the top handle: vertical scrolling or swiping within the conversation list, transcript, or composer MUST NOT move or dismiss the sheet. A handle drag released before 96 CSS pixels SHALL return the sheet to its resting position, respecting reduced-motion preferences.

On desktop-width viewports (`sm` and above), the conversation surface SHALL remain the existing floating, height-capped dialog, and on `lg` and above the two-pane conversation-list + transcript layout SHALL be unchanged.

#### Scenario: Mobile conversation opens as a bottom sheet

- **WHEN** a user opens the daemon conversation surface below the `sm` breakpoint
- **THEN** it enters from the bottom as a near-full-height sheet with rounded top corners and a visible top handle
- **AND** a fixed 16 CSS-pixel backdrop strip remains visible above the sheet
- **AND** the transcript scrolls within the bounded sheet while the reply/send input remains reachable at its bottom

#### Scenario: Backdrop and top handle dismiss the mobile sheet

- **WHEN** the mobile sheet is open and the user clicks or taps the exposed backdrop
- **THEN** the sheet closes through its normal exit motion
- **WHEN** the user instead drags the top handle downward by at least 96 CSS pixels
- **THEN** the sheet follows the handle and closes

#### Scenario: Conversation scrolling never drags the sheet

- **WHEN** the user scrolls or swipes vertically inside the conversation list, transcript, or composer
- **THEN** the content scrolls normally
- **AND** the sheet does not translate or dismiss
- **WHEN** a top-handle drag is released before 96 CSS pixels
- **THEN** the sheet returns to its resting position

#### Scenario: Keyboard and explicit close remain available

- **WHEN** keyboard focus is inside the mobile sheet
- **THEN** pressing Escape closes it and restores focus according to the existing Radix behavior
- **AND** an accessible explicit close control remains available

#### Scenario: Desktop layout is preserved

- **WHEN** the same conversation surface is opened at the `sm` breakpoint or wider
- **THEN** it renders as the existing floating, height-capped dialog
- **AND** at `lg` and above the two-pane conversation-list + transcript layout and behavior are unchanged

#### Scenario: Both themes represent the mobile sheet

- **WHEN** the mobile conversation surface is delivered
- **THEN** the sheet remains legible and free of overflow in both light and dark themes
