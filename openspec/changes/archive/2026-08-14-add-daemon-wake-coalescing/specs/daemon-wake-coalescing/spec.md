# daemon-wake-coalescing

## ADDED Requirements

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
A coalesced batch SHALL be reported as one running turn. The daemon SHALL emit an
execution snapshot in which the merged-away resources are no longer present as
"queued" (the session-anchor running row is synthesized from the batch attribution,
not assumed to be one of the merged resources), so the server reconcile ends them
and the UI does not show them stuck in the queued state. The daemon SHALL report
the coalesced event count on the running-transition, and the server SHALL settle
the coalesced-away pending turns of that session — after advancing the oldest
pending turn to `running`, it marks the next `count − 1` pending turns of the same
session, by ascending seq, to a terminal `merged` state — so coalesced-away turns
do not linger as `pending` (which would otherwise re-dispatch as duplicate wakes on
reconnect). A pending turn created after the batch was drained (higher seq, beyond
the reported count) SHALL survive for the next batch. No new execution-status value
and no database migration are required.

#### Scenario: Merged-away queued resources clear from the UI
- **WHEN** four resources were shown queued for a session and they are coalesced into one running batch
- **THEN** the next execution snapshot no longer lists the merged-away resources as queued, and after reconcile the UI shows one running entry and no leftover queued entries for that session

#### Scenario: Coalesced-away pending turns are settled by count
- **WHEN** the daemon coalesces N pending wakes for a session into one running batch and reports coalescedCount = N
- **THEN** the server advances the oldest pending turn of that session to `running` and marks the next N−1 pending turns (by ascending seq) as terminal `merged`, leaving turns of unrelated sessions untouched

#### Scenario: A turn arriving after the drain survives
- **WHEN** a new notification for the session arrives after the daemon drained its queue (its pending turn has a seq beyond the reported count)
- **THEN** that turn is NOT settled as merged and remains `pending` for the next batch
