# Tasks: fix-daemon-stale-pid-identity

> Chorus task drafts are the source of truth; this file is a local index.

- [ ] 1. Identity-verified liveness core in daemon-lifecycle.mjs (pidfile JSON + queryProcessIdentity + probe decision table + stopDaemon self-heal/message + startBackground identity capture) with unit tests
- [ ] 2. `stop --force` flag: client-args parsing + help text + daemon.mjs threading + dispatch tests + skill/README doc touchpoints
