## ADDED Requirements

### Requirement: Daemon flushes a turn's transcript before marking it terminal

The daemon SHALL flush any buffered (debounced) transcript for a wake's session to the
server BEFORE it advances that turn to a terminal status (`ended` or `interrupted`), so a
turn's trailing user/assistant text is persisted while the turn is still `running` and
attaches to the correct turn. The transcript upload hooks SHALL expose an `onSessionEnd`
operation that cancels the pending debounce timer and awaits the in-flight and buffered
batch. The flush SHALL be best-effort and non-throwing: a flush failure is logged and
never crashes or blocks the wake's exit path.

#### Scenario: Trailing transcript is flushed on clean subprocess exit

- **WHEN** a woken `claude` subprocess emits an assistant text message and then exits
  cleanly (code 0) within the transcript debounce window
- **THEN** the daemon flushes the buffered transcript to `POST /api/daemon/transcript`
  before it advances the turn to `ended`
- **AND** the turn shows the assistant's reply rather than "no conversation record".

#### Scenario: Active-session transcript is flushed on daemon shutdown

- **WHEN** the daemon is shutting down and a wake subprocess is interrupted mid-turn
- **THEN** the wake's exit path flushes the session's buffered transcript before advancing
  the turn to `interrupted`, within the bounded shutdown drain window.

### Requirement: Daemon retries a failed transcript upload before dropping it

The daemon's transcript upload SHALL retry a failed POST (transient network error or
non-2xx response) with a bounded number of attempts and backoff before giving up. If all
attempts fail, the daemon SHALL drop the batch with a single loud warning that names the
number of lost messages. The retry SHALL live in the transcript upload hook, not in the
shared single-shot REST client.

#### Scenario: Transient upload failure is retried and succeeds

- **WHEN** the first transcript POST for a turn returns a transient error (e.g. HTTP 502)
  and a subsequent attempt would succeed
- **THEN** the daemon retries within the attempt budget and the transcript is persisted
- **AND** no transcript is lost.

#### Scenario: Persistent upload failure is dropped loudly, not silently

- **WHEN** every attempt in the retry budget fails
- **THEN** the daemon logs a warning naming the dropped message count
- **AND** does not crash the wake.

### Requirement: Duplicate unconsumed human instructions collapse to one turn

The server SHALL NOT create a duplicate `human_instruction` turn when the same session
already has an unconsumed (`status = "pending"`) `human_instruction` turn with identical
instruction text; it SHALL instead return the existing turn and re-issue its delivery
ping. The collapse SHALL apply ONLY to the same session, a `pending` turn (never a
`running` or terminal turn), the `human_instruction` trigger, and an exact text match — so
distinct instructions, and re-sends after the prior turn has started, still create new
turns.

#### Scenario: Retrying the same instruction does not pile up empty turns

- **WHEN** a user sends an instruction, sees no visible response, and sends the identical
  instruction text again while the first turn is still `pending`
- **THEN** the server returns the existing pending turn rather than creating a second one
- **AND** the conversation does not accumulate duplicate empty turns 2 / 3 / 4.

#### Scenario: A different instruction still creates a new turn

- **WHEN** a user sends an instruction whose text differs from any pending instruction on
  the session, or whose prior identical turn has already advanced to `running`
- **THEN** the server creates a new `human_instruction` turn.

### Requirement: Sending an instruction gives explicit success feedback

The daemon-session reply UI SHALL give the user an explicit success signal when an
instruction send is accepted by the server (HTTP 2xx), so the user is not left guessing
whether the send worked and does not blindly retry. Send failures SHALL continue to
surface their server-provided reason.

#### Scenario: A successful send is confirmed to the user

- **WHEN** the user sends an instruction and the server responds 2xx
- **THEN** the UI shows an explicit success confirmation
- **AND** the compose input is cleared.

### Requirement: An empty terminal instruction turn reads honestly and offers retry

The UI SHALL present a `human_instruction` turn that has reached a terminal status
(`ended` or `interrupted`) and produced no visible messages as a comprehensible "turn
ended without a reply" state with a one-click retry that re-sends the same instruction
text — rather than a neutral dead-end "this turn kept no conversation record". Autonomous
turns (non-`human_instruction`) SHALL keep the existing neutral no-messages placeholder.
All new user-facing strings SHALL be localized in every supported locale (en, zh, ko, ja).

#### Scenario: Empty ended human-instruction turn offers a retry

- **WHEN** a `human_instruction` turn is terminal and has no visible messages
- **THEN** the turn band shows a "turn ended without a reply" message and a Retry action
- **AND** activating Retry re-sends the same instruction text as a new turn.

#### Scenario: Empty autonomous turn keeps the neutral placeholder

- **WHEN** an autonomous (non-`human_instruction`) turn has no visible messages
- **THEN** the turn band shows the existing neutral no-messages placeholder without a
  retry action.

### Requirement: A known transcript-relay failure is surfaced on the turn

The system SHALL record and surface a KNOWN transcript-relay failure on the turn it
belongs to, so a turn whose reply was produced but never uploaded reads as "the reply
could not be uploaded" rather than the misleading "no reply received". When the daemon's
transcript upload finally fails for a turn (retry budget exhausted / non-2xx / network),
the daemon SHALL forward the failure reason on the same exit-path turn-advance report it
already sends, on the terminal edge. The server SHALL persist this reason as an annotation
on the turn WITHOUT changing the turn's terminal status (a clean exit stays `ended`), and
SHALL expose it in the turn view. The annotation SHALL be written only on a terminal edge
(never on `running`), and SHALL be absent when the upload succeeded. The UI SHALL, for a
terminal turn that carries a relay-failure annotation and shows no messages, present a
distinct honest message (with the raw reason available on hover) and — for a
`human_instruction` turn — a one-click retry; a turn that DID relay text SHALL render its
messages normally. All new user-facing strings SHALL be localized in every supported
locale (en, zh, ko, ja).

#### Scenario: A relay-failed reply is reported honestly, not as "no reply"

- **WHEN** a turn's transcript upload fails after the retry budget is exhausted and the
  wake exits
- **THEN** the daemon forwards the failure reason on the terminal turn-advance, the server
  persists it on the (still-`ended`) turn, and the UI shows "the reply could not be
  uploaded" with the reason on hover — not "no reply received".

#### Scenario: A successful relay leaves no annotation

- **WHEN** a turn's transcript upload succeeds (possibly after a retry)
- **THEN** no relay-failure annotation is recorded on the turn
- **AND** the turn renders its messages normally.

#### Scenario: The annotation never alters turn status

- **WHEN** a relay-failure reason accompanies a `→ running` transition
- **THEN** the server ignores it (the annotation is terminal-only), so a resumed turn
  never carries a stale relay failure.
