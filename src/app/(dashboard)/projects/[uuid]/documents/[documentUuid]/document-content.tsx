"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { MarkdownContent } from "@/components/markdown-content";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { updateDocumentAction } from "./actions";

interface DocumentContentProps {
  documentUuid: string;
  projectUuid: string;
  initialContent: string;
}

export function DocumentContent({ documentUuid, projectUuid, initialContent }: DocumentContentProps) {
  const t = useTranslations();
  const router = useRouter();
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(initialContent);
  const [isPending, startTransition] = useTransition();

  const handleSave = () => {
    startTransition(async () => {
      const result = await updateDocumentAction(documentUuid, projectUuid, editContent);
      if (result.success) {
        setIsEditing(false);
        router.refresh();
      }
    });
  };

  const handleCancel = () => {
    setEditContent(initialContent);
    setIsEditing(false);
  };

  return (
    <Card className="flex-1 overflow-auto border-[#E5E0D8] p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-medium text-[#2C2C2C]">{t("common.content")}</h2>
        {isEditing ? (
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={handleCancel}
              disabled={isPending}
              className="border-[#E5E0D8] text-[#6B6B6B]"
            >
              {t("common.cancel")}
            </Button>
            <Button
              onClick={handleSave}
              disabled={isPending}
              className="bg-[#5A9E6F] hover:bg-[#4A8E5F] text-white"
            >
              {isPending ? t("common.processing") : t("documents.saveChanges")}
            </Button>
          </div>
        ) : (
          <Button
            onClick={() => setIsEditing(true)}
            className="bg-[#C67A52] hover:bg-[#B56A42] text-white"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="mr-2 h-4 w-4"
            >
              <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
            </svg>
            {t("common.edit")}
          </Button>
        )}
      </div>

      {isEditing ? (
        <textarea
          value={editContent}
          onChange={(e) => setEditContent(e.target.value)}
          className="h-full w-full resize-none rounded-lg border border-[#E5E0D8] p-4 font-mono text-sm focus:border-[#C67A52] focus:outline-none focus:ring-1 focus:ring-[#C67A52]"
          placeholder={t("documents.documentContent")}
        />
      ) : (
        <div className="prose prose-sm max-w-none text-[#2C2C2C]">
          {initialContent ? (
            <MarkdownContent>{initialContent}</MarkdownContent>
          ) : (
            <span className="text-[#9A9A9A] italic">{t("common.noContent")}</span>
          )}
        </div>
      )}
    </Card>
  );
}
