# Design — add-delete-document-ui

## Overview

A small UI vertical slice on top of an already-shipped service-layer delete. We add one Server Action, one client component (Delete button + confirm dialog), wire it into the existing Document detail page action bar, and add i18n strings + unit tests.

## Architecture

```
[ DocumentActions (server) ]
        |
        +-- export buttons (existing)
        +-- back button (existing)
        +-- DeleteDocumentButton (new, "use client")
                |
                +-- shadcn <AlertDialog>
                +-- onConfirm -> deleteDocumentAction(documentUuid)  // Server Action
                +-- on success: toast.success(t("documents.deleteSuccess")) + router.replace + router.refresh
                +-- on failure: toast.error(...) + setInlineError(message)

[ Server Action: deleteDocumentAction(documentUuid) ]
        |
        +-- getServerAuthContext()                 // user | super_admin (no agent path on the dashboard)
        +-- documentService.getDocument(uuid)      // 404 if missing
        +-- assert document.companyUuid === auth.companyUuid  // 403 otherwise
        +-- documentService.deleteDocument(uuid)
        +-- revalidatePath(`/projects/${projectUuid}/documents`)
        +-- return { success: true, projectUuid }
```

The action returns `{ success, projectUuid }` rather than redirecting itself, so the client component owns the navigation (cleaner cancel-handling and toast timing).

## Server Action Contract

```ts
// src/app/(dashboard)/projects/[uuid]/documents/actions.ts
"use server";

export async function deleteDocumentAction(
  documentUuid: string,
): Promise<
  | { success: true; projectUuid: string }
  | { success: false; error: string }
>;
```

Failure modes (must each surface a distinct error string for tests + UX):

| Condition | HTTP-equivalent | Returned shape |
|---|---|---|
| Auth missing | 401 | `{ success: false, error: "unauthorized" }` |
| Document not found | 404 | `{ success: false, error: "not_found" }` |
| Document belongs to a different company | 403 | `{ success: false, error: "forbidden" }` |
| Service throws | 500 | `{ success: false, error: <message> }` |

The client maps `not_found` and `forbidden` to specific i18n strings; everything else falls back to a generic `documents.deleteFailed`.

## Permission Model

This is a dashboard-only affordance. The Server Action behind it uses `getServerAuthContext`, which only resolves to `user` / `super_admin` — agents authenticate via Bearer tokens and reach the system through MCP/REST, not the dashboard. So the auth check collapses to:

1. Auth context exists → proceed.
2. No auth context → `unauthorized`.
3. Document found and `companyUuid` matches → delete.
4. Document found in a different `companyUuid` → `forbidden` (cross-tenant guard).

Agents are intentionally out of scope: they already have `chorus_admin_delete_document` (the MCP tool) for the same business operation. Adding an agent path here would duplicate authorization surface for no UX win, and create noise in `getServerAuthContext`'s narrow type domain.

The Delete button is rendered server-side inside `DocumentActions`, so any human reaching the page sees it.

## Client Component Shape

```tsx
// src/components/documents/delete-document-button.tsx
"use client";

export function DeleteDocumentButton({
  documentUuid,
  documentTitle,
  projectUuid,
}: {
  documentUuid: string;
  documentTitle: string;
  projectUuid: string;
}) {
  // useState: open, pending, inlineError
  // useTranslations("documents") + useTranslations("common")
  // useRouter from next/navigation

  // <AlertDialog>
  //   <AlertDialogTrigger asChild>
  //     <Button variant="destructive" size="sm">
  //       <Trash2 className="mr-2 h-4 w-4" /> {tCommon("delete")}
  //     </Button>
  //   </AlertDialogTrigger>
  //   <AlertDialogContent>
  //     <AlertDialogHeader>
  //       <AlertDialogTitle>{t("deleteDocument")}</AlertDialogTitle>
  //       <AlertDialogDescription>
  //         {t("deleteDocumentDescription", { title: documentTitle })}
  //       </AlertDialogDescription>
  //     </AlertDialogHeader>
  //     {inlineError && <p className="text-sm text-destructive">{inlineError}</p>}
  //     <AlertDialogFooter>
  //       <AlertDialogCancel disabled={pending}>{tCommon("cancel")}</AlertDialogCancel>
  //       <Button variant="destructive" disabled={pending} onClick={onConfirm}>
  //         {pending ? <Loader2 className="animate-spin h-4 w-4" /> : tCommon("delete")}
  //       </Button>
  //     </AlertDialogFooter>
  //   </AlertDialogContent>
  // </AlertDialog>
}
```

Confirm flow:

```ts
async function onConfirm() {
  setPending(true);
  setInlineError(null);
  const result = await deleteDocumentAction(documentUuid);
  if (result.success) {
    toast.success(t("deleteSuccess"));
    setOpen(false);
    router.replace(`/projects/${projectUuid}/documents`);
    router.refresh();
  } else {
    const msg = result.error === "not_found"
      ? t("deleteFailedNotFound")
      : t("deleteFailed");
    setInlineError(msg);
    toast.error(msg);
    setPending(false);
  }
}
```

We use `router.replace` (not `push`) so Back doesn't return to a now-404 detail page. `router.refresh` re-fetches the list page's server data.

## i18n Keys

`messages/en.json` and `messages/zh.json`, under the `documents` namespace:

| Key | English | Chinese |
|---|---|---|
| `documents.deleteDocument` | "Delete Document" | "删除文档" |
| `documents.deleteDocumentDescription` | "This will permanently delete \"{title}\". This action cannot be undone." | "此操作将永久删除文档「{title}」，无法恢复。" |
| `documents.deleteSuccess` | "Document deleted." | "文档已删除。" |
| `documents.deleteFailed` | "Failed to delete document." | "删除文档失败。" |
| `documents.deleteFailedNotFound` | "This document no longer exists." | "该文档已不存在。" |

`common.delete` and `common.cancel` already exist and are reused for buttons.

## Testing

Vitest unit tests against `deleteDocumentAction`, mocking `getServerAuthContext`, `documentService.getDocument`, `documentService.deleteDocument`, and `revalidatePath`:

1. **Unauthorized**: no auth context → returns `{ success: false, error: "unauthorized" }`, does NOT call `getDocument` or `deleteDocument`.
2. **Success (human)**: human auth context, document in same company → returns `{ success: true, projectUuid }`, calls `revalidatePath` with the project's documents path.
3. **Not found**: `documentService.getDocument` returns null → returns `{ success: false, error: "not_found" }`, does NOT call `deleteDocument`.
4. **Cross-company**: document's `companyUuid` differs from `auth.companyUuid` → returns `{ success: false, error: "forbidden" }`, does NOT call `deleteDocument`.

Manual UI verification (the goldenpath UI test the agent must run before reporting done): start `pnpm dev`, navigate to a project's Documents tab, open a document, click Delete, confirm → expect redirect to list, document gone, toast visible.

## Risks & Mitigations

- **Cascade**: Prisma schema already configures cascade deletes (`onDelete: Cascade`) on related rows. We are not changing that. If a document has comments/mentions, those drop with it — same as the API behavior today.
- **Race**: User clicks Delete on a document already deleted in another tab → `not_found` path catches it, dialog shows the friendly message.
- **Wrong-company UUID guess**: A user passing a UUID belonging to another company gets `forbidden`, not `not_found` — same as today's REST handler. The two error codes leak different bits, but only to authenticated users within the system, which matches the rest of the dashboard's behavior.
