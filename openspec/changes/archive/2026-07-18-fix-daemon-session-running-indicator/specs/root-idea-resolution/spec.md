## ADDED Requirements

### Requirement: The daemon lineage resolver SHALL emit a visible warning when a root idea resolves with no direct idea

When the daemon's lineage resolver resolves an entity against `GET /api/entities/{type}/{uuid}/root-idea` and receives a NON-NULL `rootIdeaUuid` together with a NULL or absent `directIdeaUuid`, it SHALL emit a `warn`-level log line that names the entity (`{type}:{uuid}`), states the consequence (the wake will anchor on the entity rather than the idea conversation, so its run will not surface a running indicator / Interrupt on the idea chat), and names the most likely cause (a Chorus server predating the `directIdeaUuid` field on the `/root-idea` endpoint). This warning is diagnostic ONLY: the resolver SHALL still return `{ rootIdeaUuid, directIdeaUuid }` exactly as resolved and SHALL NOT substitute the root idea for the missing direct idea (no client-side fallback). The normal outcome where the entity legitimately has NO idea ancestor (`rootIdeaUuid` is null) SHALL NOT emit this warning — it stays a non-alarming `info`.

#### Scenario: Non-null root with null direct idea warns

- **WHEN** the resolver receives `{ rootIdeaUuid: <non-null>, directIdeaUuid: null }` (or `directIdeaUuid` absent) for an idea-attributable entity
- **THEN** it MUST emit a `warn` naming the entity and mentioning `directIdeaUuid`
- **AND** it MUST still return the resolved `rootIdeaUuid` with `directIdeaUuid: null` — no fallback substitution

#### Scenario: No idea ancestor does not warn

- **WHEN** the resolver receives `{ rootIdeaUuid: null, directIdeaUuid: null }` (the entity has no idea lineage)
- **THEN** it MUST NOT emit the missing-direct-idea warning
- **AND** it MUST still emit its normal success `info` line

#### Scenario: Both ids present does not warn

- **WHEN** the resolver receives a non-null `rootIdeaUuid` and a non-null `directIdeaUuid`
- **THEN** it MUST NOT emit the missing-direct-idea warning
