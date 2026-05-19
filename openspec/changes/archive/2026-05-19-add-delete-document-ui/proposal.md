## Why

The Chorus backend already supports document deletion: `DELETE /api/documents/[uuid]` (gated by `document:write`) and the `chorus_admin_delete_document` MCP tool (gated by `document:admin`) both work end-to-end and call `documentService.deleteDocument`. But the UI has no Delete affordance, so a user who created a stray or wrong-typed document has to drop into the API or the database to clean it up. This is the smallest gap that turns Documents from a one-way-ramp into a normal CRUD surface.

## What Changes

- Add a Delete button to the Document detail page action bar (next to Export and Back).
- Add a shadcn `AlertDialog` that asks for confirmation, mirroring the Idea delete pattern.
- Add a Server Action `deleteDocumentAction(documentUuid)` that runs the auth check, scopes by `companyUuid`, calls `documentService.deleteDocument`, then `revalidatePath` for the project's Documents list and returns `{ success, projectUuid }` so the client component owns the navigation back to the list.
- Show a toast on success (sonner) and a toast + inline error inside the dialog on failure.
- The button is shown to any authenticated dashboard user. Agents are out of scope here — they have `chorus_admin_delete_document` (MCP) for the same operation, and the Server Action only runs in the dashboard auth context.
- Add `documents.deleteDocument`, `documents.deleteDocumentDescription`, `documents.deleteSuccess`, `documents.deleteFailed`, `documents.deleteFailedNotFound` to `messages/en.json` and `messages/zh.json`.
- Cover the new Server Action with Vitest unit tests (success / not-found / wrong company / missing permission).

Non-goals: grid-card inline delete (follow-up if requested), service-layer event emission, undo/restore.

## Capabilities

### New Capabilities

- `document-deletion-ui`: client-facing affordance + Server Action wiring that lets a permitted actor delete a Document from the project's Documents detail page, including confirmation, success/error feedback, navigation, and i18n contract.

### Modified Capabilities

(none — this is a UI surface that wraps existing service-layer behavior; no backend Requirement changes.)

## Impact

- **New file**: `src/components/documents/delete-document-button.tsx` (client component: button + AlertDialog + action call + toast).
- **Updated file**: `src/app/(dashboard)/projects/[uuid]/documents/[documentUuid]/document-actions.tsx` — render the new button when `canWriteDocument` is true.
- **Updated file**: `src/app/(dashboard)/projects/[uuid]/documents/actions.ts` — add `deleteDocumentAction`.
- **Updated files**: `messages/en.json`, `messages/zh.json` — new keys under `documents.*`.
- **New file**: `src/app/(dashboard)/projects/[uuid]/documents/__tests__/actions.test.ts` (or extend existing test file if present) — cover the four scenarios.
- **Backend**: no change — we reuse `documentService.deleteDocument` and the existing `getAuthContext` permission helper.
- **Risks**: cascade behavior is whatever Prisma already configured; we do not change schema. The button must be hidden, not just disabled, when the actor lacks permission, so display is consistent with the rest of the app.
