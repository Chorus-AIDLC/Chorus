# daemon-token-usage Specification

## Purpose
TBD - created by archiving change add-claude-code-token-usage. Update Purpose after archive.
## Requirements
### Requirement: A normalized TokenUsage contract SHALL be the single shape carried end-to-end

The system SHALL define ONE normalized token-usage shape `TokenUsage = { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, model, source }` that is carried unchanged from daemon capture through the wire, persistence, and read projection. Every token field and `model` SHALL be nullable so a backend that cannot report a field leaves it `null`; `source` SHALL always be present to identify the producing backend. The contract SHALL NOT include a cost/USD field in this change. This shape SHALL be the reuse target for later agent-backend integrations, which fill only the fields they can obtain.

#### Scenario: Claude Code populates the full token shape

- **WHEN** the daemon captures usage for a completed Claude Code turn
- **THEN** the emitted `TokenUsage` MUST set `inputTokens`, `outputTokens`, `cacheCreationTokens`, and `cacheReadTokens` from the turn's `result` usage token counts
- **AND** `model` MUST be sourced from the envelope/message-level model field (NOT from the `usage` object, which carries no model key)
- **AND** `source` MUST be set to the Claude Code backend identifier
- **AND** no cost/USD field MUST be present on the shape

#### Scenario: Missing fields are null, not zero or absent

- **WHEN** a backend reports usage without a particular field (e.g. no cache-write)
- **THEN** that field MUST be `null` in the `TokenUsage` shape
- **AND** `source` MUST still be set

### Requirement: The daemon SHALL capture per-turn usage from the Claude Code result envelope and never from the on-disk transcript

The daemon SHALL extract per-turn token usage from the Claude Code headless stream's `type:"result"` envelope, which carries the authoritative cumulative usage for the whole turn. The daemon SHALL NOT sum per-message `assistant.message.usage` frames to compute the turn total, and SHALL NOT read usage from the on-disk session transcript JSONL (whose `output_tokens` is a known upstream placeholder). A stream that yields no parseable `result` usage SHALL produce a `null`/absent usage for that turn without failing the turn.

#### Scenario: Result envelope is the source of the persisted total

- **WHEN** a Claude Code turn's stream contains both per-message usage frames and a final `result` envelope with usage
- **THEN** the captured per-turn usage MUST equal the `result` envelope's usage
- **AND** the per-message usage frames MUST NOT be accumulated into the turn total

#### Scenario: A turn with no result usage reports nothing rather than failing

- **WHEN** a turn's stream has no parseable `result` usage frame
- **THEN** the turn MUST still advance to its terminal status normally
- **AND** the turn's usage MUST be absent/null (no fabricated zeros)

### Requirement: Per-turn usage SHALL ride the terminal turn-advance report and the OpenClaw wire twin SHALL stay in lock-step

The daemon SHALL carry the captured `TokenUsage` on the existing `turn-advance` report at the turn's terminal (`→ ended`) edge, as an optional nested `usage` object — the same delivery point as the transcript-relay-error annotation. Usage SHALL NOT be sent on a `→ running` advance. The `/api/daemon/turn-advance` request body SHALL accept the optional `usage` object and the server SHALL act on it only for a terminal edge. The shared daemon REST client and its OpenClaw TypeScript twin SHALL both expose the optional `usage` parameter with a byte-identical body shape, so the wire contract does not drift between hosts.

#### Scenario: Usage is sent only on the terminal edge

- **WHEN** the daemon advances a turn to `running`
- **THEN** the request body MUST NOT include a `usage` object
- **WHEN** the daemon advances the same turn to `ended` with captured usage
- **THEN** the request body MUST include the `usage` object

#### Scenario: An advance without usage still succeeds

- **WHEN** a `turn-advance` request omits the `usage` object entirely
- **THEN** the turn MUST advance exactly as before this change
- **AND** the turn's persisted usage MUST remain null

#### Scenario: Both REST clients carry the same usage body shape

