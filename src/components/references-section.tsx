"use client";

// Shared read-only References view + add/edit/delete affordances for an idea,
// proposal, or task (external evidence — GH #399 point 2). Rendered inside a
// sidebar Card on the proposal detail page and a labeled section on the task
// and idea detail panels. Writes go through the "use server" reference actions;
// on success the local list refetches and the server tree is refreshed.
//
// Dark-mode: every type badge uses a hue-matched `dark:` variant (no
// fixed-light-only classes); all other surfaces use semantic tokens.

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "@/hooks/use-progress-router";
import { useTranslations } from "next-intl";
import {
  Link as LinkIcon,
  ExternalLink,
  Plus,
  Pencil,
  Trash2,
  Loader2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  listReferencesAction,
  createReferenceAction,
  updateReferenceAction,
  deleteReferenceAction,
} from "@/app/(dashboard)/projects/[uuid]/references-actions";
import type { ReferenceArtifactResponse } from "@/services/reference-artifact.service";
import {
  REFERENCE_TYPE_OPTIONS,
  referenceTypeConfig as typeConfig,
  isKnownReferenceType as isKnownType,
} from "@/components/reference-type-config";
import { ReferenceNotes } from "@/components/reference-notes";

interface ReferencesSectionProps {
  targetType: "proposal" | "task" | "idea";
  targetUuid: string;
  canWrite: boolean;
  // Optional server-rendered seed to avoid a load flash; the component still
  // refetches after any mutation.
  initialReferences?: ReferenceArtifactResponse[];
  // Tighter spacing for the task detail panel.
  compact?: boolean;
}

