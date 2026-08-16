## Context

Chorus intentionally uses loose coupling between a worker on a child resource
and an orchestrator coordinating a larger theme. The server does not subscribe a
parent Idea assignee to every child transition. Instead, the worker decides when
it has reached a human gate or completed its resource and explicitly mentions the
orchestrator.

That protocol currently lacks a durable identity source. `Idea` and `Task` store
`assignedByUuid`, but the schema comments, response formatter, and Task batch
reader assume it is always a user UUID. Agent-driven assignment can therefore
persist an agent UUID that reads back as `assignedBy: null`. Daemon prompts add
guidance about the current notification actor, not the stable assigner, so later
wakes and resumed turns cannot reconstruct who should receive the handoff.

The elaboration decisions establish:

- orchestrator means the latest explicit **agent** assigner;
- provenance uses the existing assignment audit pair, extended with type;
- an agent self-claim must not make the worker its own orchestrator;
- every Idea/Task wake and resume repeats the orchestrator identity;
- user assigners remain audit data but are not agent orchestrators; and
- handoff occurs at human gates and child completion, not every internal stage.

## Goals / Non-Goals

**Goals:**

- Preserve typed assignment provenance for both user and agent assigners.
- Give a woken Idea/Task worker a stable, directly mentionable agent
  orchestrator on every daemon turn.
- Keep notification actor/requester attribution separate from orchestrator
  attribution.
- Make the worker handoff rule explicit and consistent across Chorus agent
  workflow surfaces.
- Preserve compatibility with existing assignments and agent-instance assignees.

**Non-Goals:**

- Automatic child-state subscriptions or child-to-parent Idea traversal.
- Deriving an orchestrator from a parent/container Idea assignee.
- Treating a human assigner as an agent orchestrator.
- Orchestrator offline liveness, catch-up, retries, or delivery guarantees.
- Idea-level dependencies, theme-level Yolo delegation, or a new assign-Idea MCP
  tool.
- Changing assignee ownership, instance pinning, notification recipients, or
  existing human approval rules.

## Decisions

### 1. Extend assignment provenance instead of adding orchestrator columns

`Idea` and `Task` gain nullable `assignedByType` alongside `assignedByUuid`.
Writers set both fields atomically and readers resolve the pair through the
existing actor-name layer. This preserves one source of truth: an agent assigner
is an orchestrator by protocol, while a user assigner remains ordinary assignment
audit metadata.

An independent `orchestratorType/orchestratorUuid` pair was rejected because it
would duplicate the assigner identity and create ambiguous reassignment and
release semantics. Persisting display names was rejected because names can
change; prompts and API responses resolve the current name from the typed UUID.

The migration is DDL-only and leaves legacy rows unchanged. Runtime readers
classify a null-type, non-null UUID against same-company User and Agent rows:
resolve a matching user first, then an agent, without inventing a type for an
unknown UUID. New writes always persist an explicit type when a provenance UUID
is present.

### 2. Distinguish self-claim from explicit dispatch

Agent self-claim writes no assignment provenance. It cannot establish a useful
orchestrator because the assigner and worker are the same actor. An explicit
assignment or reassignment records the authenticated dispatching actor's
`user|agent` type and UUID. A later explicit reassignment replaces both fields;
release clears both.

Human assignment to self may retain user provenance for audit compatibility, but
the daemon never promotes a `user` provenance record to orchestrator guidance.
Agent-instance assignment affects only the assignee identity and pin. The
assigner remains the authenticated user or agent, never an `agent_instance`.

### 3. Resolve orchestrator attribution at the server transport boundary

A shared company-scoped resolver accepts a directly addressed resource type and
UUID:

- `idea` reads that Idea's typed assignment provenance;
- `task` reads that Task's typed assignment provenance;
- other entity types return no orchestrator.

The resolver returns an orchestrator only when the resolved provenance type is
`agent` and the agent still exists in the company. It performs no parent,
proposal, document, root-Idea, or Idea-lineage traversal.

Notification detail serialization uses this helper so every autonomous
notification wake for a directly addressed Idea/Task can carry:

```text
orchestrator: { type: "agent", uuid, name } | null
```

The resume-control server path uses the same helper before publishing a
synthetic `resource_resumed` event, so resumed Idea/Task wakes receive the same
attribution. Keeping resolution on the server avoids extra daemon API calls and
ensures new turns and resumes apply identical company scoping.

### 4. Append one shared orchestrator prompt block

`cli/prompts.mjs#buildPrompt` continues to build its action-specific body first.
For every non-null body, it appends a compact shared block when
`notification.orchestrator.type === "agent"`:

```text
Your orchestrator for this resource is @Name.
At a human gate or when this child resource is complete, hand control back by
commenting on the resource and mentioning @[Name](agent:uuid).
```

The existing headless preamble and per-action actor/requester guidance remain
unchanged. This separation matters when the actor who caused the current wake is
not the orchestrator. Unknown actions and empty human instructions remain null;
the shared block must never turn them into wakes.

### 5. Encode handoff as workflow discipline, not server automation

The Chorus overview and relevant Idea/Proposal/Develop workflow guidance state
that a worker with an injected agent orchestrator:

- explicitly mentions the orchestrator when it reaches a human-only gate it
  cannot cross;
- explicitly mentions the orchestrator when its child Idea or Task is complete;
  and
- does not mention the orchestrator for ordinary internal progress.

The canonical skill sources and all shipped ports are updated together, using
the repository's existing plugin-maintenance conventions. This change does not
add a status listener, implicit notification recipient, or parent subscription.

## Risks / Trade-offs

- **Legacy UUID ambiguity:** a UUID could theoretically exist in both actor
  tables. The compatibility rule prefers user, matching the historical schema
  contract; new typed writes remove ambiguity going forward.
- **Deleted assigner:** dynamic resolution can return no orchestrator after an
  agent is deleted. The prompt omits the block rather than emitting an invalid
  mention.
- **Prompt repetition:** every wake pays a small token cost. The explicit
  reliability requirement outweighs this cost, and the block is kept compact.
- **Resume-path drift:** notifications and resume controls are different
  transports. Both must call the same resolver, with tests asserting parity.
- **Skill-port drift:** duplicated skill distributions can diverge. Update and
  parity checks are part of the second implementation task.

## Migration Plan

1. Add nullable `assignedByType` columns to `Idea` and `Task` using DDL only.
2. Deploy readers with company-scoped null-type compatibility, preferring the
   historical user interpretation on ambiguity.
3. Deploy all writers with typed,
   atomic provenance updates.
4. Deploy notification/resume enrichment and daemon prompt consumption.
5. Rollback may remove prompt enrichment and stop new typed writes first. The
   nullable columns can remain harmlessly; dropping them loses only the new type
   metadata, not assignments or assignees.

## Open Questions

None.
