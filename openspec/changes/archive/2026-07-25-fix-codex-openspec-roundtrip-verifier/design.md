# Technical Design: Codex OpenSpec Round-Trip Verifier

## Context

Codex's `chorus-mcp-call.sh` unwraps JSON-RPC and emits the text returned by a
Chorus tool. For `chorus_get_document`, that text is a JSON object whose
top-level `content` is the Document body. The archive instruction currently
leaves the second parsing step to the model. Recursive key discovery is unsafe
because the response can contain other `content` fields, while line-oriented
post-processing corrupts decoded multiline strings.

## Goals

- Provide one supported, target-field extraction path for Codex.
- Preserve exact content bytes, including the presence or absence of a final
  newline.
- Make mismatches diagnosable without logging document bodies.
- Keep mirror writes on `chorus-mcp-call.sh` plus `json_encode_file`.

## Non-Goals

- Changing Chorus backend newline behavior.
- Normalizing line endings or trailing newlines.
- Redesigning the MCP transport wrappers.
- Requiring Claude Code or Kiro to adopt a Codex-specific response contract.

## Design

### Helper Contract

A shell helper owned by the Codex plugin accepts:

1. a local file path; and
2. the complete stdout produced by
   `chorus-mcp-call.sh chorus_get_document ...`.

It parses stdout once as JSON and requires a top-level string `.content`.
Missing, null, non-string, malformed, or ambiguous responses fail closed.
It writes the decoded string to a temporary file so command substitution cannot
strip trailing newlines.

The helper compares files with a byte-preserving primitive such as `cmp`.
Success is silent. Failure emits local and remote byte counts and SHA-256
hashes, never either body, and returns non-zero so archive closeout halts.

### Response Boundaries

Transport-envelope extraction remains the wrapper's responsibility. Document
field extraction remains the verifier's responsibility. The verifier MUST NOT
use recursive descent (`..`), select the first discovered `content`, pipe
decoded content through `head`, or store decoded content in a shell variable.

### Skill Integration

The Codex OpenSpec-aware skill will include the concrete helper invocation in
section 3.9. The Codex post-verification reminder will direct agents to that
helper rather than restating an underspecified byte-equality goal.

### Portability Assessment

Claude Code and Kiro wrappers currently emit the same tool text after unwrapping
JSON-RPC, but their wrapper implementations and distribution layout differ.
Implementation will run the same fixture suite against each wrapper contract.
Equivalent helpers and instruction updates may be copied only when the tests
prove the same top-level Document JSON contract; otherwise the implementation
records the incompatibility without broadening the Codex fix.

## Testing

Shell tests use fixture responses and temporary files to prove:

- multiline content is not truncated;
- empty content round-trips;
- with-newline and without-newline bodies remain distinct;
- unrelated nested `content` fields are ignored;
- a one-byte difference fails;
- malformed or missing target fields fail closed; and
- mismatch output contains counts and hashes but not document bodies.

An integration-oriented test verifies the archive reminder names the supported
helper flow.

## Risks

- Shell command substitution silently removes final newlines.
  Mitigation: decode directly to a temporary file.
- Wrapper output contracts may drift.
  Mitigation: strict parsing, fixture tests, and a clear ownership boundary.
- Diagnostic output could disclose content.
  Mitigation: emit metadata only.
