## 1. Seed persistence and authenticated API
- [x] 1.1 Add avatarSeed migration/backfill and database defaults for all account creation flows; test persistence across login and old-client writes during rollout/rollback.
- [x] 1.2 Add self-only validated save endpoint and session/auth-me seed responses; test errors, authorization and origin checks.

## 2. Shared local avatar rendering
- [x] 2.1 Implement deterministic Personas rendering, bounded memoization, fallback and accessible shared component.
- [x] 2.2 Add render tests and third-party style notice without changing Agent behavior.

## 3. Identity propagation and full-site integration (depends on 1, 2)
- [x] 3.1 Extend authorized identity DTOs and batch resolution for all existing human-avatar surfaces.
- [x] 3.2 Integrate shared current-user saved state and replace existing human-avatar slots; record search classification.
- [x] 3.3 Test updated seed consistency, historical content, missing identities and unchanged access boundaries.

## 4. Settings preview editor (depends on 1, 2, 3)
- [x] 4.1 Add random preview, explicit save, cancel, pending/error states, Chinese/English text and visible attribution.
- [x] 4.2 Test no-write previews, exact saved seed, failure retry and immediate shared-state update.

## 5. Integration acceptance (depends on 3, 4)
- [x] 5.1 Verify migration and old-client creation behavior during rollout/rollback in isolated PostgreSQL/PGlite test environments and run targeted/broader checks.
- [x] 5.2 Perform browser acceptance for settings and sitewide identity surfaces, keyboard/themes/mobile, persistence and no remote requests.
- [x] 5.3 Complete coverage audit and record evidence, including Agent regression and license credit.

Chorus task drafts are authoritative for dependency and acceptance tracking. This checklist is a local execution aid and is not mirrored as a Document.
