## 1. Cordis Lifecycle Runtime

- [x] 1.1 Create `packages/chorus-dsh` with build configuration and a self-contained ESM artifact exporting `name`, `inject`, `Config`, and `apply`.
- [x] 1.2 Implement daemon-origin suppression and the validated configuration contract (`daemonOriginEnv`, `checkinTimeoutMs`, `maxPendingActions`), per-agent check-in state, the bounded first-step gate, Chorus-tool normalization and observation, deduplicated workflow actions, turn-stopping steering, and effect-owned cleanup.
- [x] 1.3 Add focused package tests for interactive and daemon modes, configuration defaults/ranges, check-in success/timeout/failure, success-only lifecycle observation, reviewer coverage, action bounds and deduplication, one-message steering, and disposal quiescence against dsh tag `dsh-v0.1.0-rc.7` / commit `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`.

## 2. Installer Integration And Verification

- [x] 2.1 Extend `public/install-dsh.sh` to install and roll back the built plugin artifact and add exactly one lifecycle row to its managed home patch.
- [x] 2.2 Extend isolated installer tests for first install, rerun, replacement, malformed state, permissions, composition failure rollback, and preservation of unrelated files.
- [x] 2.3 Add and run a real dsh smoke test pinned to deepseek-harness tag `dsh-v0.1.0-rc.7` / commit `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`; validate effective composition, interactive event behavior, and complete daemon suppression alongside the existing MCP client.
