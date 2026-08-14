## ADDED Requirements

### Requirement: Autonomous wakes resolve the agent-owner's fixed project cwd
Autonomous server-minted wakes SHALL resolve a fixed project-Agent cwd before falling back to raw first-online-connection selection, closing the gap where only UI-threaded and stage-advance wakes honored the fixed anchor. The project pin SHALL replace exactly the first-online ("first cwd") fallback and SHALL sit below the existing higher-priority resolution steps: it SHALL apply only when the selection would otherwise be a raw first-online pick — that is, when no idea/task instance pin, no pre-resolved cwd target, and no existing ONLINE idea-session-origin apply. An existing online idea-session-origin (the cwd where the idea's live conversation already runs) SHALL take precedence over the project pin so a live conversation is never rerouted. When those higher-priority steps do not apply, Chorus SHALL look up the `ProjectAgentCwdPreference` of that **Agent's owner** for the wake's `(project, Agent)` pair, and when one exists SHALL treat its `(host, cwd)` as a hard execution anchor and SHALL NOT select the first online connection. When the Agent owner has no preference for that `(project, Agent)`, resolution SHALL fall back to the existing online-first behavior unchanged. This change SHALL add no database schema change, no migration, and no new permission bit.

#### Scenario: Autonomous wake uses the owner's project pin instead of the first cwd
- **WHEN** an autonomous wake is minted for an Agent that has a fixed project cwd pin set by its owner, the Idea/Task carries no instance pin, and the Agent is online in that pinned cwd plus another cwd
- **THEN** the wake MUST target the owner-pinned `(host, cwd)`
- **AND** it MUST NOT select the other (first-online) cwd

#### Scenario: Pinned cwd offline does not reroute
- **WHEN** an autonomous wake resolves to the owner's fixed project cwd but that `(host, cwd)` has no online connection, while the same Agent is online in a different cwd
- **THEN** the wake MUST NOT reroute to the other online cwd
- **AND** it MUST follow the existing fixed-anchor hard-pin failure behavior (notify-only for a recoverable wake, reconnect backfill only to the original host and cwd)

#### Scenario: An online idea-session-origin outranks the project pin
- **WHEN** an autonomous idea-anchored wake has no instance pin, the idea already has an online session-origin in cwd A, and the Agent owner's project pin names a different cwd B
- **THEN** the wake MUST target the existing online session-origin cwd A (the live conversation)
- **AND** it MUST NOT reroute to the project-pinned cwd B

#### Scenario: No owner preference falls back to online-first
- **WHEN** an autonomous wake is minted for an Agent whose owner has no fixed project cwd preference for that project and Agent
- **THEN** resolution MUST fall back to the existing online-first selection unchanged

#### Scenario: Pre-resolved and instance-pinned wakes are unaffected
- **WHEN** a wake already carries a pre-resolved cwd target or an idea/task instance pin
- **THEN** its existing resolution precedence MUST be preserved
- **AND** the owner-project-pin step MUST NOT override it