export function ReferencesSection({
  targetType,
  targetUuid,
  canWrite,
  initialReferences,
  compact = false,
}: ReferencesSectionProps) {
  const t = useTranslations();
  const router = useRouter();

  const [references, setReferences] = useState<ReferenceArtifactResponse[]>(
    initialReferences ?? [],
  );
  const [loaded, setLoaded] = useState(initialReferences !== undefined);

  // Dialog (add + edit) state.
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ReferenceArtifactResponse | null>(null);
  const [formType, setFormType] = useState<string>("docs");
  const [formUrl, setFormUrl] = useState("");
  const [formTitle, setFormTitle] = useState("");
  const [formNotes, setFormNotes] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Per-row delete-in-flight uuid.
  const [deletingUuid, setDeletingUuid] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    const result = await listReferencesAction(targetType, targetUuid);
    if (result.success) {
      setReferences(result.references);
    }
    setLoaded(true);
  }, [targetType, targetUuid]);

  useEffect(() => {
    if (initialReferences === undefined) {
      void refetch();
    }
  }, [initialReferences, refetch]);

  const openAdd = () => {
    setEditing(null);
    setFormType("docs");
    setFormUrl("");
    setFormTitle("");
    setFormNotes("");
    setFormError(null);
    setDialogOpen(true);
  };

  const openEdit = (ref: ReferenceArtifactResponse) => {
    setEditing(ref);
    setFormType(ref.type);
    setFormUrl(ref.url);
    setFormTitle(ref.title);
    setFormNotes(ref.notes ?? "");
    setFormError(null);
    setDialogOpen(true);
  };

  const handleSubmit = async () => {
    if (!formUrl.trim()) {
      setFormError(t("references.urlRequired"));
      return;
    }
    if (!formTitle.trim()) {
      setFormError(t("references.titleRequired"));
      return;
    }

    setIsSaving(true);
    setFormError(null);

    const notes = formNotes.trim() ? formNotes.trim() : null;
    const result = editing
      ? await updateReferenceAction({
          uuid: editing.uuid,
          type: formType,
          url: formUrl.trim(),
          title: formTitle.trim(),
          notes,
        })
      : await createReferenceAction({
          targetType,
          targetUuid,
          type: formType,
          url: formUrl.trim(),
          title: formTitle.trim(),
          notes,
        });

    setIsSaving(false);

    if (result.success) {
      setDialogOpen(false);
      await refetch();
      router.refresh();
    } else {
      setFormError(
        result.error ||
          (editing ? t("references.updateFailed") : t("references.addFailed")),
      );
    }
  };

  const handleDelete = async (uuid: string) => {
    setDeletingUuid(uuid);
    const result = await deleteReferenceAction(uuid);
    setDeletingUuid(null);
    if (result.success) {
      await refetch();
      router.refresh();
    }
  };

  return (
    <div className={compact ? "space-y-2" : "space-y-2.5"}>
      {/* Rows / empty state */}
      {references.length === 0 ? (
        <p className="text-sm italic text-muted-foreground">
          {loaded ? t("references.empty") : t("references.loading")}
        </p>
      ) : (
        <div className="space-y-2">
          {references.map((ref) => {
            const cfg = isKnownType(ref.type) ? typeConfig[ref.type] : null;
            const TypeIcon = cfg?.icon ?? LinkIcon;
            return (
              <div
                key={ref.uuid}
                className="group rounded-lg border border-border bg-background p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="mb-1 flex items-center gap-2">
                      <Badge
                        className={`gap-1 border-0 text-[10px] font-medium ${
                          cfg?.badgeClass ??
                          "bg-secondary text-muted-foreground"
                        }`}
                      >
                        <TypeIcon className="h-3 w-3" />
                        {cfg
                          ? t(cfg.labelKey)
                          : ref.type}
                      </Badge>
                    </div>
                    <a
                      href={ref.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={ref.title}
                      className="flex min-w-0 items-center gap-1 text-sm font-medium text-primary hover:underline"
                    >
                      <span className="truncate">{ref.title}</span>
                      <ExternalLink className="h-3 w-3 shrink-0" />
                    </a>
                    <ReferenceNotes notes={ref.notes} />
                  </div>

                  {canWrite && (
                    <div className="flex shrink-0 items-center gap-0.5 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => openEdit(ref)}
                        aria-label={t("references.editReference")}
                      >
                        <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                      </Button>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            aria-label={t("references.deleteReference")}
                          >
                            {deletingUuid === ref.uuid ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                            ) : (
                              <Trash2 className="h-3.5 w-3.5 text-destructive" />
                            )}
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>
                              {t("references.deleteReference")}
                            </AlertDialogTitle>
                            <AlertDialogDescription>
                              {t("references.deleteConfirm", { title: ref.title })}
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>
                              {t("common.cancel")}
                            </AlertDialogCancel>
                            <AlertDialogAction
                              variant="destructive"
                              onClick={() => handleDelete(ref.uuid)}
                            >
                              {t("common.delete")}
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Add reference trigger */}
      {canWrite && (
        <Button
          variant="outline"
          size="sm"
          className="h-8 w-full gap-1.5 border-border border-dashed text-xs text-muted-foreground"
          onClick={openAdd}
        >
          <Plus className="h-3.5 w-3.5" />
          {t("references.addReference")}
        </Button>
      )}

      {/* Add / Edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>
              {editing
                ? t("references.editReference")
                : t("references.addReference")}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {formError && (
              <div className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
                {formError}
              </div>
            )}

            <div className="space-y-2">
              <Label
                htmlFor="ref-type"
                className="text-[13px] font-medium text-foreground"
              >
                {t("references.typeLabel")}
              </Label>
              <Select value={formType} onValueChange={setFormType}>
                <SelectTrigger
                  id="ref-type"
                  className="border-border focus:ring-primary"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REFERENCE_TYPE_OPTIONS.map((opt) => (
                    <SelectItem key={opt} value={opt}>
                      {t(typeConfig[opt].labelKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label
                htmlFor="ref-url"
                className="text-[13px] font-medium text-foreground"
              >
                {t("references.urlLabel")} *
              </Label>
              <Input
                id="ref-url"
                value={formUrl}
                onChange={(e) => setFormUrl(e.target.value)}
                placeholder={t("references.urlPlaceholder")}
                className="border-border focus-visible:ring-primary"
                autoFocus
              />
            </div>

            <div className="space-y-2">
              <Label
                htmlFor="ref-title"
                className="text-[13px] font-medium text-foreground"
              >
                {t("references.titleLabel")} *
              </Label>
              <Input
                id="ref-title"
                value={formTitle}
                onChange={(e) => setFormTitle(e.target.value)}
                placeholder={t("references.titlePlaceholder")}
                className="border-border focus-visible:ring-primary"
              />
            </div>

            <div className="space-y-2">
              <Label
                htmlFor="ref-notes"
                className="text-[13px] font-medium text-foreground"
              >
                {t("references.notesLabel")}
              </Label>
              <Textarea
                id="ref-notes"
                value={formNotes}
                onChange={(e) => setFormNotes(e.target.value)}
                placeholder={t("references.notesPlaceholder")}
                rows={3}
                className="resize-none border-border focus-visible:ring-primary"
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDialogOpen(false)}
              disabled={isSaving}
              className="border-border"
            >
              {t("common.cancel")}
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={isSaving || !formUrl.trim() || !formTitle.trim()}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {isSaving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t("common.saving")}
                </>
              ) : editing ? (
                t("common.save")
              ) : (
                t("references.add")
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
