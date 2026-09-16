## 1. Agent Daemon transcript metadata

- [x] 1.1 Update `TranscriptView` so active conversations omit the lifecycle badge, ended conversations retain their badge, and expanded connection details omit only the relative process-start field.
- [x] 1.2 Add focused component tests covering active and ended headers plus retained connection identity, uptime, host, and the absence of the “Started” row.
- [x] 1.3 Update the matching Agent Daemon chat screen in `docs/design.pen` through Pencil and visually verify that it reflects the simplified status metadata in both the header and connection disclosure.
- [x] 1.4 Run the focused agent-presence tests, lint the touched source/test files, the Impeccable detector, and OpenSpec validation.
