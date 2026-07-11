"use client";

import { useState, useRef } from "react";
import { useRouter } from "@/hooks/use-progress-router";
import { useTranslations } from "next-intl";
import { Plus, Upload, Loader2, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createDocumentAction } from "./actions";

interface CreateDocumentDialogProps {
  projectUuid: string;
  trigger?: React.ReactNode;
}

export function CreateDocumentDialog({ projectUuid, trigger }: CreateDocumentDialogProps) {
  const t = useTranslations();
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [type, setType] = useState("prd");
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const resetForm = () => {
    setTitle("");
    setType("prd");
    setFileName(null);
    setFileContent("");
    setError(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setFileName(file.name);

    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      setFileContent(text);
    };
    reader.readAsText(file);
  };

  const handleSubmit = async () => {
    if (!title.trim()) {
      setError(t("documents.titleRequired"));
      return;
    }

    setIsSaving(true);
    setError(null);

    const result = await createDocumentAction({
      projectUuid,
      title: title.trim(),
      type,
      content: fileContent,
    });

    setIsSaving(false);

    if (result.success) {
      setOpen(false);
      resetForm();
      router.refresh();
      if (result.documentUuid) {
        router.push(`/projects/${projectUuid}/documents/${result.documentUuid}`);
      }
    } else {
      setError(result.error || t("documents.createFailed"));
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) resetForm();
      }}
    >
      <DialogTrigger asChild>
        {trigger || (
          <Button className="bg-primary hover:bg-[#B56A42] text-white">
            <Plus className="mr-2 h-4 w-4" />
            {t("documents.newDocument")}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{t("documents.createDocument")}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {error && (
            <div className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="doc-title" className="text-[13px] font-medium text-foreground">
              {t("documents.titleLabel")} *
            </Label>
            <Input
              id="doc-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("documents.titlePlaceholder")}
              className="border-border focus-visible:ring-primary"
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="doc-type" className="text-[13px] font-medium text-foreground">
              {t("documents.typeLabel")}
            </Label>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger className="border-border focus:ring-primary">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="prd">PRD</SelectItem>
                <SelectItem value="spec">Spec</SelectItem>
                <SelectItem value="design">Design</SelectItem>
                <SelectItem value="note">Note</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label className="text-[13px] font-medium text-foreground">
              {t("documents.uploadMarkdown")}
            </Label>
            <div
              className="flex cursor-pointer items-center gap-3 rounded-lg border border-dashed border-border p-4 transition-colors hover:border-primary hover:bg-[#FFFBF8] dark:hover:bg-[#1e1d1b]"
              onClick={() => fileInputRef.current?.click()}
            >
              {fileName ? (
                <>
                  <FileText className="h-5 w-5 text-primary" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{fileName}</p>
                    <p className="text-xs text-[#9A9A9A]">
                      {fileContent.length.toLocaleString()} {t("documents.characters")}
                    </p>
                  </div>
                </>
              ) : (
                <>
                  <Upload className="h-5 w-5 text-[#9A9A9A]" />
                  <div>
                    <p className="text-sm text-muted-foreground">{t("documents.clickToUpload")}</p>
                    <p className="text-xs text-[#9A9A9A]">.md, .txt, .markdown</p>
                  </div>
                </>
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".md,.txt,.markdown"
              onChange={handleFileChange}
              className="hidden"
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={isSaving}
            className="border-border"
          >
            {t("common.cancel")}
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isSaving || !title.trim()}
            className="bg-primary hover:bg-[#B56A42] text-white"
          >
            {isSaving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t("common.creating")}
              </>
            ) : (
              t("common.create")
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
