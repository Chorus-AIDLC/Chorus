# Tasks

> Spec/docs-only correction; no runtime change. Mirrored into Chorus as one task.

- [ ] 1.1 Correct the four stale `pi` statements in the specs of record (`openspec/changes/fix-pi-wakeable-spec-drift/specs/{daemon-multi-agent,chorus-init}/spec.md`), keeping every scenario the modified requirements must retain.
- [ ] 1.2 `docs/DAEMON.md`: list the full accepted `agentType` set in the per-agent field table and make the intro line backend-neutral.
- [ ] 1.3 Verify with an exhaustive grep that no spec/doc still describes `pi` as non-wakeable/`offline`, then `openspec validate fix-pi-wakeable-spec-drift`, archive, and mirror the updated `daemon-multi-agent` spec back to its Chorus document.
