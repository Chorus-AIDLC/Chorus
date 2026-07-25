# Fix Codex OpenSpec Round-Trip Verification

## Why

The OpenSpec archive closeout tells agents to verify mirrored Chorus Documents
for byte equality, but it does not define how to extract Document content from
the MCP wrapper response. A Codex agent used a recursive `content` search
followed by `head -1`, truncating multiline Markdown and halting a successful
archive as a false mismatch.

## What Changes

- Add a deterministic Codex helper that extracts the intended Document
  `content` field from the wrapper's actual response shape without recursive
  key search or line-based truncation.
- Compare local and remote bytes without newline normalization, and report only
  byte counts and SHA-256 hashes when they differ.
- Cover multiline Markdown, empty content, trailing-newline differences,
  unrelated `content` fields, malformed responses, and true byte drift.
- Replace the Codex OpenSpec skill and archive reminder's underspecified
  verification prose with the supported helper flow.
- Assess the helper contract against Claude Code and Kiro wrappers; copy the
  implementation only where response contracts are compatible.

## Capabilities

### New Capabilities

- `openspec-document-roundtrip-verification`: deterministic and diagnosable
  verification of local OpenSpec files against mirrored Chorus Documents.

## Impact

The primary implementation surface is the Codex plugin source, generated
OpenSpec-aware skill, archive reminder, and their shell tests. Claude Code and
Kiro templates may receive equivalent changes after compatibility is proven.
The existing wrapper-only mirror and `json_encode_file` requirements remain
unchanged.
