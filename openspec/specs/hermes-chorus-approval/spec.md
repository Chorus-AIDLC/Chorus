# hermes-chorus-approval Specification

## Purpose
TBD - created by archiving change add-hermes-plugin. Update Purpose after archive.

## Requirements

### Requirement: The plugin SHALL route unattended tool approvals through Chorus comments

The plugin MUST register an approval transport named `chorus` (`ctx.register_approval_transport`), activated by `security.approval.transport: chorus`. When Hermes asks for approval during a Chorus-woken gateway session, the transport MUST post a comment on that session's Chorus entity. The comment MUST @mention the agent owner, show the redacted command and description, list the allowed choices, and include a short request token. The transport MUST resolve the decision from the next owner comment on that entity that contains the token and a choice (`once` / `session` / `always` / `deny`, where `session` and `always` are accepted only when offered). On timeout, or a reply that cannot be parsed, it MUST return `deny`. Approval requests from sessions that were not started by a Chorus wake MUST be declined by the transport by raising an exception. Hermes 2b52acc2d treats a raised transport as `error`, which lets the host apply its fallback policy. The transport MUST NOT return `None`, which Hermes treats as `invalid` → deny with no fallback. The host's fallback policy is: with `security.approval.transport_fallback: builtin` it shows the built-in prompt, otherwise it denies. The README and the `chorus agents add` checklist MUST tell users to set `security.approval.transport_fallback: builtin`, so interactive CLI/TUI sessions keep the built-in prompt. They MUST also tell users to set `approvals.mode: manual` for unattended gateways. Under the default `smart` mode, Hermes' guardian model can approve a dangerous command before the transport is asked (`tools/approval.py:761-777`), so the owner would never see it.

An approval reply MUST never become a model turn. Before dispatching any live `mentioned` / `comment_added` wake, and before dispatching any pending turn with trigger `mentioned`, the adapter MUST re-read the triggering comment. If that comment matches the approval-reply grammar (`^(approve (once|session|always)|deny) [A-Z0-9]{6}\b`, case-insensitive), the adapter MUST hand it to the transport (resolving a matching pending request, if any). The wake MUST be skipped, and a pending turn MUST be closed with `turn-advance` `ended` without running the agent. This also covers replies replayed by the pending-turns sweep after a reconnect. Exception (fail open): the adapter may close a turn only when it can tie that turn to its comment exactly (by server timestamps). When that link is ambiguous, for example two owner comments on the same entity less than about 1s apart that are replayed after a reconnect, the turn MUST be dispatched normally rather than closed, so that an ordinary mention is never dropped. In that case the approval-reply turn may run as a model turn. The approval itself still resolves through the transport.

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

#### Scenario: Interactive session keeps the built-in prompt

- **GIVEN** `security.approval.transport: chorus` and `security.approval.transport_fallback: builtin`
- **WHEN** an interactive CLI session (not started by a Chorus wake) needs approval
- **THEN** the transport MUST decline the request
- **AND** Hermes MUST show its built-in approval prompt

#### Scenario: Non-owner reply is ignored

- **WHEN** a comment containing the token is posted by someone other than the agent owner
- **THEN** the transport MUST ignore it
