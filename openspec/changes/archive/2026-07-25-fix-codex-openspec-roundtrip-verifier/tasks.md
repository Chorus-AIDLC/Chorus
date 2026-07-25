## 1. Codex-first implementation

- [ ] 1.1 Add a strict Codex Document-content extraction and exact-byte comparison helper.
- [ ] 1.2 Add regression fixtures for multiline, empty, newline drift, decoy fields, malformed responses, and one-byte drift.
- [ ] 1.3 Update the Codex OpenSpec-aware skill and archive reminder to use the helper and metadata-only mismatch diagnostics.
- [ ] 1.4 Run the helper and plugin test suites, including an archive closeout regression.

## 2. Portability assessment

- [ ] 2.1 Run the shared response fixtures against Claude Code and Kiro wrapper contracts.
- [ ] 2.2 Copy the helper and instruction pattern to compatible plugins, or document concrete contract differences that prevent copying.
