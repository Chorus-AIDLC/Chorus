# Tasks — add-delete-document-ui

> Source of truth for execution lives in Chorus task drafts on the proposal. This file mirrors them for OpenSpec readers.

1. Add Server Action + Vitest unit tests
   - Implement `deleteDocumentAction` in `src/app/(dashboard)/projects/[uuid]/documents/actions.ts`.
   - Auth, permission, tenant scoping per design.md.
   - Cover all five scenarios from `specs/document-deletion-ui/spec.md` Requirement 3 with Vitest tests.

2. Build `DeleteDocumentButton` client component + i18n strings
   - New file `src/components/documents/delete-document-button.tsx` with AlertDialog, sonner toasts, router navigation.
   - Add 5 keys to `messages/en.json` and `messages/zh.json`.

3. Wire the button into the Document detail page action bar with permission gating
   - Update `src/app/(dashboard)/projects/[uuid]/documents/[documentUuid]/document-actions.tsx` to render `DeleteDocumentButton` only when the actor can write documents.
   - Manually verify the goldenpath in a browser via `pnpm dev`.
