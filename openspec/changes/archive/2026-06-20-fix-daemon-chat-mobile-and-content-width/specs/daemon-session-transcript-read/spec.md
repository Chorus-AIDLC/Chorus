## ADDED Requirements

### Requirement: The conversation surface SHALL be fullscreen on mobile with the reply input pinned to the bottom

On a mobile-width viewport (below the `sm` breakpoint), the "View all" daemon conversation modal SHALL fill the viewport edge-to-edge — occupying the full dynamic viewport height and width with no rounded corners, border, or floating margin — so it reads like a native chat screen. The selected conversation's transcript SHALL fill the middle region and scroll within itself, and the reply/send input SHALL be pinned to the bottom edge of the viewport (not floated mid-screen with dead space below it). The modal height SHALL be measured against the dynamic viewport height so the mobile browser's collapsing/expanding URL bar cannot push the pinned input off-screen. On desktop-width viewports (`sm` and above) the modal SHALL remain the floating, height-capped card, and on `lg` and above the two-pane (conversation list + transcript) layout SHALL be unchanged.

#### Scenario: Modal is fullscreen on a mobile viewport

- **WHEN** a user opens the daemon conversation modal on a mobile-width viewport and drills into a conversation
- **THEN** the modal fills the viewport edge-to-edge with no rounded card, border, or surrounding margin
- **AND** the transcript fills the middle region and scrolls within itself
- **AND** the reply/send input is pinned to the bottom edge of the viewport with no dead space below it

#### Scenario: Desktop layout is preserved

- **WHEN** the same modal is opened on a desktop-width viewport
- **THEN** it renders as the floating, height-capped card
- **AND** at the `lg`-and-above width the two-pane conversation-list + transcript layout and behavior are unchanged

### Requirement: Wide markdown blocks in a transcript message SHALL be constrained to the available content width

When a transcript message renders Markdown that contains a wide block — a table, a code block, a long word or URL, or a wide image — the block SHALL be constrained to the message's available content width rather than overflowing it. A table or code block SHALL scroll horizontally within its own region while preserving its layout; long words and URLs SHALL wrap; a wide image SHALL be scaled down to the available width. The message bubble, the transcript column, and the overall modal SHALL NOT be widened by such a block — no horizontal overflow of the conversation container SHALL occur, on mobile or desktop. This constraint applies to the daemon transcript message renderer; the change SHALL NOT alter the shared application-wide Markdown rendering behavior for Ideas, Comments, or Documents unless that behavior is verified to be unchanged.

#### Scenario: A markdown table does not overflow the conversation

- **WHEN** a transcript message contains a Markdown table wider than the available content width, rendered on a mobile-width viewport
- **THEN** the conversation container does not overflow horizontally (the overall layout width is not blown out)
- **AND** the table scrolls horizontally within its own region with its column layout preserved

#### Scenario: Long words, URLs, and wide images are contained

- **WHEN** a transcript message contains a very long unbroken word or URL, or an image wider than the content width
- **THEN** the long word or URL wraps within the available width
- **AND** the image is scaled down to fit the available width
- **AND** the message bubble width is not widened past the conversation container

#### Scenario: Shared markdown surfaces are not regressed

- **WHEN** the transcript content-width constraint is implemented
- **THEN** the rendering of Ideas, Comments, and Document markdown content is unchanged
- **AND** any constraint applied at the shared renderer level is only retained if those surfaces are verified visually unchanged
