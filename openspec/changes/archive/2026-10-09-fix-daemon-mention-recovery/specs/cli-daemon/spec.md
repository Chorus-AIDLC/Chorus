## ADDED Requirements

### Requirement: Retryable delivery preserves routing eligibility

The daemon SHALL distinguish in-flight routing from successfully accepted work. A transient read, resolution, or enqueue failure MUST leave the original event eligible for retry, while concurrent notification and directed-turn delivery MUST admit the same identified work at most once per connection lifetime.

#### Scenario: Both initial delivery reads fail
- **WHEN** a comment notification read and its pending-turn GET fail before enqueue, then transport recovers
- **THEN** later recovery MUST be able to accept that same turn once
- **AND** a failed attempt MUST NOT leave a successful dedup marker

#### Scenario: Two routes race with a failing first attempt
- **WHEN** a broadcast and a directed ping refer to the same identified turn and the first in-flight route fails
- **THEN** the second route or recovery MUST retain eligibility without duplicate acceptance
- **AND** targeting and suppression MUST remain unchanged

### Requirement: Recover delivery independently of SSE disconnection

For protocol-supported work with reliable identity, the daemon SHALL retry transient delivery failures independently of SSE stream health, using bounded request deadlines, capped backoff, coalesced connection-scoped requests, and retained recovery responsibility. Permanent authorization or identity failures MUST be diagnosed rather than hot-looped or redirected.

#### Scenario: Heartbeats continue while REST fails
- **WHEN** SSE heartbeat bytes continue while REST delivery reads fail temporarily
- **THEN** recovery MUST occur after reads recover without requiring a new chat, service restart, or SSE disconnect

#### Scenario: New chat does not stand in for old recovery
- **WHEN** a newer chat turn arrives while a prior comment awaits recovery
- **THEN** both identities MUST be retained and the new chat MUST NOT be treated as successful delivery of the prior comment

#### Scenario: Shutdown or connection replacement races with a read
- **WHEN** a delayed recovery response completes after stop or after a different connection generation registers
- **THEN** it MUST NOT enqueue work for the stopped or obsolete connection
- **AND** stopping MUST cancel recovery timers and abort cancellable reads

### Requirement: Autonomous recovery uses durable authorized identity

For new protocol-supported autonomous wakes, the server SHALL persist versioned source notification context associated with the exact turn before publishing delivery. Recovery MUST NOT depend on notification unread status or guess a notification from trigger similarity. All reads and admissions MUST enforce current tenant, agent, origin and resource visibility boundaries.

#### Scenario: The source notification is already read
- **WHEN** an authorized pending turn has durable source context but its notification is read or outside the unread window
- **THEN** recovery MUST reconstruct the exact original wake without unread-list matching

#### Scenario: Legacy context is ambiguous
- **WHEN** an older pending turn lacks a provable source association
- **THEN** recovery MUST report the limitation and MUST NOT guess, replay unrelated work, or mark it successfully handled

#### Scenario: Visibility has been revoked
- **WHEN** a previously authorized pending turn is no longer accessible to the agent
- **THEN** recovery MUST NOT expose its context or execute it

### Requirement: Wake lifecycle follows actual admitted turn identities

The new daemon protocol SHALL carry exact turn identities through ordinary and coalesced wake admission, lifecycle reporting and transcript attribution. An identified wake MUST NOT consume an unrelated oldest-pending turn. Existing legacy clients SHALL remain compatible without silently acquiring the new protocol's guarantees.

#### Scenario: A missed comment precedes a runnable chat
- **WHEN** a chat turn is admitted while an older comment turn remains pending
- **THEN** the chat's lifecycle and transcript MUST belong to the chat turn, not the older comment
- **AND** successful recovery of the comment MUST retain its original identity

#### Scenario: A batch skips an undelivered historical turn
- **WHEN** coalescing contains known turns B and C while older A was never accepted
- **THEN** batch settlement MUST reference B and C explicitly and MUST NOT consume A by count-based FIFO inference

#### Scenario: Exact admission is refused
- **WHEN** the server refuses an identified turn due to authorization, origin, state or identity
- **THEN** the daemon MUST NOT start that wake's model execution or substitute another pending turn

#### Scenario: Admission transiently fails before commit
- **WHEN** exact single or batch admission fails transiently before the server commits
- **THEN** the waker MUST retain that batch and retry with the same admission identity without releasing a duplicate queue owner
- **AND** successful recovery MUST start the model exactly once for the original members

#### Scenario: Admission commits but its response is lost
- **WHEN** the server commits admission but the daemon loses its response
- **THEN** retry with the same admissionUuid, primary turn and members MUST return the same still-valid result without advancing or merging other turns
- **AND** the model MUST start only after confirmed admission, at most once

#### Scenario: Stop occurs during uncertain admission
- **WHEN** shutdown interrupts retry while admission may already have committed
- **THEN** the daemon MUST stop retry/spawn, retain exact identity for safe settlement, and MUST NOT falsely report model execution

#### Scenario: Canonical session origin moves after admission
- **WHEN** connection A admits a turn and the canonical session is subsequently routed to connection B
- **THEN** A SHALL still be able to end or interrupt its exact admitted turn using persisted admission ownership and the original token and members, subject to current tenant, agent and resource access checks
- **AND** B MUST NOT settle A's execution, while A MUST NOT admit new work or replay launch admission against B's current session origin

### Requirement: Delivery failure diagnostics are actionable and secret-safe

Delivery diagnostics SHALL identify the failed operation, work identifiers, safe cause/status and planned recovery without exposing credentials or full prompts.

#### Scenario: HTTP connection resets
- **WHEN** a delivery read fails with ECONNRESET
- **THEN** diagnostics MUST preserve that safe cause code and the recovery attempt context without printing Authorization or API keys
