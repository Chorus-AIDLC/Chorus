# openspec-document-roundtrip-verification Specification

## Purpose
TBD - created by archiving change fix-codex-openspec-roundtrip-verifier. Update Purpose after archive.
## Requirements
### Requirement: Targeted Document content extraction
The Codex OpenSpec archive workflow MUST extract the mirrored Document body from
the documented target field of the `chorus_get_document` tool result and MUST
NOT discover content through recursive key search or line-oriented selection.

#### Scenario: Multiline Document body
- **WHEN** the wrapper result contains a top-level `content` string with multiple lines
- **THEN** the verifier preserves every byte of the string for comparison

#### Scenario: Unrelated nested content field
- **WHEN** the result also contains another object's `content` field
- **THEN** the verifier compares only the Document's top-level `content`

#### Scenario: Invalid response shape
- **WHEN** the result is malformed or its top-level `content` is absent or not a string
- **THEN** verification fails closed without selecting a fallback field

### Requirement: Exact byte comparison
The verifier MUST compare local and remote content as exact bytes and MUST NOT
normalize line endings or trailing newlines.

#### Scenario: Equal multiline content
- **WHEN** local and remote content contain identical bytes
- **THEN** verification succeeds

#### Scenario: Single-byte drift
- **WHEN** local and remote content differ by one byte
- **THEN** verification fails and archive closeout halts

#### Scenario: Trailing newline drift
- **WHEN** one side has a trailing newline and the other does not
- **THEN** verification treats the values as different

#### Scenario: Empty content
- **WHEN** local and remote content are both empty
- **THEN** verification succeeds

### Requirement: Non-sensitive mismatch diagnostics
On mismatch, the verifier MUST report each side's byte count and SHA-256 hash
and MUST NOT print either complete content body.

#### Scenario: Mismatch report
- **WHEN** exact comparison fails
- **THEN** stderr identifies local and remote byte counts and hashes without reproducing the document text

### Requirement: Mirror-write constraints remain intact
The verification change MUST preserve the requirement that OpenSpec Document
mirror writes use `chorus-mcp-call.sh` with content produced by
`json_encode_file`.

#### Scenario: Archive mirror followed by verification
- **WHEN** an agent mirrors an archived cumulative spec and verifies it
- **THEN** the write uses the existing wrapper and encoder while the read uses the deterministic verifier

### Requirement: Host portability is evidence-based
Claude Code and Kiro variants MUST receive equivalent verifier behavior only
after their wrapper output contracts pass the shared response fixtures.

#### Scenario: Compatible host wrapper
- **WHEN** another host emits the same top-level Document JSON contract
- **THEN** the helper and instruction pattern may be copied with host-specific invocation changes

#### Scenario: Incompatible host wrapper
- **WHEN** another host emits a different response contract
- **THEN** the Codex fix remains valid and the incompatibility is documented rather than hidden by permissive parsing
