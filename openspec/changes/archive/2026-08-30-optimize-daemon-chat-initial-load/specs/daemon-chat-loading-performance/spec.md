## ADDED Requirements

### Requirement: Daemon chat startup SHALL coalesce overlapping session-list reads

Within one mounted Daemon Agent conversation surface, the client SHALL keep at most one
`GET /api/daemon-sessions` request in flight. Any mount, focus, or refresh trigger that
occurs while that request is pending MUST reuse the pending request rather than issuing
another network request. After the request settles, later background or explicit refreshes
MUST remain able to fetch fresh data.

#### Scenario: A seeded conversation focuses while the initial list request is pending

- **WHEN** the daemon chat mounts and starts its session-list request
- **AND** a seeded conversation focus requests a list refresh before the first request settles
- **THEN** exactly one session-list network request MUST be in flight
- **AND** both paths MUST observe the result of that request

#### Scenario: A later background refresh remains fresh

- **WHEN** the initial session-list request has settled
- **AND** the background refresh interval elapses
- **THEN** the client MUST issue a new session-list request

### Requirement: Transcript detail reads SHALL have a fixed candidate-turn bound

The daemon session detail service SHALL load only the newest bounded candidate-turn window
needed to construct the requested page and determine whether older entries exist. The
candidate-turn query MUST read no more than the normalized message page limit plus two turn
rows, independent of the conversation's total historical turn count. The returned message
page, synthetic prompt entries, placeholder turn bands, composite cursor, and `hasMore`
semantics MUST remain unchanged.

#### Scenario: The newest default page is read from a long conversation

- **WHEN** a conversation contains more historical turns than the default message page size
- **AND** its newest transcript page is requested without a cursor
- **THEN** the candidate-turn query MUST be bounded to the default page limit plus two
- **AND** the response MUST contain the same newest page and `hasMore` result as the existing contract

#### Scenario: A cursor points to a turn placeholder boundary

- **WHEN** an older-page request uses a cursor whose message sequence is zero
- **THEN** the service MUST still return up to the requested number of older entries
- **AND** the candidate-turn query MUST remain bounded to the normalized limit plus two

#### Scenario: A custom page limit is normalized

- **WHEN** a caller requests a custom transcript page limit
- **THEN** the service MUST apply the existing minimum and maximum normalization
- **AND** the candidate-turn query bound MUST be the normalized limit plus two

### Requirement: Seeded conversation entry SHALL become interactive measurably faster

The optimized Daemon Agent conversation surface SHALL reduce browser-observed time from the
seeded-conversation open action to the selected title and latest transcript being visible
with an enabled reply composer. Verification MUST use the same fixture containing at least
500 historical turns, the same browser and host, and five cold-open samples before and after
the change. The production-build post-change median MUST be at least 30% lower than the
baseline median. Development-server mode MUST NOT regress; it MUST additionally demonstrate
the one-request client waterfall and bounded candidate query because fixed development
compiler/middleware overhead is outside this change.

#### Scenario: Development-server timing comparison

- **WHEN** five baseline and five optimized cold opens are measured against the development server
- **THEN** the optimized median time to interactive MUST be lower than baseline
- **AND** a same-run control request MUST be recorded to distinguish fixed development-server overhead
- **AND** the raw samples and browser network waterfall MUST be recorded as task evidence

#### Scenario: Production-build timing comparison

- **WHEN** five baseline and five optimized cold opens are measured against a production build
- **THEN** the optimized median time to interactive MUST be at least 30% lower than baseline
- **AND** the raw samples and browser network waterfall MUST be recorded as task evidence
