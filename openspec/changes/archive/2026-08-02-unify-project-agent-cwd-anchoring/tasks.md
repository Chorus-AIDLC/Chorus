## 1. Shared Resolution

- [x] 1.1 Implement the authoritative actor-bearing project-Agent cwd resolved-target service, including durable fixed-target AgentInstance identity and typed ready/offline/invalid states.
- [x] 1.2 Migrate wake preview, stage advance, and notification target resolution to the shared service while preserving hard-pin and active-session precedence.

## 2. Assignment And Entry Surfaces

- [x] 2.1 Integrate fixed cwd anchoring into Idea and Task assignment actions and suppress instance/cwd pickers in favor of a read-only anchor with a project-settings action.
- [x] 2.2 Reuse the fixed-anchor state in Start Development, Yolo, proposal actions, and all other cwd-confirming project entry points.

## 3. Verification

- [x] 3.1 Add unit and integration coverage for fixed/clear transitions, actor capture, immutable reuse across one operation, multiple Agent isolation, hard-pin offline/invalid behavior, root inheritance, and sticky resume/continuation.
- [x] 3.2 Add browser acceptance coverage proving that fixed targets never render cwd pickers and cleared targets restore existing selection behavior.
