"use client";

import { ExportDropdown } from "@/components/export-dropdown";
import { DeleteDocumentButton } from "@/components/documents/delete-document-button";
import type { ExportableDocument } from "@/types/export";

interface DocumentActionsProps {
  documentUuid: string;
  projectUuid: string;
  documentTitle: string;
  canDelete: boolean;
  exportDoc?: ExportableDocument;
}

export function DocumentActions({
  documentUuid,
  projectUuid,
  documentTitle,
  canDelete,
  exportDoc,
}: DocumentActionsProps) {
  return (
    <div className="flex gap-2">
      {exportDoc ? (
        <ExportDropdown document={exportDoc} />
      ) : (
        <ExportDropdown documentUuid={documentUuid} />
      )}
      {canDelete && (
        <DeleteDocumentButton
          documentUuid={documentUuid}
          documentTitle={documentTitle}
          projectUuid={projectUuid}
        />
      )}
    </div>
  );
}
