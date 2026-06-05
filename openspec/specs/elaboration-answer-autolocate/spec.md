# elaboration-answer-autolocate Specification

## Purpose
TBD - created by archiving change simplify-elaboration-flow. Update Purpose after archive.
## Requirements
### Requirement: Optional roundUuid with active-round auto-location

The `chorus_answer_elaboration` tool SHALL accept `roundUuid` as an optional parameter. When `roundUuid` is omitted, the system SHALL automatically locate the Idea's single round in status `pending_answers` and apply the answers to it. When `roundUuid` is provided, the existing behavior SHALL be preserved (backward compatible).

#### Scenario: Answer without specifying roundUuid

- **WHEN** a client calls `chorus_answer_elaboration` with `ideaUuid` and `answers` but no `roundUuid`, and the Idea has exactly one `pending_answers` round
- **THEN** the answers are applied to that active round
- **AND** the call succeeds without the client needing to know the round UUID

#### Scenario: Answer with explicit roundUuid still works

- **WHEN** a client calls `chorus_answer_elaboration` with an explicit `roundUuid`
- **THEN** the answers are applied to that specific round, exactly as before this change

#### Scenario: No active round to auto-locate

- **WHEN** `chorus_answer_elaboration` is called without `roundUuid` and the Idea has no round in `pending_answers`
- **THEN** the call fails with an error indicating there is no active round to answer

#### Scenario: Ambiguous active round

- **WHEN** `chorus_answer_elaboration` is called without `roundUuid` and the Idea has more than one round in `pending_answers`
- **THEN** the call fails with an error instructing the caller to specify `roundUuid`

### Requirement: Answering an appended round does not regress a resolved Idea

When all required questions of a round are answered, the system SHALL move the round to `answered`. For an appended round on an Idea whose `elaborationStatus` is `resolved`, the system SHALL NOT change `elaborationStatus` away from `resolved`.

#### Scenario: Answering an appended round keeps the Idea resolved

- **WHEN** all required questions of an appended round (on an Idea with `elaborationStatus = resolved`) are answered
- **THEN** the round status becomes `answered`
- **AND** the Idea `elaborationStatus` remains `resolved`
- **AND** the Idea status remains `elaborated`