- **WHEN** the shared CLI daemon REST client and the OpenClaw twin each build a terminal `turn-advance` body with usage
- **THEN** both MUST place the usage under the same `usage` key with the same field names

### Requirement: Per-turn usage SHALL be persisted as one JSON column and rolled up on the session, additively and without backfill

The system SHALL persist per-turn usage as a SINGLE nullable JSON column on `DaemonSessionTurn` holding the whole normalized `TokenUsage` object — NOT a separate scalar column per token count. The system SHALL maintain a per-session running rollup on `DaemonSession` (total input and total output tokens) as scalar integer columns defaulting to 0, so the rollup can be maintained with an atomic increment. The usage column and the rollup SHALL be written only on a terminal edge, in the same write path as the turn status transition so the turn write and the rollup increment cannot tear. The migration SHALL be additive DDL only — no existing turn's usage SHALL be backfilled, and pre-change turns SHALL read as null usage with a zero session rollup.

#### Scenario: Terminal advance writes the usage JSON and increments the session rollup

- **WHEN** a turn advances to `ended` carrying usage with input and output token counts
- **THEN** the turn row MUST store the whole usage object in its single JSON usage column
- **AND** the session's total input/output rollup MUST increase by that turn's input/output tokens
- **AND** the turn usage write and the rollup increment MUST be applied atomically

#### Scenario: Running advance does not write usage

- **WHEN** a turn advances to `running`
- **THEN** no usage MUST be written on the turn
- **AND** the session rollup MUST be unchanged

#### Scenario: Pre-change turns and sessions read as empty usage

- **WHEN** a turn that completed before this change is read
- **THEN** its usage JSON column MUST be null
- **AND** a session with no reporting turns MUST read a zero input/output rollup

### Requirement: Per-turn usage SHALL be projected on the read views and pushed live over the existing SSE channel

The read projections SHALL expose the persisted usage as a single `usage` object on `TurnView` / `TurnWithMessagesView` and the scalar rollup on `SessionView`. The projection SHALL be defensive: a stored blob that does not conform to the `TokenUsage` shape SHALL map to a null usage rather than throwing. The terminal `turn_status_changed` `TranscriptEvent` published on the existing `transcript:{sessionUuid}` channel SHALL carry the turn's usage object, so a live viewer patches the affected turn's usage without a follow-up read. No new SSE channel or trigger SHALL be introduced.

#### Scenario: A viewer sees usage appear live when a turn ends

- **GIVEN** a client subscribed to a conversation's transcript channel
- **WHEN** a turn advances to `ended` with usage
- **THEN** the `turn_status_changed` event's turn MUST carry the usage object
- **AND** the client MUST be able to render the turn's usage without an additional fetch

#### Scenario: Session view exposes the rollup

- **WHEN** a session with reporting turns is read
- **THEN** its view MUST expose the total input and total output token rollup

### Requirement: The UI SHALL show a compact per-turn badge with a breakdown tooltip and omit the badge when a turn has no usage

The conversation UI SHALL render, beside each turn's status badge, a compact usage badge whose visible value is the humanized sum of input and output tokens, with a tooltip disclosing the full breakdown (input, output, cache-read, cache-write, model) omitting any null field. A turn with no usage data (pre-change, silent, or unsupported) SHALL render NO usage badge at all — no number, no "not reported" text, no placeholder. The badge and tooltip SHALL be internationalized across all four locales and SHALL render correctly in both light and dark themes.

#### Scenario: A reporting turn shows the compact badge and full tooltip

- **GIVEN** a turn with input, output, and cache token usage
- **WHEN** the turn is rendered
- **THEN** the badge MUST show the humanized input+output total
- **AND** hovering/tapping the badge MUST reveal input, output, cache-read, cache-write, and model

#### Scenario: A no-usage turn shows no badge

- **WHEN** a turn with null usage is rendered
- **THEN** no usage badge MUST be shown for that turn

### Requirement: The conversation header SHALL show a running input+output total and a conditional cache line

