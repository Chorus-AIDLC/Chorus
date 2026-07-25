# daemon-token-usage Specification (delta: Codex capture)

## ADDED Requirements

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
