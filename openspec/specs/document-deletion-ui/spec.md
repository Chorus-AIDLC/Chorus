# document-deletion-ui Specification

## Purpose
TBD - created by archiving change add-delete-document-ui. Update Purpose after archive.
## Requirements
### Requirement: The Document detail page SHALL render a Delete button to authenticated dashboard users

The project Documents detail page MUST render a destructive-styled Delete button in the same action bar as Export and Back, visible to any authenticated human user who can reach the page (auth type `user` or `super_admin`). Agents are out of scope for this UI affordance — they have a dedicated `chorus_admin_delete_document` MCP tool. The Server Action behind this button is reachable only via dashboard auth.

#### Scenario: Human user opens a document detail page

- **WHEN** a human user (auth type `user` or `super_admin`) navigates to `/projects/<projectUuid>/documents/<documentUuid>`
- **THEN** the rendered HTML MUST include a Delete button with `variant="destructive"` and a trash icon
- **AND** the button label MUST be the `common.delete` i18n string for the active locale

### Requirement: Clicking Delete SHALL open a confirmation dialog before any deletion happens

A click on the Delete button MUST open a shadcn `AlertDialog` and MUST NOT trigger the Server Action by itself. Deletion only happens after the user clicks the destructive confirm button inside the dialog.

#### Scenario: User clicks Delete then Cancel

- **GIVEN** the user is on a document detail page with the dialog closed
- **WHEN** the user clicks the Delete button
- **THEN** an AlertDialog MUST appear with title "Delete Document", a description containing the document's title, a Cancel button, and a destructive Delete button
- **WHEN** the user clicks Cancel
- **THEN** the dialog MUST close
- **AND** no Server Action call SHALL be made
- **AND** the user MUST remain on the document detail page

#### Scenario: User confirms the deletion

- **GIVEN** the AlertDialog is open
- **WHEN** the user clicks the destructive Delete button inside the dialog
- **THEN** the destructive button MUST show a loading spinner
- **AND** the Server Action `deleteDocumentAction(documentUuid)` MUST be invoked exactly once

### Requirement: The Server Action SHALL enforce auth and tenant scoping before deleting

A new Server Action `deleteDocumentAction(documentUuid)` MUST resolve the dashboard auth context (human user or super-admin only — agents use the MCP path), ensure the target document's `companyUuid` matches the actor's company, and only then invoke `documentService.deleteDocument`. On success it MUST `revalidatePath` for the project's Documents list and return `{ success: true, projectUuid }`. On failure it MUST return `{ success: false, error }` with one of the contract-specified error codes (`unauthorized`, `not_found`, `forbidden`, or a pass-through generic error).

#### Scenario: No authenticated actor

- **GIVEN** the request has no valid auth context (no session cookie, no API key, no super-admin session)
- **WHEN** `deleteDocumentAction("<documentUuid>")` is called
- **THEN** `documentService.deleteDocument` MUST NOT be called
- **AND** the action MUST return `{ success: false, error: "unauthorized" }`

#### Scenario: Successful deletion by a human user

- **GIVEN** an authenticated human user whose `companyUuid` matches the target document's `companyUuid`
- **WHEN** `deleteDocumentAction("<documentUuid>")` is called
- **THEN** `documentService.deleteDocument("<documentUuid>")` MUST be called exactly once
- **AND** `revalidatePath("/projects/<projectUuid>/documents")` MUST be called
- **AND** the action MUST return `{ success: true, projectUuid: "<projectUuid>" }`

#### Scenario: Document not found

- **GIVEN** a `documentUuid` that does not exist
- **WHEN** `deleteDocumentAction("<documentUuid>")` is called
- **THEN** `documentService.deleteDocument` MUST NOT be called
- **AND** the action MUST return `{ success: false, error: "not_found" }`

#### Scenario: Cross-tenant attempt

- **GIVEN** an authenticated actor in `companyUuid` A
- **AND** a document in `companyUuid` B
- **WHEN** `deleteDocumentAction("<documentUuid>")` is called
- **THEN** `documentService.deleteDocument` MUST NOT be called
- **AND** the action MUST return `{ success: false, error: "forbidden" }`
- **AND** the action MUST NOT distinguish "wrong company" from "document not found" beyond the `forbidden` vs `not_found` codes already specified (no UUID enumeration leakage at the API surface)

### Requirement: The UI SHALL surface success and failure feedback and navigate appropriately

After the Server Action returns, the client component MUST give explicit feedback and navigate.

#### Scenario: Successful deletion

- **GIVEN** the Server Action returns `{ success: true, projectUuid }`
- **THEN** a sonner toast with the `documents.deleteSuccess` string MUST appear
- **AND** the dialog MUST close
- **AND** the router MUST `replace` the current URL with `/projects/<projectUuid>/documents`
- **AND** `router.refresh()` MUST be called so the server-rendered list reflects the deletion

#### Scenario: Server Action returns `not_found`

- **WHEN** the Server Action returns `{ success: false, error: "not_found" }`
- **THEN** a sonner error toast with `documents.deleteFailedNotFound` MUST appear
- **AND** the same string MUST appear inline inside the dialog
- **AND** the dialog MUST remain open
- **AND** the destructive Delete button MUST return to its idle (non-spinner) state

#### Scenario: Server Action returns any other failure

- **WHEN** the Server Action returns `{ success: false, error: "<anything other than 'not_found'>" }`
- **THEN** a sonner error toast with `documents.deleteFailed` MUST appear
- **AND** the same string MUST appear inline inside the dialog
- **AND** the dialog MUST remain open

### Requirement: All user-facing strings introduced by this change SHALL be available in both English and Chinese locales

The following keys MUST exist in both `messages/en.json` and `messages/zh.json` under the `documents` namespace, and the dialog MUST render them via `useTranslations("documents")` rather than hardcoding any string.

#### Scenario: i18n key coverage

- **WHEN** a reviewer greps `messages/en.json` and `messages/zh.json` for `deleteDocument`, `deleteDocumentDescription`, `deleteSuccess`, `deleteFailed`, `deleteFailedNotFound`
- **THEN** each key MUST be present in BOTH locale files
- **AND** the value in each file MUST be a non-empty string
- **AND** none of these strings MAY appear hardcoded inside any `.tsx` file under `src/`

