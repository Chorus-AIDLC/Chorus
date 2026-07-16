# reference-display Specification

## Purpose
TBD - created by archiving change strengthen-reference-association. Update Purpose after archive.
## Requirements
### Requirement: Reference links truncate instead of overflowing
The reference-list UI SHALL keep an over-long reference URL or title within the bounds of its card by truncating the visible link text, in both the editable references section and the read-only idea-tracker references panel, and in both light and dark themes. The link anchor SHALL be width-constrained (a block-level, `min-w-0` flex container) so the inner truncating span engages against the card width, while the external-link icon remains visible.

#### Scenario: Long title truncates in the references section
- **WHEN** a reference whose title (or a title that is a pasted long URL) exceeds the card width is rendered in `references-section.tsx`
- **THEN** the title is truncated with an ellipsis and the card width is unchanged (no horizontal overflow), and the external-link icon stays visible

#### Scenario: Long title truncates in the idea references panel
- **WHEN** such a reference is rendered in the read-only `idea-references-panel.tsx`
- **THEN** the title is truncated with an ellipsis and the card does not widen or overflow

#### Scenario: Both themes render correctly
- **WHEN** the truncation fix is viewed in light and in dark theme
- **THEN** the layout is correct in both, with no color regression (the fix changes layout classes only, using existing semantic tokens)

### Requirement: Reference notes clamp to two lines with full-text reveal
The reference-list UI SHALL display a reference's `notes` text clamped to at most two lines by default, and SHALL make the full text reachable without altering the stored value — via a hover tooltip on hover-capable (desktop) pointers AND via a tap/click that expands the notes inline (the touch fallback, since hover does not fire on touch). This behavior SHALL apply on all reference-list surfaces: the editable references section (`references-section.tsx`, used on idea/proposal/task detail panels) and the read-only idea-tracker references panel (`idea-references-panel.tsx`). When a reference has no notes, nothing SHALL be rendered and no reveal interaction SHALL be exposed. The clamp and reveal SHALL be implemented by a single shared component so both surfaces behave identically, and SHALL render correctly in both light and dark themes using existing semantic tokens.

#### Scenario: Long notes clamp to two lines in the references section
- **WHEN** a reference with a paragraph-length `notes` value is rendered in `references-section.tsx`
- **THEN** the visible notes are clamped to two lines (the card does not grow to fit the whole paragraph) while the full text remains present in the DOM

#### Scenario: Long notes clamp to two lines in the idea references panel
- **WHEN** such a reference is rendered in the read-only `idea-references-panel.tsx`
- **THEN** the visible notes are clamped to two lines with the same behavior as the editable section

#### Scenario: Hover reveals the full notes on desktop
- **WHEN** a user with a hover-capable pointer hovers over clamped notes
- **THEN** a tooltip shows the complete notes text

#### Scenario: Tap expands the full notes on touch
- **WHEN** a user taps/clicks the clamped notes
- **THEN** the notes expand inline to show the full text, and tapping/clicking again collapses them back to two lines

#### Scenario: Empty notes render nothing
- **WHEN** a reference has null or empty `notes`
- **THEN** no notes paragraph and no reveal control are rendered

#### Scenario: Both themes render correctly
- **WHEN** the clamped notes and the full-text reveal are viewed in light and in dark theme
- **THEN** the layout and colors are correct in both, using existing semantic tokens (no fixed-light-only color)

