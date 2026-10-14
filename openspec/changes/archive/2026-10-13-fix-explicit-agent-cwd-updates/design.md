## Context

Work starts at PR #615 head c7308a5606160baa23777002280cb0aef1563309 in isolated worktree /tmp/chorus-pr615, leaving the primary workspace's unrelated OpenSpec changes untouched. The human selected updating the existing PR with develop as its base, and including flat-config migration. YOLO authorizes automatic proposal/task verification, not merging or unapproved publishing.

## Decisions

1. Extend resolveInstallCwds to return { cwds, source }, where source is flag, interactive, existing, or default. Keep current normalization, ordering, persistence injection, and new-agent defaults unchanged. Other callers can ignore the additive source field.
2. In seedCredentials, track an explicit cwd request from source flag/interactive. Missing/unknown source is non-explicit. In the duplicate path, pass cwds only for an explicit, nonempty resolved set; otherwise omit it entirely. Continue gating daemonWake with daemonWakeRequested independently. No explicit fields means SKIPPED and no settings writer call.
3. Extend updateAgentSettings to handle a matching legacy flat identity when no agents[] array is present. Reuse appendAgentConfig's existing normalization conventions. Migrate only when at least one allowed explicit setting is supplied; preserve connection identity, agent backend, existing cwd/wake settings unless requested, unknown fields, and global settings. Remove only obsolete flat identity/backend keys consistent with existing normalization. Return absent without writes for a nonmatching key. appendAgentConfig remains append-only.
4. Restrict settings merges to the existing allowlist daemonWake/cwds. Preserve unrelated agent fields and sibling agents. No cleanup of malformed array entries or index reporting is included.

## Tests and Safety

- Assert resolver provenance for flag, interactive, existing, non-TTY default, and --yes default paths.
- Drive seedCredentials with the real resolver, real config update/append functions against temp daemon files; simulate a different process cwd through resolver injection. Cover default and inherited cwds preserving existing directories, explicit flags and interactive updates, explicit wake without cwd reset, and no-flags modern/flat reruns.
- Cover explicit flat migration for wake and cwd, unrelated settings preservation, unknown keys, identity/backend retention, absent identity, and no-settings no-write behavior.
- Stub every external credential sink, including writeClaudeSettings, writeCodexEnv, writeHermesEnv, writePiMcp, writeDshEnv and writeLogin. Run tests with temporary HOME/XDG_CONFIG_HOME/CODEX_HOME/HERMES_HOME/PI_CODING_AGENT_DIR as a defense in depth. Never execute real agents-add against the user's profile.
- Run targeted Vitest CLI suites first, then the full CLI suite with the same isolation. Review aggregate changes independently before reporting completion.

## Delivery and Rollback

The implementation and validated OpenSpec artifacts remain local until publishing approval. Planned destination is the author's existing branch and PR #615 targeting develop; never force-push or merge automatically. Recheck the live head/base before any approved publish. No plugin-port assets are modified, so no plugin version bump is required. Rollback is removal/revert of the focused fix; legacy normalization uses the established config shape.
