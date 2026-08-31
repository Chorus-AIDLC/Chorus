## 1. Initial-load request coalescing

- [x] 1.1 Coalesce concurrent daemon session-list reads within the mounted chat while preserving post-settlement refreshes.
- [x] 1.2 Add a frontend regression test proving the mount/focus race issues one list GET and later refreshes remain possible.

## 2. Bounded transcript detail read

- [x] 2.1 Bound candidate turn retrieval to the normalized transcript page limit plus two without changing stream folding or cursor semantics.
- [x] 2.2 Add service regression coverage for default, custom-limit, and zero-message-sequence cursor bounds.

## 3. Verification

- [x] 3.1 Run targeted frontend, route, and service tests plus type checking.
- [x] 3.2 Measure five cold seeded-conversation opens before and after the change in development-server and production-build modes using the same 500+ turn fixture; verify production improves by at least 30% and development does not regress, with a control request separating fixed dev-server overhead.
- [x] 3.3 Validate the OpenSpec change and record raw timing samples, browser waterfalls, request counts, and candidate-query bounds in the Chorus task report.
