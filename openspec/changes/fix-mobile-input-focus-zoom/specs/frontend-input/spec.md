## ADDED Requirements

### Requirement: Mobile text entry SHALL avoid focus-triggered page zoom

Chorus SHALL keep the page zoom level stable when the user focuses, types in, blurs, or switches between editable text controls on mobile, with iPhone Chrome as the primary reported acceptance environment. This SHALL cover shared inputs, textareas, search inputs, native text controls, and rich-text editing roots across the application. Normal keyboard-driven viewport resizing and scrolling to reveal the caret SHALL remain allowed.

#### Scenario: Focus and switch between mobile inputs
- **WHEN** a user on iPhone Chrome focuses an input, types, switches to another input and refocuses the first
- **THEN** these actions SHALL NOT automatically enlarge the page or leave it enlarged
- **AND** input content and the caret SHALL remain visible and usable

#### Scenario: Rich text and direct native controls
- **WHEN** a user edits a comment or conversation in MentionEditor, a project group description, or a document body
- **THEN** the same no-focus-zoom behavior SHALL apply to each actual editing surface

#### Scenario: Keyboard reduces visible height
- **WHEN** the mobile keyboard opens or the browser scrolls to reveal the caret
- **THEN** normal viewport height and scroll changes SHALL be allowed without being treated as a zoom failure

### Requirement: Mobile editable text SHALL have a consistent readable font floor

Editable text SHALL compute to at least 16 CSS px when the viewport is at most 767 CSS px wide or the primary input has no hover and a coarse pointer. This floor SHALL apply before focus, survive consumer style overrides, and cover rich-text descendants containing editable text. Intentionally larger input typography SHALL NOT be reduced by the floor policy. On wider fine-pointer desktop environments, existing typography SHALL be preserved.

#### Scenario: A consumer requests compact text
- **WHEN** a mobile Input consumer supplies a compact class such as `text-sm`
- **THEN** the actual editable text SHALL still compute to at least 16 CSS px

#### Scenario: Phone rotates across the desktop breakpoint
- **WHEN** a phone with a coarse primary pointer and no hover rotates into a viewport wider than 767 CSS px
- **THEN** editable text SHALL retain the mobile font floor despite desktop breakpoint classes

#### Scenario: Editor descendants and larger text
- **WHEN** a rich-text editor renders paragraphs or an input intentionally uses a font larger than the minimum
- **THEN** editable paragraphs SHALL respect the floor and the intentionally larger input SHALL retain its larger typography

#### Scenario: Desktop input remains compact
- **WHEN** a user views the application at 1280 CSS px with a fine primary pointer
- **THEN** input font sizes SHALL retain their existing desktop values

### Requirement: Focus zoom prevention SHALL preserve user zoom and input semantics

The implementation MUST preserve user-initiated pinch zoom, existing IME handling, Enter and Shift+Enter semantics, focus handling, paste, mention insertion, and text state. It MUST NOT disable page zoom through viewport limits or gesture interception, reset zoom on focus, or shrink input text with transforms to evade focus zoom.

#### Scenario: User intentionally zooms
- **WHEN** a mobile user pinches to enlarge the page and subsequently focuses an input
- **THEN** manual enlargement SHALL remain available and input focus SHALL NOT forcibly reset that chosen page scale

#### Scenario: Compose and submit text
- **WHEN** a user confirms a Chinese IME candidate, inserts a mention, pastes text, or submits outside composition
- **THEN** the pre-existing input behavior SHALL remain intact and entered text SHALL be preserved

### Requirement: Mobile focus zoom acceptance SHALL include target-device evidence

Verification MUST include a source-level inventory of application text entry points, computed-style checks for representative shared, overridden, native and rich-text controls, desktop regression checks, and iPhone Chrome device evidence in portrait and landscape. The record MUST identify the device, OS and browser version, tested routes and outcomes. Desktop browser emulation alone MUST NOT be reported as target-device verification.

#### Scenario: Target device is available
- **WHEN** the fix is accepted
- **THEN** evidence SHALL show stable page scale during focus, typing and switching controls, continued manual zoom, and readable controls without newly introduced clipping

#### Scenario: Target device is unavailable
- **WHEN** only desktop or emulated checks can be executed
- **THEN** those results SHALL be recorded as partial verification and target-device acceptance SHALL remain pending
