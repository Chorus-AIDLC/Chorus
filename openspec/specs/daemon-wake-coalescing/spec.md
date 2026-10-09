# daemon-wake-coalescing Specification

## Purpose
Defines how the daemon's wake scheduler coalesces multiple pending same-session
(same-key) wakes into a single batch — one subprocess / one `claude --resume`
turn — instead of one turn per wake, and how that single turn is accounted so the
coalesced-away pending turns are settled (not left stuck as `queued`/`pending`).
Batching is natural only (no debounce/collect timer, no batch-size cap);
per-key serialization and the global cross-key concurrency cap are preserved.

## Requirements

### Requirement: Coalesce pending same-key wakes into one batch
The daemon's wake scheduler SHALL, when a session key's execution slot becomes
free, drain ALL currently-pending wakes for that key and run them as a SINGLE
batch (one subprocess / one `claude --resume` turn), rather than one turn per
wake. Batching SHALL be natural only — the scheduler MUST NOT introduce a
debounce or collect timer, and MUST NOT cap the number of events merged into a
batch. Per-key serialization (the next batch waits for the current batch to
finish) and the global cross-key concurrency cap SHALL be preserved.

#### Scenario: Multiple same-key wakes arrive while the key is busy
- **WHEN** a wake for key K is executing and three more wakes for key K are enqueued before it finishes
- **THEN** when the executing wake finishes and the slot frees, the three enqueued wakes are drained together and run as one batch (one subprocess), not three separate turns

#### Scenario: Wakes for different keys still run concurrently
- **WHEN** wakes are enqueued for two different session keys and a concurrency slot is available
- **THEN** the two keys run concurrently (each as its own batch), unaffected by coalescing, up to the configured concurrency cap

#### Scenario: A single pending wake is unchanged
- **WHEN** exactly one wake is pending for a key when its slot frees
- **THEN** it runs as a batch of one, producing a prompt and turn accounting byte-identical to the pre-coalescing single-wake behavior

#### Scenario: A poisoned batch does not wedge the key
- **WHEN** a batch for key K throws during execution
- **THEN** the failure is logged and the next batch for key K is still able to run

### Requirement: Merge all same-session events regardless of trigger
The daemon SHALL coalesce every pending wake sharing a session key into the one
batch regardless of the wake's trigger type — autonomous notifications (mention,
task_assigned, proposal_*, elaboration_*, task lifecycle), human_instruction chat
messages, whole-idea directives (start_development, yolo_requested), and resume
all merge when they share the key. The combined prompt SHALL state each event's
type and content so the agent can act on each.

#### Scenario: Chat messages and autonomous events on one session merge
- **WHEN** two human_instruction chat messages and a mention notification for the same session are pending together
- **THEN** all three are delivered in one turn, each shown as its own labeled event block, and the human_instruction bodies are included

#### Scenario: A whole-idea directive merged with other events is labeled, not dropped
- **WHEN** a yolo_requested (or start_development) wake and a mention wake for the same session are pending together
- **THEN** both appear as labeled event blocks in the one turn's prompt; neither is silently dropped or run as a hidden separate turn

### Requirement: Batch prompt uses a backlog preamble with per-event blocks and same-entity collapse
For a batch of more than one event, the daemon SHALL build a single prompt that
begins with the headless preamble and a short backlog preamble, followed by one
labeled block per event in arrival order, reusing the existing per-action prompt
body for each block. Multiple events that share the same entity and action SHALL
be collapsed into one block that states the occurrence count and shows the newest
message — EXCEPT `human_instruction`, which SHALL NEVER be collapsed: every chat
message SHALL render its full body as its own block, in arrival order, because its
text lives only on the turn and is not re-fetchable. Events whose body would be
empty SHALL be omitted from the prompt.

#### Scenario: Three comments on one idea collapse to one block
- **WHEN** three `mentioned` events on the same idea are in one batch
- **THEN** the prompt contains a single block for that idea noting three occurrences and showing the newest comment, not three near-duplicate blocks

#### Scenario: Multiple chat messages are each shown in full
- **WHEN** three `human_instruction` chat messages for the same session are in one batch
- **THEN** all three instruction texts appear in full, as three separate blocks in arrival order — none is collapsed away or reduced to "newest only"

#### Scenario: Distinct events render as separate ordered blocks
- **WHEN** a batch contains events for different entities or different actions
- **THEN** each renders as its own labeled block, ordered by arrival, under one shared backlog preamble

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
