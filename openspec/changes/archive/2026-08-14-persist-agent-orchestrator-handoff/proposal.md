## Why

A worker agent can only hand control back to its orchestrator if the worker can
reliably identify that orchestrator. Today Idea and Task assignments retain only
`assignedByUuid`, readers assume that UUID is a user, and daemon wakes carry only
the current event actor, so an agent assigner is lost and long-running workers
cannot reliably perform a loose-coupled handoff.

## What Changes

- Persist typed assignment provenance on Ideas and Tasks as
  `assignedByType + assignedByUuid`, resolving display names dynamically.
- Treat the most recent explicit agent assigner as the resource's orchestrator.
  Agent self-claim does not create a self-orchestrator; explicit reassignment
  replaces provenance and release clears it.
- Enrich every daemon wake and resume for an Idea or Task with the resource's
  agent orchestrator, without deriving an orchestrator from Idea lineage.
- Add a shared daemon prompt block that restates the orchestrator mention on
  every non-null wake while preserving the current notification actor.
- Update Chorus agent workflow guidance so workers hand off at human gates and
  at child-resource completion by explicitly mentioning their orchestrator.
- Keep user assigners as assignment audit metadata, but do not label or inject
  them as agent orchestrators.

## Capabilities

### New Capabilities

- `agent-orchestrator-handoff`: Typed assignment provenance, stable daemon wake
  attribution, and the loose-coupled worker-to-orchestrator handoff protocol.

### Modified Capabilities

None.

## Impact

- **Schema and migration:** nullable `assignedByType` on `Idea` and `Task`, with
  DDL-only migration and read-time classification of legacy provenance against
  company-scoped User/Agent identities.
- **Assignment services and entry points:** Idea/Task claim, assignment,
  reassignment, release, conversational assignment, MCP assignment, response
  formatting, fixtures, and tests.
- **Notification and resume transport:** server-side notification detail and
  resume-control payload enrichment for directly addressed Ideas and Tasks.
- **Daemon client:** `cli/prompts.mjs` prompt composition and wake tests.
- **Agent workflow docs:** canonical Chorus stage skills and their distributed
  plugin/public ports.
- **No new dependency, permission bit, automatic child-to-parent subscription,
  Idea-lineage traversal, or liveness/catch-up behavior.**
