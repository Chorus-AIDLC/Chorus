"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Settings, Loader2, Lock, Globe, Plus, X, User as UserIcon, Bot } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
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
import { isImeComposing } from "@/lib/ime";
import { updateProjectAction, deleteProjectAction } from "../actions";

type Visibility = "shared" | "private";

interface ProjectMember {
  uuid: string;
  memberType: "user" | "agent";
  memberUuid: string;
  role: string | null;
  createdAt: string;
}

interface Mentionable {
  type: "user" | "agent";
  uuid: string;
  name: string;
  email?: string | null;
}

interface ProjectSettingsModalProps {
  projectUuid: string;
  projectName: string;
  projectDescription: string | null;
  visibility: Visibility;
  isOwner: boolean;
}

export function ProjectSettingsModal({
  projectUuid,
  projectName,
  projectDescription,
  visibility: initialVisibility,
  isOwner,
}: ProjectSettingsModalProps) {
  const t = useTranslations();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(projectName);
  const [description, setDescription] = useState(projectDescription || "");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [visibility, setVisibility] = useState<Visibility>(initialVisibility);
  const [visibilitySaving, setVisibilitySaving] = useState(false);
  const [visibilityError, setVisibilityError] = useState<string | null>(null);

  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [memberError, setMemberError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<Mentionable[]>([]);
  const [adding, setAdding] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    const result = await updateProjectAction(projectUuid, {
      name,
      description: description || null,
    });
    setSaving(false);
    if (result.success) {
      setOpen(false);
      router.refresh();
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    const result = await deleteProjectAction(projectUuid);
    if (result && !result.success) {
      setDeleting(false);
    }
  };

  const fetchMembers = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectUuid}/members`);
      const json = await res.json();
      if (json.success) {
        setMembers(json.data || []);
      }
    } catch {
      // silently ignore — surfaced via empty list
    }
  }, [projectUuid]);

  // Load members when the modal opens and visibility is private.
  useEffect(() => {
    if (open && visibility === "private" && isOwner) {
      fetchMembers();
    }
  }, [open, visibility, isOwner, fetchMembers]);

  // Search mentionables (users/agents) as the owner types.
  useEffect(() => {
    if (!open || visibility !== "private" || !isOwner) return;
    const handle = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/mentionables?q=${encodeURIComponent(search.trim())}&limit=10`,
        );
        const json = await res.json();
        if (json.success) {
          setResults(json.data || []);
        }
      } catch {
        setResults([]);
      }
    }, 200);
    return () => clearTimeout(handle);
  }, [search, open, visibility, isOwner]);

  const handleVisibilityChange = async (next: Visibility) => {
    if (next === visibility) return;
    const previous = visibility;
    setVisibility(next);
    setVisibilitySaving(true);
    setVisibilityError(null);
    try {
      const res = await fetch(`/api/projects/${projectUuid}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visibility: next }),
      });
      const json = await res.json();
      if (!json.success) {
        setVisibility(previous);
        setVisibilityError(json.error || t("projects.visibilityUpdateFailed"));
      } else {
        router.refresh();
      }
    } catch {
      setVisibility(previous);
      setVisibilityError(t("projects.visibilityUpdateFailed"));
    } finally {
      setVisibilitySaving(false);
    }
  };

  const addMember = async (memberType: "user" | "agent", memberUuid: string) => {
    const value = memberUuid.trim();
    if (!value) return;
    setAdding(true);
    setMemberError(null);
    try {
      const res = await fetch(`/api/projects/${projectUuid}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memberType, memberUuid: value }),
      });
      const json = await res.json();
      if (!json.success) {
        setMemberError(json.error || t("projects.memberAddFailed"));
      } else {
        setSearch("");
        setResults([]);
        await fetchMembers();
      }
    } catch {
      setMemberError(t("projects.memberAddFailed"));
    } finally {
      setAdding(false);
    }
  };

  const removeMember = async (member: ProjectMember) => {
    setMemberError(null);
    try {
      const res = await fetch(
        `/api/projects/${projectUuid}/members?memberType=${member.memberType}&memberUuid=${encodeURIComponent(member.memberUuid)}`,
        { method: "DELETE" },
      );
      const json = await res.json();
      if (!json.success) {
        setMemberError(json.error || t("projects.memberRemoveFailed"));
      } else {
        await fetchMembers();
      }
    } catch {
      setMemberError(t("projects.memberRemoveFailed"));
    }
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    if (isImeComposing(e)) return;
    e.preventDefault();
    const value = search.trim();
    if (!value) return;
    // If the input looks like a raw UUID, add it directly as a user member.
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
      addMember("user", value);
    } else if (results.length > 0) {
      addMember(results[0].type, results[0].uuid);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 rounded-lg border-[#E5E2DC] bg-white text-[12px] font-normal text-[#2C2C2C] hover:border-[#C67A52] hover:bg-white"
        >
          <Settings className="h-3.5 w-3.5 text-[#6B6B6B]" />
          {t("dashboard.settings")}
        </Button>
      </DialogTrigger>
      <DialogContent className="gap-0 overflow-hidden rounded-2xl border-0 p-0 sm:max-w-[520px]">
        <DialogHeader className="px-7 py-6">
          <DialogTitle className="text-[20px] font-semibold tracking-tight text-[#2C2C2C]">
            {t("projectSettings.title")}
          </DialogTitle>
        </DialogHeader>

        <Separator className="bg-[#E5E2DC]" />

        <div className="flex max-h-[70vh] flex-col gap-7 overflow-y-auto p-7">
          {/* Basic Information */}
          <div className="flex flex-col gap-5">
            <h3 className="text-[14px] font-semibold text-[#2C2C2C]">
              {t("projectSettings.basicInfo")}
            </h3>

            <div className="flex flex-col gap-1.5">
              <Label className="text-[12px] font-medium text-[#6B6B6B]">
                {t("projectSettings.projectName")}
              </Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="h-11 rounded-[10px] border-[#E5E2DC] text-[14px] text-[#2C2C2C] focus-visible:ring-[#C67A52]"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label className="text-[12px] font-medium text-[#6B6B6B]">
                {t("projectSettings.description")}
              </Label>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                className="resize-none rounded-[10px] border-[#E5E2DC] text-[14px] text-[#2C2C2C] focus-visible:ring-[#C67A52]"
              />
            </div>

            <Button
              onClick={handleSave}
              disabled={saving || !name.trim()}
              className="w-fit rounded-[10px] bg-[#C67A52] px-6 text-[13px] font-semibold text-white hover:bg-[#B56A42]"
            >
              {saving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t("projectSettings.saving")}
                </>
              ) : (
                t("projectSettings.saveChanges")
              )}
            </Button>
          </div>

          <Separator className="bg-[#E5E2DC]" />

          {/* Visibility */}
          <div className="flex flex-col gap-4">
            <h3 className="text-[14px] font-semibold text-[#2C2C2C]">
              {t("projects.visibility")}
            </h3>

            {!isOwner && (
              <p className="text-[12px] text-[#9A9A9A]">
                {t("projects.onlyOwnerCanManage")}
              </p>
            )}

            <RadioGroup
              value={visibility}
              onValueChange={(value) => handleVisibilityChange(value as Visibility)}
              disabled={!isOwner || visibilitySaving}
              className="gap-3"
            >
              <Label
                htmlFor="visibility-shared"
                className="flex cursor-pointer items-start gap-3 rounded-xl border border-[#E5E2DC] px-4 py-3"
              >
                <RadioGroupItem
                  id="visibility-shared"
                  value="shared"
                  className="mt-0.5"
                />
                <div className="flex flex-col gap-0.5">
                  <span className="flex items-center gap-1.5 text-[13px] font-semibold text-[#2C2C2C]">
                    <Globe className="h-3.5 w-3.5 text-[#6B6B6B]" />
                    {t("projects.visibilityShared")}
                  </span>
                  <span className="text-[12px] text-[#6B6B6B]">
                    {t("projects.visibilitySharedDesc")}
                  </span>
                </div>
              </Label>

              <Label
                htmlFor="visibility-private"
                className="flex cursor-pointer items-start gap-3 rounded-xl border border-[#E5E2DC] px-4 py-3"
              >
                <RadioGroupItem
                  id="visibility-private"
                  value="private"
                  className="mt-0.5"
                />
                <div className="flex flex-col gap-0.5">
                  <span className="flex items-center gap-1.5 text-[13px] font-semibold text-[#2C2C2C]">
                    <Lock className="h-3.5 w-3.5 text-[#6B6B6B]" />
                    {t("projects.visibilityPrivate")}
                  </span>
                  <span className="text-[12px] text-[#6B6B6B]">
                    {t("projects.visibilityPrivateDesc")}
                  </span>
                </div>
              </Label>
            </RadioGroup>

            {visibilityError && (
              <p className="text-[12px] text-[#C4574C]">{visibilityError}</p>
            )}

            {/* Members manager (private + owner only) */}
            {visibility === "private" && isOwner && (
              <div className="flex flex-col gap-3">
                <Label className="text-[12px] font-medium text-[#6B6B6B]">
                  {t("projects.members")}
                </Label>

                <div className="flex items-center gap-2">
                  <Input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    onKeyDown={handleSearchKeyDown}
                    placeholder={t("projects.addMemberPlaceholder")}
                    className="h-10 flex-1 rounded-[10px] border-[#E5E2DC] text-[13px] text-[#2C2C2C] focus-visible:ring-[#C67A52]"
                  />
                </div>

                {/* Search results */}
                {search.trim() && results.length > 0 && (
                  <ScrollArea className="max-h-40 rounded-[10px] border border-[#E5E2DC]">
                    <div className="flex flex-col">
                      {results.map((r) => (
                        <Button
                          key={`${r.type}-${r.uuid}`}
                          type="button"
                          variant="ghost"
                          disabled={adding}
                          onClick={() => addMember(r.type, r.uuid)}
                          className="flex h-auto items-center justify-between gap-2 rounded-none px-3 py-2 text-left font-normal hover:bg-[#F5F2EC]"
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            {r.type === "agent" ? (
                              <Bot className="h-3.5 w-3.5 shrink-0 text-[#6B6B6B]" />
                            ) : (
                              <UserIcon className="h-3.5 w-3.5 shrink-0 text-[#6B6B6B]" />
                            )}
                            <span className="truncate text-[13px] text-[#2C2C2C]">
                              {r.name}
                            </span>
                          </span>
                          <Plus className="h-3.5 w-3.5 shrink-0 text-[#C67A52]" />
                        </Button>
                      ))}
                    </div>
                  </ScrollArea>
                )}

                {memberError && (
                  <p className="text-[12px] text-[#C4574C]">{memberError}</p>
                )}

                {/* Current members */}
                {members.length === 0 ? (
                  <p className="text-[12px] text-[#9A9A9A]">
                    {t("projects.noMembers")}
                  </p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {members.map((m) => (
                      <div
                        key={m.uuid}
                        className="flex items-center justify-between gap-2 rounded-[10px] border border-[#E5E2DC] px-3 py-2"
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          {m.memberType === "agent" ? (
                            <Bot className="h-3.5 w-3.5 shrink-0 text-[#6B6B6B]" />
                          ) : (
                            <UserIcon className="h-3.5 w-3.5 shrink-0 text-[#6B6B6B]" />
                          )}
                          <span className="truncate text-[13px] text-[#2C2C2C]">
                            {m.memberUuid}
                          </span>
                          <Badge variant="secondary" className="shrink-0 text-[10px]">
                            {m.memberType === "agent"
                              ? t("projects.memberAgent")
                              : t("projects.memberUser")}
                          </Badge>
                        </span>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={t("projects.removeMember")}
                          onClick={() => removeMember(m)}
                          className="h-7 w-7 shrink-0 text-[#9A9A9A] hover:text-[#C4574C]"
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {isOwner && (
            <>
              <Separator className="bg-[#E5E2DC]" />

              {/* Danger Zone */}
              <div className="flex flex-col gap-4">
                <h3 className="text-[14px] font-semibold text-[#C4574C]">
                  {t("projectSettings.dangerZone")}
                </h3>

                <div className="rounded-xl border border-[#C4574C40] bg-[#C4574C08] px-[18px] py-4">
                  <div className="flex items-center justify-between">
                    <div className="flex flex-col gap-1">
                      <span className="text-[13px] font-semibold text-[#2C2C2C]">
                        {t("projectSettings.deleteTitle")}
                      </span>
                      <span className="text-[12px] text-[#6B6B6B]">
                        {t("projectSettings.deleteDescription")}
                      </span>
                    </div>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="destructive"
                          size="sm"
                          className="ml-4 shrink-0 rounded-lg bg-[#C4574C] px-[18px] text-[12px] font-medium hover:bg-[#B3463B]"
                        >
                          {t("common.delete")}
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>
                            {t("projectOverview.deleteProject")}
                          </AlertDialogTitle>
                          <AlertDialogDescription>
                            {t("projectOverview.deleteProjectConfirm", {
                              name: projectName,
                            })}
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>
                            {t("common.cancel")}
                          </AlertDialogCancel>
                          <AlertDialogAction
                            variant="destructive"
                            onClick={handleDelete}
                            disabled={deleting}
                          >
                            {deleting ? (
                              <>
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                {t("common.delete")}
                              </>
                            ) : (
                              t("common.delete")
                            )}
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
