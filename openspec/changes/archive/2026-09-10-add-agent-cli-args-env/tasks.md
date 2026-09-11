## 1. Shared configuration and launch integration

- [x] 1.1 Implement per-agent args/env validation, protected controls, immutable env overlay and recognizable explicit-option precedence.
- [x] 1.2 Thread fields through config/credentials selection, flat and multi-agent daemon/runtime construction, all backend spawners and foreground launch.
- [x] 1.3 Add schema, safety, isolation, precedence, platform and actual-spawn regression tests covering fresh/resumed paths.
- [x] 1.4 Document configuration examples, supported override registry, protected controls, legacy flat boundary and restart semantics; run CLI regression suite.

## 2. Independent review fixes and gates

- [x] 2.1 Fix option-arity boundaries and reverify configured positional rejection and explicit option-looking values.
- [x] 2.2 Preserve args/env in atomic flat-profile migration, implement foreground subcommand scope, correct retained-argument Windows checks, and validate flat configuration before preflight.
- [x] 2.3 Independently verify all three Chorus tasks; final aggregate code review PASS (round 2).
- [x] 2.4 Obtain Claude/Codex independent reviews, cross-discuss findings and confirm consensus fixes (Claude PASS WITH NOTES; Codex PASS).

Chorus tasks: 68564638-490a-4e02-879f-0598aae685db, f57b20fa-4aef-421b-954a-ffa4bdcef8a3, ddbde25e-7fc6-4d4b-8601-94edf6987565 — all done.

Post-verification delivery: archive this change and mirror the cumulative spec, then open a PR targeting develop without merging. These delivery operations occur after the implementation checklist is complete; their results are recorded in the Chorus completion report.
