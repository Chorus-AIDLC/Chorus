## 1. dsh Chorus MCP Installer

- [x] 1.1 Implement `public/install-dsh.sh` with Bash 3.2-compatible input validation, protected and idempotent `$DSH_HOME/.env` updates, marker-bounded home patch installation, dsh CLI/config validation, and secret-safe output.
- [x] 1.2 Add isolated installer tests covering first install, preserved user content, rerun and credential rotation, malformed markers, missing prerequisites, file modes, secret non-disclosure, and Bash 3.2 syntax.
- [x] 1.3 Add a real-dsh Streamable HTTP MCP smoke fixture that verifies the installed headless composition exposes and calls a `mcp__chorus__*` tool, and that an unreachable endpoint emits a clear `mcp-client(chorus)` failure/retry diagnostic without fatal startup, then run the focused installer and smoke suites.
