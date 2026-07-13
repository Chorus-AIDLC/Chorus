## ADDED Requirements

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
