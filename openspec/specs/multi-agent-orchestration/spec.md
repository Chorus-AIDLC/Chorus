# multi-agent-orchestration Specification

## Purpose
TBD - created by archiving change add-assign-idea-mcp-tool. Update Purpose after archive.
## Requirements
### Requirement: Multi-agent orchestration skill

The Chorus skill set SHALL include a standalone multi-agent orchestration skill
(`chorus:orchestrate`) that documents how an orchestrator agent coordinates other agents
across the AI-DLC lifecycle. It SHALL cover the ways Chorus supports multi-agent
collaboration — assigning ideas (`chorus_pm_assign_idea`), assigning tasks
(`chorus_pm_assign_task`), and independent review (the proposal / task / code reviewer
subagents) — and SHALL explain how to select a collaboration mode by scenario while preserving
single-owner / concurrency discipline (one responsible assignee per idea, consistent with the
daemon single-owner semantics) and the Reversed-Conversation gates (the owner gatekeeps at
proposal and verify and never merges automatically). The `/chorus` entry skill SHALL reference
this skill so an agent can route to it, and the skill SHALL be present in every plugin surface
that carries the Chorus skill set, at parity with the other stage skills.

#### Scenario: Entry skill routes to the orchestrate skill

- **WHEN** an agent consults the `/chorus` entry skill for coordinating multiple agents
- **THEN** it is directed to the `chorus:orchestrate` skill

#### Scenario: Orchestrate skill documents the delegation primitives and modes

- **WHEN** an agent reads the `chorus:orchestrate` skill
- **THEN** it describes assigning ideas and tasks to specified agents, independent review, and
  how to choose a collaboration mode for the scenario
- **AND** it states the single-owner and Reversed-Conversation constraints

