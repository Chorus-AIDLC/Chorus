## 1. Daemon discovery foundation

- [ ] 1.1 Add layered `browseRoots` resolution, install persistence, CLI help, startup diagnostics, and focused configuration tests.
- [ ] 1.2 Add safe one-level directory scanning with normalization, containment, symlink/hidden/access filtering, stable pagination, limits, typed errors, and cross-platform unit tests.
- [ ] 1.3 Extend daemon control and REST reporting with correlated list/validate requests and test offline, timeout, stale-target, and reconnect behavior.

## 2. Project cwd model and routing

- [ ] 2.1 Add Prisma models/migration and services/APIs for user × project × Agent cwd preferences and short-lived directory requests, including tenant/owner authorization and cleanup.
- [ ] 2.2 Add directed runtime-cwd dispatch, daemon runtime Waker contexts, `DaemonSession.runtimeCwd`, and immutable probe/spawn/resume/turn routing with concurrency tests.
- [ ] 2.3 Integrate sticky fixed-cwd resolution into assignment and stage-advance workflows while preserving existing behavior when no preference exists.

## 3. Product workflow and integration

- [ ] 3.1 Add the project-settings Agent working-directory UI with host-first remote browsing, explicit save/replace/clear, typed states, responsive behavior, and localization; when no fixed value exists, extend operation cwd pickers with a non-persisting "browse another directory" flow.
- [ ] 3.2 Add end-to-end integration coverage from browse-root configuration through discovery, fixed preference, directed wake, continued session, clear-to-temporary fallback, temporary unregistered-directory execution without persistence, offline/error states, and regression suites.
- [ ] 3.3 Update daemon and project configuration documentation and manually verify the project-settings workflow in desktop and mobile browsers.
