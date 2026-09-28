## MODIFIED Requirements

### Requirement: The daemon SHALL capture per-turn usage from the Codex `turn.completed` stream event and normalize it to the shared TokenUsage contract

The daemon SHALL adapt App Server thread/tokenUsage/updated cumulative totals into one internal turn.completed usage envelope for the active turn, subtracting a trustworthy same-thread pre-turn or persisted baseline before existing exclusive-input/cache normalization. It SHALL NOT sum snapshots, count reasoning output twice, or treat the latest individual model-request usage as the whole turn. On resumed history without a baseline it SHALL seed the baseline and omit that turn's usage. Regressing/invalid counters SHALL omit affected usage and re-seed instead of counting historical totals. A fresh replacement thread SHALL use a fresh baseline. Missing fields SHALL remain null, source SHALL remain codex, and existing model-null behavior SHALL remain. Capture, wire, persistence, SSE and UI contracts SHALL remain unchanged, and no usage-bearing event SHALL be delivered more than once per turn. Valid observed terminal totals SHALL be persisted on failure/interruption as well as success so later turns do not re-count them.


#### Scenario: A completed Codex turn populates the shared shape

- **WHEN** the daemon captures usage for a completed Codex turn from its `turn.completed` event
- **THEN** the emitted `TokenUsage` MUST set `inputTokens` from `input_tokens`
- **AND** `cacheReadTokens` from `cached_input_tokens`
- **AND** `cacheCreationTokens` from `cache_write_input_tokens`
- **AND** `source` MUST be the Codex backend identifier
- **AND** `model` MUST be null to preserve the existing reporting contract in this migration

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

#### Scenario: Repeated cumulative snapshots are counted once
- **WHEN** a resumed turn receives cumulative snapshots 110, 120 and duplicate 120 against baseline 100
- **THEN** the pre-normalization delta MUST be 20, never 250 or 350, and the final normalized usage MUST be delivered once

#### Scenario: Legacy thread lacks baseline
- **WHEN** a resumed exec-era thread has no trustworthy pre-turn total
- **THEN** the adapter MUST persist the observed total for the next wake and omit this turn's usage

#### Scenario: Interrupted totals seed future resumes
- **WHEN** a turn is interrupted after valid cumulative usage was observed
- **THEN** that thread's stored baseline MUST advance to the observed total and subsequent resume MUST NOT count those tokens again

#### Scenario: Changed thread or regressing totals
- **WHEN** fallback establishes a new thread or cumulative totals regress
- **THEN** the adapter MUST avoid subtracting an unrelated baseline; fresh-thread counts use zero while uncertain regressed counts are omitted and re-seeded
