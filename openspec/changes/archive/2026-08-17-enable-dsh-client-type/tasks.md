## 1. Register dsh Client Type

- [x] 1.1 Add `dsh` to the server daemon client-type allowlist and update the focused service assertion for the complete accepted set.
- [x] 1.2 Add `dsh` to CLI agent resolution, executable metadata, and client-type mapping with focused coverage for selection, membership, descriptor, and self-report behavior.
- [x] 1.3 Map `dsh` through the shared presence label hook and add `agentConnections.clientDsh` to English, Chinese, Japanese, and Korean messages.

## 2. Verify the Registration Contract

- [x] 2.1 Run the focused daemon-agent and daemon-connection service tests and confirm existing backend/default/unknown behavior remains intact.
- [x] 2.2 Run applicable lint or type checks for the touched service, hook, tests, and locale files, confirming no database migration was introduced.
