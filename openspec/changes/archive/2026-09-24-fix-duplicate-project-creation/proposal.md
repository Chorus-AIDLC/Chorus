## Why

Creating a project from a group header can issue duplicate POST requests and persist two independent projects. Component experiments on 96201800 confirmed repeated Enter during a pending request and repeated clicks during asynchronous cwd validation. A single click issued one POST in the experiment; the exact original production gesture is unknown.

## What Changes

- Guard the entire project creation attempt synchronously, before cwd validation, across click and Enter entry points.
- Show the existing creating state and prevent dismissal during an active attempt, including the success feedback interval, so closing/reopening cannot race an older attempt.
- Release the guard on validation/request failure and after a successful close; preserve retry drafts, IME handling, group association and subsequent creation.
- Add focused regression coverage and browser acceptance evidence.

## Capabilities

### New Capabilities
- `project-creation-submission`: One active project creation attempt per dialog, with recoverable errors and safe completion.

### Modified Capabilities
None.

## Impact

Primary component: `src/components/create-project-dialog.tsx`; regression tests under `src/components/__tests__/`. Existing project API and database schema remain compatible. This is client-side duplicate submission prevention, not server-wide idempotency or same-name uniqueness. Existing duplicate data will not be deleted. The project-group creation dialog is outside this scoped bug fix.
