## Context

The repository's Codex plugin predates the current `spawn_agent` schema. Its documentation uses `agent_type="default"` and `agent_type="worker"`, describes a fixed built-in-role set, and sometimes tells a worker to follow `$develop` without mounting that skill. The same stale contract is emitted by post-submit and session-start hooks. Codex subagent execution is separate from Chorus MCP state: Codex starts and manages threads, while Chorus owns task claims, status transitions, work reports, criteria evidence, and verification.

The change is Codex-specific. Other plugin ports intentionally use different orchestration APIs and are not part of this sweep.

## Goals / Non-Goals

**Goals:**

- Make every Codex worker and reviewer example directly representable by the current tool schema.
- Make workflow loading explicit through skill items.
- State one lifecycle contract consistently across the plugin.
- Prevent stale syntax from returning through an executable static test.
- Validate both source files and the packaged/installed form.

**Non-Goals:**

- Change Chorus MCP task or review semantics.
- Rewrite Claude Code, OpenClaw, Kiro, Pi, dsh, or standalone skill surfaces.
- Add automatic Codex lifecycle hooks that the host does not expose.
- Push, merge, or publish a release.

## Decisions

### Use `items` as the canonical skill-driven spawn form

Reviewer and worker examples use `spawn_agent({items:[...]})`. The first item mounts the exact skill path; the second is a text item containing the entity UUID, project UUID where relevant, review round/budget, and expected Chorus-side outcome. A self-contained operation may use `spawn_agent({message:"..."})`.

This is preferred over text that says “follow `$develop`” because child agents do not implicitly load a named skill, and over role selection because `agent_type` is not in the current schema.

### Fork parent context only when the assignment depends on it

Examples default to a fresh child context. They set `fork_context: true` only when the child needs material conversational state that cannot be captured cleanly in the mounted skill plus assignment text, such as an ongoing investigation whose prior evidence is too coupled to restate safely.

This is preferred over unconditional forking because routine reviewer and worker assignments already identify their Chorus entities and can fetch authoritative context through MCP; copying the full parent conversation adds noise and may expose unrelated state.

### Treat lifecycle operations as state-dependent

`wait_agent` is used only when the orchestrator's next action needs the result. `send_input` corrects or extends a live agent. `close_agent` releases a completed or abandoned thread as soon as no further interaction is needed. `resume_agent` is reserved for restoring a previously closed agent; it is not a substitute for sending input to an active one.

### Keep Codex and Chorus responsibilities explicit

Codex APIs own execution-thread orchestration. Chorus MCP calls remain the source of truth for claiming tasks, reporting work, submitting verification evidence, and recording reviewer verdicts. Examples include task/project UUIDs so both layers refer to the same work item.

### Enforce the contract with a focused shell test

Add a Bash-compatible static test under the Codex hook test area. It scans the whole `plugins/chorus` package for forbidden spawn syntax and stale role claims, then asserts representative reviewer, worker, lifecycle, and UUID-bearing instructions. The test accepts an optional plugin-root argument so the same checks can run against a temporary generated/installed copy.

This is preferred over a release-only `rg` command because it is repeatable in CI and validates positive requirements as well as forbidden strings.

### Preserve the current unpublished Codex package version

Keep the Codex manifest, every Codex skill frontmatter version, and the MCP helper's `clientInfo.version` at `0.17.0`. The requester explicitly kept this unpublished release line unchanged; other plugin packages are also unchanged because their orchestration contracts differ intentionally.

## Risks / Trade-offs

- [Tool schema evolves again] → Keep examples object-shaped and protect the currently supported contract with one localized test.
- [The static test flags prose discussing the old syntax] → Match executable/example patterns and explicitly stale role claims rather than every occurrence of the words `agent_type`.
- [A child lacks necessary conversational evidence] → Document the `fork_context: true` escape hatch and require an explicit dependency on parent conversational state.
- [Packaged output diverges from source] → Run the contract test against a temporary installed/cache-shaped plugin copy.
- [Lifecycle prose becomes duplicated] → Define a canonical lifecycle section and keep shorter call sites linked to the same four operation meanings.

## Migration Plan

1. Update source guidance and hook-generated messages.
2. Add and run the source contract test.
3. Confirm all Codex package version locations remain consistently at `0.17.0`.
4. create a temporary cache-shaped installed copy and run the same contract test against it.
5. Run existing Codex hook tests and OpenSpec validation.

Rollback is a source revert of this documentation/test/version-only change; no persistent data migration is involved.

## Open Questions

None.