The conversation view header SHALL show a running total across the conversation equal to the sum of input and output tokens over turns that reported usage, sourced from the session rollup. Cache tokens SHALL NOT be included in that headline total. A secondary cache line (cache-read and cache-write totals) SHALL be shown only when at least one loaded turn has cache data, and SHALL be visually de-emphasized relative to the headline. The header total and cache line SHALL be internationalized across all four locales and correct in both light and dark themes.

#### Scenario: Headline totals input and output only

- **GIVEN** a conversation whose reporting turns have large cache-read counts
- **WHEN** the header total is rendered
- **THEN** the headline number MUST equal the sum of input and output tokens only
- **AND** cache-read MUST NOT be added into the headline number

#### Scenario: Cache line appears only when cache data exists

- **WHEN** no loaded turn has cache usage
- **THEN** the header MUST NOT show a cache line
- **WHEN** at least one loaded turn has cache usage
- **THEN** the header MUST show a de-emphasized cache-read/cache-write line

### Requirement: The daemon SHALL capture per-turn usage from the Codex `turn.completed` stream event and normalize it to the shared TokenUsage contract

The daemon SHALL extract per-turn token usage from the Codex `codex exec --json` stream's `turn.completed` event, whose `usage` object carries the authoritative per-turn counts. It SHALL normalize that usage into the same `TokenUsage` shape used by every backend, with `source` set to the Codex backend identifier (`"codex"`, matching the daemon's Codex client type). The capture SHALL be discriminated from the Claude Code capture purely by the stream event's top-level type (`turn.completed` vs `result`), requiring no backend flag on the capture path, and SHALL NOT alter the Claude Code capture. A stream that yields no parseable `turn.completed` usage SHALL produce a null/absent usage for that turn without failing the turn. This SHALL be the only production change; the TokenUsage contract, the `turn-advance` wire object, the persistence, the SSE projection, and the UI SHALL be reused unchanged.

#### Scenario: A completed Codex turn populates the shared shape

- **WHEN** the daemon captures usage for a completed Codex turn from its `turn.completed` event
- **THEN** the emitted `TokenUsage` MUST set `inputTokens` from `input_tokens`
- **AND** `cacheReadTokens` from `cached_input_tokens`
- **AND** `cacheCreationTokens` from `cache_write_input_tokens`
- **AND** `source` MUST be the Codex backend identifier
- **AND** `model` MUST be null because the Codex stream carries no model id on any event

#### Scenario: Output tokens are taken from output_tokens alone (reasoning is already inside it)

- **WHEN** a Codex `turn.completed` usage reports `output_tokens` alongside a `reasoning_output_tokens`
- **THEN** the emitted `outputTokens` MUST equal `output_tokens` alone
- **AND** `reasoning_output_tokens` MUST NOT be added to it, because it is a subdivision already counted inside `output_tokens` (adding it would double-count)
- **AND** a turn reporting no `output_tokens` MUST emit a null `outputTokens` rather than zero

#### Scenario: A missing or older-CLI field is null, never a fabricated count

- **WHEN** a Codex `turn.completed` usage omits `cache_write_input_tokens` (an older codex-cli), or reports a non-numeric/negative value for any field
- **THEN** that field MUST be null in the emitted `TokenUsage`
- **AND** the other reported fields MUST still populate
- **AND** the extractor MUST NOT throw

#### Scenario: The Codex capture leaves the Claude Code and transcript paths untouched

- **WHEN** the daemon processes a Claude Code `type:"result"` frame, a Codex `item.completed` (agent_message) frame, or any non-`turn.completed` frame
- **THEN** the Codex usage extractor MUST return null for it
- **AND** the Claude Code usage capture and the transcript-text extraction MUST behave exactly as before this change

#### Scenario: Codex usage rides the existing terminal turn-advance and pipeline

- **WHEN** a Codex turn completes with a captured usage and the daemon advances the turn to its terminal status
- **THEN** the usage MUST ride the existing `turn-advance` terminal edge as the same nested `usage` object used by Claude Code
- **AND** it MUST be persisted, projected on the read views, and pushed over the existing SSE channel with no new wire field, schema column, endpoint, or SSE channel

