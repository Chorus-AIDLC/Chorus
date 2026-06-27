# assign-modal-mobile-layout Specification

## Purpose
TBD - created by archiving change fix-assign-modals-mobile-overflow. Update Purpose after archive.
## Requirements
### Requirement: A reusable scrollable-dialog skeleton keeps header and footer pinned while only the body scrolls

The project SHALL provide a reusable dialog skeleton, built on the shadcn `Dialog`
primitive, that lays out a pinned header, a scrolling body, and a pinned footer
inside a single height-capped, width-bounded container. The container's maximum
height SHALL be expressed in a dynamic viewport unit (`svh` or `dvh`) so that it
never exceeds the visible viewport when mobile browser chrome or a soft keyboard
reduces it. The body region SHALL be the only scrollable region: when its content
is taller than the available space it SHALL scroll internally (vertical
overflow), while the header and footer remain fully visible and do not shrink. The
container's width SHALL fall back to fit narrow viewports (no fixed pixel width
that overflows a ~360px-wide screen). The skeleton SHALL inherit the shadcn
`Dialog` accessibility and dismissal behavior (Escape to close, focus management,
labelled dialog, overlay).

#### Scenario: Body taller than the cap scrolls while header and footer stay pinned

- **WHEN** the skeleton's body content is taller than the height-capped container
- **THEN** the body scrolls internally and both the header and the footer remain
  visible and clickable without being pushed outside the container

#### Scenario: Height cap uses a dynamic viewport unit

- **WHEN** the dialog is open on a viewport shortened by mobile browser chrome or a
  soft keyboard
- **THEN** the container's height is bounded by a dynamic viewport unit (`svh`/`dvh`)
  so the whole dialog, including its footer, stays within the visible viewport

#### Scenario: Narrow viewport does not overflow horizontally

- **WHEN** the dialog is open on a viewport about 360px wide
- **THEN** the dialog width fits within the viewport (a margin remains on both
  sides) rather than overflowing horizontally

### Requirement: Assign Idea and Assign Task modals stay fully operable on any viewport

The Assign Idea modal and the Assign Task modal SHALL render using the reusable scrollable-dialog skeleton (`assign-idea-modal.tsx` and `assign-task-modal.tsx`). On any viewport size — including a short mobile viewport and a
soft-keyboard-shortened viewport — the modal title and the footer Cancel and
Assign controls SHALL remain visible and clickable, and the modal body SHALL be
scrollable to any row regardless of how many online instances the working-directory
picker lists or whether the Release option is present. This change SHALL be a
pure UI/layout refactor: the existing assignment options (assign to self, to an
agent with an optional instance pin, to another user, and release), the
instance-pin behavior, the submit/CTA labeling, and the open/close contract with
the existing call sites SHALL be preserved unchanged.

#### Scenario: Long body on a short viewport keeps Cancel and Assign reachable

- **WHEN** a user opens Assign Idea or Assign Task on a short mobile viewport,
  selects "Assign to Agent", and the body grows with a multi-row instance picker
  (and the Release option when already assigned)
- **THEN** the title and the Cancel and Assign buttons stay visible and clickable,
  and the user can scroll the body to reach every row

#### Scenario: Assignment behavior is unchanged

- **WHEN** a user completes an assignment through either modal (to self, to an
  agent with or without an instance pin, to another user, or release)
- **THEN** the same assignment action runs and the same result occurs as before the
  layout refactor

#### Scenario: Call sites are not changed

- **WHEN** a parent that previously mounted the modal conditionally and passed only
  an `onClose` callback continues to do so
- **THEN** the modal opens and closes correctly (including via Escape, overlay
  click, the close button, and Cancel) without any change to the call site

#### Scenario: Desktop appearance is preserved

- **WHEN** either modal is opened on a desktop-width viewport
- **THEN** it renders as a centered card of the existing width with the existing
  header, body, and footer styling

