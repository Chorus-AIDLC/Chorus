## ADDED Requirements

### Requirement: Agent mentions in comments render as online-aware badges

In the comment area, every agent `@mention` SHALL render as an interactive badge that
shows the agent's display name and an online-status indicator. User `@mentions` SHALL be
unchanged. For a mention pinned to a specific instance (`@[Name](agent:uuid?cwd=…&host=…)`),
the online indicator SHALL reflect that exact instance: it is online if and only if a
connection exists for the same `(agentUuid, host, cwd)` whose `effectiveStatus` is
`online`. For a non-pinned agent mention, the online indicator SHALL reflect the agent's
overall liveness: online if and only if any connection for that `agentUuid` is `online`.
Badge rendering SHALL be confined to the comment area; other surfaces that render mentions
(idea, proposal, task, and document descriptions) SHALL keep their existing rendering.

#### Scenario: Pinned mention shows instance-precise online dot

- **WHEN** a comment contains `@[Name](agent:uuid?cwd=/work&host=prod)` and a connection
  for that exact `(agentUuid, host="prod", cwd="/work")` has `effectiveStatus === "online"`
- **THEN** the mention renders as a badge with the agent name and an online indicator

#### Scenario: Pinned mention shows offline when that instance is not online

- **WHEN** a comment contains a pinned agent mention and no connection for that exact
  `(agentUuid, host, cwd)` is online (even if the agent is online elsewhere)
- **THEN** the badge renders with an offline indicator

#### Scenario: Non-pinned mention shows agent-overall online dot

- **WHEN** a comment contains `@[Name](agent:uuid)` with no instance suffix and at least
  one connection for that `agentUuid` has `effectiveStatus === "online"`
- **THEN** the badge renders with an online indicator

#### Scenario: User mentions are not badge-ified

- **WHEN** a comment contains a user mention `@[Name](user:uuid)`
- **THEN** it renders with the existing mention text style and no online indicator or badge
  behavior

### Requirement: Clicking a mention badge opens an identity popover

Clicking an agent mention badge SHALL open a popover. The popover SHALL display a minimal
identity set: the agent name and its online status. For a pinned mention, the popover SHALL
additionally display the instance's working directory (`cwd`) and host, formatted for
display. For a non-pinned mention, the popover SHALL NOT display a `cwd` or host, because
no single instance is identified. The badge and its popover SHALL be visible to all users
regardless of whether they own the agent.

#### Scenario: Popover for a pinned mention shows cwd and host

- **WHEN** a user clicks the badge of a pinned agent mention
- **THEN** the popover shows the agent name, online status, and the instance's cwd and host

#### Scenario: Popover for a non-pinned mention omits cwd and host

- **WHEN** a user clicks the badge of a non-pinned agent mention
- **THEN** the popover shows the agent name and overall online status, and shows no cwd or
  host

#### Scenario: Non-owner sees the badge and popover

- **WHEN** a user who does not own the mentioned agent clicks its badge
- **THEN** the popover opens and shows the identity information

### Requirement: Owner-only, online-only Open conversation action

The mention popover SHALL contain an "Open conversation" action that is shown ONLY when
both conditions hold: the current user is the owner of the mentioned agent
(`agent.ownerUuid` equals the current user's UUID, mirroring the server-side owner rule),
AND the relevant target is online (the pinned instance for a pinned mention, or the agent
overall for a non-pinned mention). When either condition is false the action SHALL be
hidden (not merely disabled). Activating the action SHALL open the existing daemon chat
interface targeted at the mentioned agent: for a pinned mention, focused on that
`(host, cwd)` instance; for a non-pinned mention, focused on the agent so the owner can
select the instance/conversation within the chat. The action SHALL NOT change the existing
daemon chat or presence-modal behavior for any other entry point.

#### Scenario: Owner of an online pinned instance sees and uses Open conversation

- **WHEN** the agent's owner opens the popover for a pinned mention whose instance is online
- **THEN** the "Open conversation" action is shown, and activating it opens the daemon chat
  focused on that instance

#### Scenario: Owner of a non-pinned online agent opens chat to pick an instance

- **WHEN** the agent's owner opens the popover for a non-pinned mention and the agent is
  online
- **THEN** the "Open conversation" action is shown, and activating it opens the daemon chat
  focused on that agent so the owner can choose the instance/conversation

#### Scenario: Non-owner never sees Open conversation

- **WHEN** a user who is not the agent's owner opens the popover (online or offline)
- **THEN** the "Open conversation" action is not shown

#### Scenario: Offline hides Open conversation even for the owner

- **WHEN** the agent's owner opens the popover but the relevant target (pinned instance, or
  the agent overall for a non-pinned mention) is offline
- **THEN** the "Open conversation" action is not shown

### Requirement: Client mention parsing supports the instance suffix

The client-side comment mention renderer SHALL parse the optional instance suffix
`?cwd=…&host=…` of an agent mention token, reusing the shared pin codec, so that a pinned
mention is recognized rather than rendered as raw text. A non-pinned mention SHALL continue
to parse exactly as before (no pinned host or cwd).

#### Scenario: Pinned token is parsed into host and cwd

- **WHEN** the comment renderer encounters `@[Name](agent:uuid?cwd=%2Fwork&host=prod)`
- **THEN** it parses a mention with the agent UUID, pinned host `prod`, and pinned cwd
  `/work`, and renders a badge (not raw text)

#### Scenario: Non-pinned token parses with no pin

- **WHEN** the comment renderer encounters `@[Name](agent:uuid)`
- **THEN** it parses a mention with the agent UUID and no pinned host or cwd
