## MODIFIED Requirements

### Requirement: A coalesced batch is accounted as a single turn without stuck queued rows

A coalesced batch SHALL be reported as one running turn. The daemon SHALL emit an execution snapshot in which merged-away resources are no longer present as queued; the session-anchor running row SHALL be synthesized from batch attribution so server reconciliation clears merged-away execution rows.

With the exact-identity protocol, the daemon SHALL report the actual batch member turn UUIDs, the selected primary UUID and a stable admissionUuid retained across retries. On first admission the server SHALL atomically validate current authorization, origin, same-session membership, unique identifiers and pending state, advance the primary to running, and settle only the other specified members as terminal merged. A retry with the identical persisted admission identity and members SHALL return the same still-valid running/merged outcome after rechecking authorization and origin, without further settlement. It MUST NOT admit arbitrary already-running work or settle an unrelated older pending turn. A rejected batch admission MUST NOT start model execution or partially settle members. Prompt-only events without a persisted turn SHALL NOT fabricate batch member identifiers or consume additional FIFO turns.

For legacy clients without the capability, the server SHALL retain the existing coalescedCount behavior: advance the oldest pending turn and settle the next count minus one pending turns by ascending seq. The exact-identity guarantee SHALL NOT be attributed to that fallback. A turn absent from an identified batch, including one created after queue drain, SHALL survive for another batch. No new execution-status value is required.

#### Scenario: Merged-away queued resources clear from the UI
- **WHEN** four resources were shown queued for a session and they are coalesced into one running batch
- **THEN** the next execution snapshot no longer lists merged-away resources as queued and reconciliation shows one running entry without those leftover queued resources

#### Scenario: Coalesced-away pending turns are settled by count
- **WHEN** a legacy daemon without exact identity reports coalescedCount = N
- **THEN** the server advances the oldest pending turn and merges the next N minus one pending turns in that session, preserving legacy compatibility

#### Scenario: A turn arriving after the drain survives
- **WHEN** a notification creates a turn after the daemon drains its batch
- **THEN** that turn is not among the exact batch identifiers and MUST remain pending rather than being settled as merged

#### Scenario: Exact batch members exclude older missed work
- **WHEN** a batch contains known turns B and C but older pending A was never admitted to its queue
- **THEN** B and C alone SHALL be accounted for and A MUST remain untouched

#### Scenario: Invalid batch membership rejects atomically
- **WHEN** any exact member is unauthorized, belongs to another session or origin, is duplicated, or is no longer pending without a matching valid admission retry
- **THEN** the server MUST reject without partially advancing other members and the daemon MUST NOT execute that rejected batch

#### Scenario: Lost successful batch acknowledgment is recoverable
- **WHEN** admission commits a batch but its successful response is lost
- **THEN** an identical authorized retry MUST return that same batch result without separately replaying merged members
- **AND** unrelated older pending work MUST remain untouched
