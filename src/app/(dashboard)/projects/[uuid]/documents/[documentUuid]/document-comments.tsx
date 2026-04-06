"use client";

import { UnifiedComments } from "@/components/unified-comments";

interface DocumentCommentsProps {
  documentUuid: string;
  currentUserUuid: string;
}

export function DocumentComments({ documentUuid, currentUserUuid }: DocumentCommentsProps) {
  return (
    <UnifiedComments
      targetType="document"
      targetUuid={documentUuid}
      currentUserUuid={currentUserUuid}
      compact
    />
  );
}
