# daemon-single-active-session Specification

## Purpose
Guarantee that when the same agent has multiple online daemon connections, an un-pinned
autonomous idea-anchored wake advances an entity on at most ONE connection — deterministically
narrowing the wake instead of broadcasting to every connection — so concurrent sessions of one
agent never duplicate work (duplicate elaboration rounds, near-duplicate comments) on the same
entity.

## Requirements
### Requirement: Deterministic single-connection narrow for autonomous idea-anchored wakes

The wake chokepoint SHALL, for a residual-family (autonomous idea-anchored, including
un-pinned `@mention`) trigger whose connection selection would otherwise remain
`online_first` after the instance-pin, idea-session-origin, and project-owner-cwd-pin
steps, narrow the wake to exactly one online connection — the deterministic first-online
connection from the agent's stable connection ordering — and deliver it as a directed wake
so that no more than one of the agent's connections wakes for that wake.

The narrow SHALL preserve the existing selection precedence: it applies only when no
instance/mention cwd pin matched, no online idea-session origin exists, and no project-owner
cwd pin matched. It SHALL NOT alter human-directed, pinned, offline-pin, or fully-offline
selections.

#### Scenario: Un-pinned autonomous idea-anchored wake with multiple online connections narrows to one

- **WHEN** an agent has two or more online connections and receives an un-pinned autonomous
  idea-anchored wake (e.g. `task_assigned` / `elaboration`) that resolves to `online_first`
- **THEN** the wake is delivered to exactly one connection (a directed wake carrying that
  connection as `targetConnectionUuid`) and every other connection suppresses its broadcast copy

#### Scenario: Concurrent wakes for the same idea converge on the same connection

- **WHEN** two wakes for the same `(agent, idea)` are resolved against the same set of online
  connections
- **THEN** both resolve to the same target connection, so the same agent's concurrent
  sessions do not each independently advance the idea

#### Scenario: An online idea-session origin still takes precedence over the narrow

- **WHEN** the idea already has an online `DaemonSession` origin connection
- **THEN** the wake is directed to that origin connection and the deterministic narrow does
  not override it

#### Scenario: Pinned and directed wakes are never narrowed

- **WHEN** a wake carries an instance/mention cwd pin, or is a `human_instruction`
- **THEN** the narrow does not apply: an online pin is delivered to its pinned connection, an
  offline pin stays notify-only, and `human_instruction` follows its own send path

#### Scenario: Un-pinned mention narrows but a pinned mention stays directed

- **WHEN** an agent with multiple online connections receives an un-pinned `@mention` wake
- **THEN** the wake narrows to one connection; **AND WHEN** the mention carries an explicit
  `(host, cwd)` pin, it is delivered to that pinned connection instead (unchanged)

#### Scenario: Fully offline or single-connection agents are unaffected

- **WHEN** the agent has no online connection, or exactly one online connection
- **THEN** behavior is unchanged: no online connection yields no turn, and a single online
  connection receives the wake as before

