## 1. Unified Persistence

- [x] 1.1 Add a transactional Project update service that resolves cwd upserts, applies explicit clears, and updates metadata atomically.
- [x] 1.2 Extend the Project settings server action contract with Agent cwd mutations and structured Agent-scoped validation errors.

## 2. Project Form Experience

- [x] 2.1 Refactor shared Agent cwd settings into draft-only form behavior for both create and edit flows, including replacement and clear drafts.
- [x] 2.2 Submit cwd drafts from Project settings through Save Changes and render validation failures beside the affected Agent control.
- [x] 2.3 Remove independent cwd-save copy and update translations to describe directory selection.

## 3. Verification

- [x] 3.1 Add service tests for atomic update, unchanged preferences, explicit clears, and failed validation rollback.
- [x] 3.2 Add component/action tests for one-save behavior, draft preservation, and inline Agent cwd errors.
- [x] 3.3 Run focused tests, type checking, and OpenSpec validation.
