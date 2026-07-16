## ADDED Requirements

### Requirement: The proposal-approved wake SHALL deliver the reviewer's note inline

The daemon wake prompt for a `proposal_approved` notification SHALL surface the reviewer's decision note inline (drawn from the notification `message`, which already carries the approver's note), so the woken daemon knows the reviewer's opinion without a follow-up `chorus_get_proposal` fetch — symmetric with the existing `proposal_rejected` wake, which already embeds the reviewer's reason. This SHALL apply to every proposal-approved wake regardless of whether the proposal's idea is top-level or a derived child. No new notification field is introduced; the note is carried on the existing `message`.

#### Scenario: Approve wake surfaces the note

- **WHEN** a reviewer approves a proposal with a review note and the assigned daemon agent is woken for `proposal_approved`
- **THEN** the wake prompt includes the reviewer's note text inline, so the daemon can act on the reviewer's opinion without separately fetching the proposal.

#### Scenario: Approve wake without a note is unchanged

- **WHEN** a reviewer approves a proposal without a review note
- **THEN** the wake prompt renders without a note (no empty/placeholder note text) and still directs the daemon to find the now-unblocked tasks.

#### Scenario: Reject wake note delivery is unchanged

- **WHEN** a reviewer rejects a proposal with a reason
- **THEN** the `proposal_rejected` wake prompt continues to embed that reason inline exactly as before this change.
