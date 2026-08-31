## 1. MCP Assignment Target Resolution

- [x] 1.1 Resolve agent targets with the caller owner's project cwd preference and persist project-fixed instance/cwd provenance.
- [x] 1.2 Emit effective target metadata for new logical assignees, deduplicate same-agent wake activities, and update the tool description.

## 2. Regression Verification

- [x] 2.1 Add MCP handler unit tests proving a project-fixed target overrides a conflicting explicit instance, plus same-agent activity deduplication.
- [x] 2.2 Add integration coverage proving automatic first-assignment wake and same-agent re-pin wake suppression.
- [x] 2.3 Run focused assignment suites, type checking, and OpenSpec validation.
