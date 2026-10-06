## ADDED Requirements

### Requirement: The plugin SHALL route unattended tool approvals through Chorus comments

The plugin MUST register an approval transport named `chorus` (`ctx.register_approval_transport`), activated by `security.approval.transport: chorus`. When Hermes asks for approval during a Chorus-woken gateway session, the transport MUST post a comment on that session's Chorus entity. The comment MUST @mention the agent owner, show the redacted command and description, list the allowed choices, and include a short request token. The transport MUST resolve the decision from the next owner comment on that entity that contains the token and a choice (`once` / `session` / `always` / `deny`, where `session` and `always` are accepted only when offered). On timeout, or a reply that cannot be parsed, it MUST return `deny`. Approval requests from sessions that were not started by a Chorus wake MUST fall back to the host's built-in flow.

An approval reply MUST never become a model turn. Before dispatching any live `mentioned` / `comment_added` wake, and before dispatching any pending turn with trigger `mentioned`, the adapter MUST re-read the triggering comment. If that comment matches the approval-reply grammar (`^(approve (once|session|always)|deny) [A-Z0-9]{6}\b`, case-insensitive), the adapter MUST hand it to the transport (resolving a matching pending request, if any). The wake MUST be skipped, and a pending turn MUST be closed with `turn-advance` `ended` without running the agent. This also covers replies replayed by the pending-turns sweep after a reconnect.

#### Scenario: Owner approves once

- **GIVEN** a Chorus-woken session on task T needs approval for a dangerous command
- **WHEN** the owner replies on T with `approve once <token>`
- **THEN** the transport MUST return the `once` decision correlated to that request
- **AND** the command MUST run

#### Scenario: Timeout denies

- **WHEN** no matching owner reply arrives within the request's `timeout_seconds`
- **THEN** the transport MUST return `deny`

#### Scenario: Replayed approval reply is not run as a turn

- **GIVEN** the owner's approval reply @mentions the agent and is stored as a pending turn
- **WHEN** the adapter reconnects and sweeps pending turns
- **THEN** that pending turn MUST be closed without starting a Hermes turn

#### Scenario: Non-owner reply is ignored

- **WHEN** a comment containing the token is posted by someone other than the agent owner
- **THEN** the transport MUST ignore it
