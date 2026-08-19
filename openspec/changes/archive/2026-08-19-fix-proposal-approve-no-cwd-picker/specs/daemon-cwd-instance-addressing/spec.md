## ADDED Requirements

### Requirement: Proposal approve/reject wakes SHALL resolve the assignee target without a picker and suppress on ambiguity

A `proposal_approved` / `proposal_rejected` wake SHALL resolve its target working directory entirely on the server, with no client-side cwd picker or preview, under all circumstances — a human approving or rejecting a proposal in the UI is never shown a cwd dialog. The resolution SHALL honor the existing wake precedence in this order:

1. A hard pin — the idea-level `AgentInstance` pin, or the agent-owner's project-fixed cwd
   (`ProjectAgentCwdPreference`) — resolved exactly as for any autonomous idea-anchored wake:
   an online pin yields a directed wake; an offline pin stays notify-only (no wake, never
   re-routed).
2. The idea's existing ONLINE session-origin connection (the proposal-writing wake session
   origin), directed there — unchanged from the existing proposal-wake session-origin
   behavior.

When none of the above resolves a target (the selection would otherwise fall to
agent-overall online-first), the wake SHALL be **unambiguous-online-only**. The online
connection count is taken over the **recipient agent** — the wake's notification recipient
(`proposal.createdByUuid`), which is the idea's assignee agent in the common flow (proposal
creator == idea worker):

- If the recipient agent has **exactly one** online connection, the wake SHALL be delivered
  to that connection (a directed wake), and it SHALL NOT persist any durable `agent_instance`
  pin on the idea as a side effect.
- If the recipient agent has **two or more** online connections, the wake SHALL be
  suppressed as notify-only: NO turn is created, NO connection is woken, `suppressWake` is
  stamped so every connection suppresses its broadcast copy, and the already-recorded
  notification stands as the plain record. The wake SHALL NOT be delivered to an arbitrary
  first-online connection and SHALL NOT present a picker.
- If the recipient agent has **no** online connection, the wake is notify-only exactly as
  before (no turn; the notification stands).

In every suppressed / notify-only case the in-app notification and activity record SHALL be
preserved — only the daemon wake is suppressed. No confirmation dialog or cwd picker SHALL
be shown for a proposal approve/reject at any point.

#### Scenario: Approve with no pin and two online cwds is notify-only

- **GIVEN** a pending proposal whose input idea is assigned to a bare agent with two online connections, no idea instance pin, no online session-origin, and no agent-owner project cwd pin
- **WHEN** the proposal is approved and the `proposal_approved` wake is dispatched
- **THEN** the wake MUST create no turn and wake no connection
- **AND** it MUST stamp `suppressWake` so every online connection suppresses its broadcast copy
- **AND** the notification MUST still be recorded as the plain record
- **AND** no cwd picker MUST be presented

#### Scenario: Approve with no pin and exactly one online cwd wakes that cwd

- **GIVEN** a pending proposal whose input idea is assigned to a bare agent with exactly one online connection and no pin or session-origin
- **WHEN** the proposal is approved and the `proposal_approved` wake is dispatched
- **THEN** the wake MUST be delivered to that single online connection (directed)
- **AND** it MUST NOT persist a durable `agent_instance` pin on the idea

#### Scenario: Reject with no pin and two online cwds is notify-only

- **GIVEN** a pending proposal whose input idea is assigned to a bare agent with two online connections and no pin or session-origin
- **WHEN** the proposal is rejected and the `proposal_rejected` wake is dispatched
- **THEN** the wake MUST be suppressed as notify-only (`suppressWake`, no turn) rather than delivered to a first-online connection

#### Scenario: A pinned or session-origin idea still directs the approve wake

- **GIVEN** a pending proposal whose input idea has an online idea-level instance pin (or an online session-origin, or an agent-owner project-fixed cwd)
- **WHEN** the proposal is approved
- **THEN** the wake MUST be directed to that resolved connection exactly as for any autonomous idea-anchored wake, regardless of how many other connections are online

#### Scenario: An offline assignee approve is notify-only

- **GIVEN** a pending proposal whose input idea's assignee agent has no online connection
- **WHEN** the proposal is approved
- **THEN** the wake MUST create no turn and the notification MUST stand as the plain record
