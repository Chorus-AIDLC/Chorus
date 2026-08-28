## ADDED Requirements

### Requirement: Nested container status SHALL aggregate from leaves to roots

For a project lineage forest, the system SHALL derive every container Idea's status from the final derived statuses of its direct children, including child Ideas that are themselves containers. Aggregation SHALL proceed logically from leaves toward roots at arbitrary nesting depth. Each container's `childProgress` MUST continue to count only its direct children, and project-wide aggregation MUST use the existing batched data without introducing per-Idea database queries. Missing-parent edges and accidental cycles MUST terminate safely without an infinite loop. Every member of a cyclic component MUST use its own proposal/task-derived base status as a uniform component-level fallback, and results MUST be independent of database result order.

#### Scenario: Completed nested container completes its parent

- **WHEN** a parent container has one direct child container whose leaf Ideas are all `done`
- **THEN** the child container and parent container both have derived status `done`
- **AND** the parent container reports direct-child progress `1/1`

#### Scenario: Partial completion propagates through every level

- **WHEN** at least one leaf under a nested child container is not `done`
- **THEN** the child container and each affected ancestor container remain non-done according to the existing rollup rules

#### Scenario: Deep nesting is order independent

- **WHEN** containers are nested across multiple levels and returned in any database result order
- **THEN** each container is aggregated from its direct children's final derived statuses

#### Scenario: Malformed lineage terminates safely

- **WHEN** project data contains a missing-parent edge or an accidental lineage cycle
- **THEN** derived-status aggregation completes without unbounded recursion or repeated database queries
- **AND** every member of the cyclic component retains its own base status

#### Scenario: Cyclic fallback is input-order independent

- **WHEN** the same cyclic lineage and its non-cycle ancestors are returned in different database orders
- **THEN** every Idea receives the same derived status and child progress in every ordering

#### Scenario: Tracker and detail surfaces agree

- **WHEN** the tracker and Idea detail APIs read the same nested container data
- **THEN** they expose consistent final derived status and direct-child progress for the container
