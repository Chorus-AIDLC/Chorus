## ADDED Requirements

### Requirement: An interrupt with no live subprocess SHALL report the turn as interrupted

A daemon SHALL NOT silently ignore an `interrupt` control command that passes the
connection-identity check but finds no running child for the command's
`${entityType}:${entityUuid}`. It SHALL instead report the session's turn as `interrupted`
with reason `user` through the same turn-reporting transport the wake path uses, and SHALL
log that it did so. The session business key SHALL be derived exactly as the daemon derives it
elsewhere: for the `idea` and `daemon_session` control entity types it is the command's
`entityUuid`. For any other control entity type the daemon SHALL keep logging only, because
it cannot know which session that resource belongs to. The report SHALL be
fire-and-forget: a failing or throwing report MUST NOT propagate into the SSE control loop.

#### Scenario: No child for the targeted entity

- **WHEN** an `interrupt` for `idea:<uuid>` arrives on the correct connection and the
  daemon's execution registry has no running child for it
- **THEN** the daemon SHALL advance that session's turn to `interrupted` with reason `user`
  and SHALL log that no subprocess was found

#### Scenario: A live child is still killed and not reported here

- **WHEN** an `interrupt` arrives and the registry holds a running child
- **THEN** the daemon SHALL mark the entity interrupting and kill the process tree as before,
  and SHALL NOT itself report a terminal turn — the wake path reports the resulting exit

#### Scenario: A failing report cannot break the control loop

- **WHEN** the no-child report rejects or throws
- **THEN** the control handler SHALL return normally and the failure SHALL be visible in the
  daemon log

### Requirement: A running turn SHALL always offer an interrupt control

The conversation composer SHALL render an interrupt control whenever the conversation has a
`running` turn, including when no live execution row matches the conversation. When no
execution row matches, the control's target SHALL be derived from the conversation's own
session — `idea:<directIdeaUuid>` for an idea-anchored conversation and
`daemon_session:<sessionId>` for an ad-hoc one, addressed at the session's origin
connection — using the same derivation rule the execution-matching helper applies, kept in
one shared pure function so the two cannot drift. The interrupt control MUST NOT be given a
synthesized execution row; it SHALL accept a minimal target shape that a real execution row
structurally satisfies. The zombie-clearing variant SHALL carry its own user-facing copy in
every supported locale, so a human is not told a live process was killed when none existed.
When the composer is read-only because the conversation's origin daemon is offline, its
read-only notice SHALL state that a stuck turn can still be cleared, whenever a
zombie-clearing target is present.

#### Scenario: Running turn with no matching execution row

- **WHEN** a conversation's latest turn is `running` and no execution row matches the
  conversation
- **THEN** the composer SHALL render the interrupt control targeting the conversation's own
  session key on its origin connection, with the zombie-clearing copy

#### Scenario: A stale terminal execution row alongside a running turn

- **WHEN** a conversation's latest turn is `running` while its only matching execution row is
  terminal (`interrupted`, whether the reason is `user` or `crash`) — the two disagree, so no
  live run exists
- **THEN** the composer SHALL render the zombie-clearing control rather than only that row's
  resume affordance, so the turn cannot be left permanently unclearable; and once the turn is
  no longer `running` the row's resume affordance SHALL return unchanged

#### Scenario: Running execution row present

- **WHEN** a conversation has a matching `running` execution row
- **THEN** the composer SHALL render the existing interrupt control targeting that execution
  row, with unchanged copy and behaviour

#### Scenario: Idle conversation

- **WHEN** a conversation has no `running` turn and no matching execution row
- **THEN** the composer SHALL render no interrupt control

#### Scenario: Read-only notice while a stuck turn is clearable

- **WHEN** the composer is read-only because the origin daemon is offline and a
  zombie-clearing target is present
- **THEN** the read-only notice SHALL say the stuck turn can still be cleared here, and the
  notice SHALL be unchanged when no such target is present

### Requirement: The control endpoint SHALL settle the turn when no live run can act on the interrupt

`POST /api/daemon/control` SHALL continue to publish the control event and SHALL keep its
existing authorization and non-disclosure behaviour unchanged. Additionally, for an
`interrupt` command, it SHALL settle that session's `running` turn as `interrupted` with
reason `user` — through the same turn-advance service chokepoint the daemon's own reports
use — whenever the server's own state shows no live run that could act on the command: the
target connection is not effectively online, **or** that connection reports no `running`
execution for the targeted entity. It SHALL NOT settle when the connection is effectively
online **and** reports a `running` execution for that entity, because in that window the
daemon owns the outcome. Both determinations SHALL reuse the existing company-scoped
predicates over the connection registry and execution snapshot rather than restating their
rules. The response SHALL indicate whether a settle occurred, and a failed settle SHALL NOT
fail the dispatch.

#### Scenario: Interrupt against an offline connection

- **WHEN** an authorized caller interrupts an entity whose target connection is offline and
  whose session has a `running` turn
- **THEN** the endpoint SHALL publish the control event, SHALL settle that turn as
  `interrupted` with reason `user`, and SHALL report that it settled

#### Scenario: Interrupt against an online connection with a live run

- **WHEN** an authorized caller interrupts an entity whose target connection is effectively
  online and which reports a `running` execution for that entity
- **THEN** the endpoint SHALL publish the control event, SHALL NOT settle any turn, and SHALL
  report that it did not settle

#### Scenario: Interrupt against an online connection whose reverse channel is silently dead

- **WHEN** an authorized caller interrupts an entity whose target connection is effectively
  online but which reports no `running` execution for that entity, while the session's turn
  is still `running`
- **THEN** the endpoint SHALL publish the control event, SHALL settle that turn as
  `interrupted` with reason `user`, and SHALL report that it settled

#### Scenario: Resume never settles

- **WHEN** an authorized caller issues a `resume` command, whether the connection is online
  or offline
- **THEN** the endpoint SHALL NOT settle any turn

#### Scenario: No running turn to settle

- **WHEN** an interrupt targets an offline connection whose session has no `running` turn
- **THEN** the endpoint SHALL succeed, SHALL change no turn, and SHALL report that it did not
  settle
