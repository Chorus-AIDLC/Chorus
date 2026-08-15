# daemon-merged-turn-transcript Specification

## Purpose
How the daemon chat transcript presents wake-coalescing `merged` turns: a distinct
settled-terminal status semantic, collapse of a contiguous merged run into its absorbing
turn, an expandable per-event merged-events section, and live SSE convergence so the
collapse applies without a reload.
## Requirements
### Requirement: Merged turns carry a distinct settled-terminal status semantic

A `merged` daemon chat turn SHALL render as a distinct, settled, non-error terminal state. The
transcript MUST NOT label a `merged` turn "Ended", MUST NOT treat it as an active or
queued turn, and MUST NOT show the generic "no transcript retained" error/empty placeholder
for it. A dedicated status label backed by an i18n key MUST exist in every supported locale
(`en`, `zh`, `ja`, `ko`).

#### Scenario: A standalone merged turn is labeled, not mislabeled "Ended"

- **WHEN** the transcript renders a turn with `status === "merged"` that is not grouped
  into an absorbing turn (e.g. its absorbing turn is outside the loaded window)
- **THEN** the band shows the dedicated merged status label (not "Ended")
- **AND** it does not render the "no transcript retained for this turn" placeholder as an
  error/empty state

#### Scenario: The merged status label is translated in all locales

- **WHEN** the merged status label i18n key is added
- **THEN** the same key is present with a hue/tone-appropriate translation in
  `messages/en.json`, `messages/zh.json`, `messages/ja.json`, and `messages/ko.json`
- **AND** the locale-key parity check passes with no missing key in any locale

### Requirement: Contiguous merged runs collapse into their absorbing turn

The transcript SHALL group a contiguous run of `status === "merged"` turns into the
immediately-preceding non-merged turn (the absorbing turn), relying on the server invariant
that coalesced-away turns are exactly the next `N−1` turns by ascending seq after the
absorbing turn. Grouping MUST be a pure front-end operation over the already-ordered turn
list — no Prisma migration, no new turn field, no server back-link. The N-1 merged turns
MUST NOT render as independent top-level bands when an absorbing turn is present.

#### Scenario: A coalesced batch renders as one band

- **WHEN** the loaded transcript contains an absorbing turn at seq `X` followed by a
  contiguous run of merged turns at seq `X+1 … X+N−1`
- **THEN** exactly one top-level band is rendered for the batch (the absorbing turn's band)
- **AND** the `N−1` merged turns are not rendered as separate top-level bands

#### Scenario: A merged run with no preceding absorbing turn survives

- **WHEN** the loaded transcript window begins with one or more merged turns whose
  absorbing turn (seq `X`) is not in the window
- **THEN** those merged turns still render (as standalone merged bands per the status
  requirement) rather than being dropped

### Requirement: The absorbing turn exposes an expandable merged-events section

An absorbing turn that has grouped merged turns SHALL display a collapsed-by-default,
expandable control labeled with the count of merged events (e.g. "merged N events"). When
expanded, it MUST list each merged-away event with its own provenance: the trigger glyph
and label, the event's prompt text when present, and an entity deep-link when resolvable —
reusing the existing single-turn band provenance vocabulary. The control MUST be usable on
touch (no hover-only affordance) and MUST render correctly in both light and dark themes.

#### Scenario: Expanding shows per-event provenance

- **WHEN** a user expands the "merged N events" control on an absorbing band
- **THEN** each merged-away event is listed with its trigger glyph + label and, when
  present, its prompt text
- **AND** an entity deep-link is shown for any merged event whose linked execution resolves
  to a project entity

#### Scenario: The control is collapsed by default and count-accurate

- **WHEN** an absorbing turn has grouped `M` merged turns
- **THEN** the merged-events control is collapsed on first render
- **AND** its label reflects the exact count `M`

### Requirement: Live viewers converge to the merged rendering without a reload

When wake coalescing settles same-session pending turns to `"merged"`, the server SHALL
publish a `turn_status_changed` transcript event for each settled turn on the existing
`transcript:{sessionUuid}` channel, reusing the existing `TranscriptEvent` payload shape,
so a live viewer's in-memory turn transitions from `pending` to `merged` and the collapse
rendering applies without a manual reload. This MUST NOT introduce a new schema field or
migration.

#### Scenario: A live-watched coalesced batch collapses in place

- **WHEN** a viewer is watching a session live and a wake-coalescing settlement marks
  `N−1` same-session pending turns as `merged`
- **THEN** the client receives one `turn_status_changed` event per settled turn carrying
  `status: "merged"`
- **AND** the previously-"Queued" bands converge to the collapsed merged rendering without
  a refetch

#### Scenario: A single, non-coalesced wake emits no settlement events

- **WHEN** a turn advances to `running` with `coalescedCount` of 1 (no coalescing)
- **THEN** no merged-settlement `turn_status_changed` events are published
- **AND** the behavior is byte-identical to the pre-coalescing single-wake path

