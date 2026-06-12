"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Settings,
  Trash2,
  AlertTriangle,
  Lock,
  Globe,
  Plus,
  X,
  User as UserIcon,
  Bot,
} from "lucide-react";
import { authFetch } from "@/lib/auth-client";
import { isImeComposing } from "@/lib/ime";

type Visibility = "shared" | "private";

interface GroupMember {
  uuid: string;
  memberType: "user" | "agent";
  memberUuid: string;
  name?: string | null;
  role: string | null;
  createdAt: string;
}

interface Mentionable {
  type: "user" | "agent";
  uuid: string;
  name: string;
  email?: string | null;
}

interface ManageProjectGroupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groupUuid: string;
  groupName: string;
  groupDescription: string | null;
  projectCount: number;
  visibility: Visibility;
  isOwner: boolean;
  onUpdated: () => void;
}

export function ManageProjectGroupDialog({
  open,
  onOpenChange,
  groupUuid,
  groupName,
  groupDescription,
  projectCount,
  visibility: initialVisibility,
  isOwner,
  onUpdated,
}: ManageProjectGroupDialogProps) {
  const t = useTranslations("projectGroups");
  const router = useRouter();
  const [name, setName] = useState(groupName);
  const [description, setDescription] = useState(groupDescription ?? "");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteProjects, setDeleteProjects] = useState(false);

  const [visibility, setVisibility] = useState<Visibility>(initialVisibility);
  const [visibilitySaving, setVisibilitySaving] = useState(false);
  const [visibilityError, setVisibilityError] = useState<string | null>(null);

  const [members, setMembers] = useState<GroupMember[]>([]);
  const [memberError, setMemberError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<Mentionable[]>([]);
  const [adding, setAdding] = useState(false);

  // Reset state when dialog opens
  const handleOpenChange = (next: boolean) => {
    if (next) {
      setName(groupName);
      setDescription(groupDescription ?? "");
      setShowDeleteConfirm(false);
      setDeleteProjects(false);
      setVisibility(initialVisibility);
      setVisibilityError(null);
      setMemberError(null);
      setSearch("");
      setResults([]);
    }
    onOpenChange(next);
  };

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const res = await authFetch(`/api/project-groups/${groupUuid}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), description: description.trim() || null }),
      });
      const json = await res.json();
      if (json.success) {
        onUpdated();
      }
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      const url = deleteProjects
        ? `/api/project-groups/${groupUuid}?deleteProjects=true`
        : `/api/project-groups/${groupUuid}`;
      const res = await authFetch(url, {
        method: "DELETE",
      });
      const json = await res.json();
      if (json.success) {
        onOpenChange(false);
        router.push("/projects");
      }
    } finally {
      setDeleting(false);
    }
  };

  const fetchMembers = useCallback(async () => {
    try {
      const res = await authFetch(`/api/project-groups/${groupUuid}/members`);
      const json = await res.json();
      if (json.success) {
        setMembers(json.data?.members ?? []);
      }
    } catch {
      // silently ignore — surfaced via empty list
    }
  }, [groupUuid]);

  // Load members when the dialog opens and the actor manages a private group.
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
        const res = await authFetch(
          `/api/mentionables?q=${encodeURIComponent(search.trim())}&limit=10&forMembers=1`,
        );
        const json = await res.json();
        if (json.success) {
          setResults(json.data ?? []);
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
      const res = await authFetch(`/api/project-groups/${groupUuid}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visibility: next }),
      });
      const json = await res.json();
      if (!json.success) {
        setVisibility(previous);
        setVisibilityError(json.error || t("visibilityUpdateFailed"));
      } else {
        router.refresh();
      }
    } catch {
      setVisibility(previous);
      setVisibilityError(t("visibilityUpdateFailed"));
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
      const res = await authFetch(`/api/project-groups/${groupUuid}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memberType, memberUuid: value }),
      });
      const json = await res.json();
      if (!json.success) {
        setMemberError(json.error || t("memberAddFailed"));
      } else {
        setSearch("");
        setResults([]);
        await fetchMembers();
      }
    } catch {
      setMemberError(t("memberAddFailed"));
    } finally {
      setAdding(false);
    }
  };

  const removeMember = async (member: GroupMember) => {
    setMemberError(null);
    try {
      const res = await authFetch(
        `/api/project-groups/${groupUuid}/members?memberType=${member.memberType}&memberUuid=${encodeURIComponent(member.memberUuid)}`,
        { method: "DELETE" },
      );
      const json = await res.json();
      if (!json.success) {
        setMemberError(json.error || t("memberRemoveFailed"));
      } else {
        await fetchMembers();
      }
    } catch {
      setMemberError(t("memberRemoveFailed"));
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
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-[480px] gap-0 p-0">
        <DialogHeader className="border-b border-[#E5E2DC] px-6 py-5">
          <div className="flex items-center gap-2.5">
            <Settings className="h-5 w-5 text-[#C67A52]" />
            <DialogTitle className="text-[18px] font-semibold tracking-tight text-[#2C2C2C]">
              {t("manageGroup")}
            </DialogTitle>
          </div>
        </DialogHeader>

        <div className="max-h-[70vh] space-y-5 overflow-y-auto px-6 py-5">
          {/* Edit Name */}
          <div className="space-y-1.5">
            <Label className="text-[13px] font-medium text-[#2C2C2C]">
              {t("groupName")}
            </Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-10 rounded-lg border-[#E5E2DC] text-[13px] focus-visible:ring-[#C67A52]"
            />
          </div>

          {/* Edit Description */}
          <div className="space-y-1.5">
            <Label className="text-[13px] font-medium text-[#2C2C2C]">
              {t("descriptionOptional")}
            </Label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="w-full rounded-lg border border-[#E5E2DC] px-3 py-2.5 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C67A52] focus-visible:ring-offset-1"
              placeholder={t("descriptionPlaceholder")}
            />
          </div>

          {/* Save Button */}
          <div className="flex justify-end">
            <Button
              onClick={handleSave}
              disabled={saving || !name.trim() || (name === groupName && description === (groupDescription ?? ""))}
              className="rounded-lg bg-[#C67A52] text-[13px] font-medium text-white hover:bg-[#B56A42]"
            >
              {saving ? t("saving") : t("saveChanges")}
            </Button>
          </div>

          {/* Visibility */}
          <div className="space-y-3 border-t border-[#E5E2DC] pt-5">
            <Label className="text-[13px] font-medium text-[#2C2C2C]">
              {t("visibility")}
            </Label>

            {!isOwner && (
              <p className="text-[12px] text-[#9A9A9A]">
                {t("onlyOwnerCanManage")}
              </p>
            )}

            <RadioGroup
              value={visibility}
              onValueChange={(value) => handleVisibilityChange(value as Visibility)}
              disabled={!isOwner || visibilitySaving}
              className="gap-2.5"
            >
              <Label
                htmlFor="group-visibility-shared"
                className="flex cursor-pointer items-start gap-3 rounded-lg border border-[#E5E2DC] px-4 py-3"
              >
                <RadioGroupItem
                  id="group-visibility-shared"
                  value="shared"
                  className="mt-0.5"
                />
                <div className="flex flex-col gap-0.5">
                  <span className="flex items-center gap-1.5 text-[13px] font-semibold text-[#2C2C2C]">
                    <Globe className="h-3.5 w-3.5 text-[#6B6B6B]" />
                    {t("visibilityShared")}
                  </span>
                  <span className="text-[12px] text-[#6B6B6B]">
                    {t("visibilitySharedDesc")}
                  </span>
                </div>
              </Label>

              <Label
                htmlFor="group-visibility-private"
                className="flex cursor-pointer items-start gap-3 rounded-lg border border-[#E5E2DC] px-4 py-3"
              >
                <RadioGroupItem
                  id="group-visibility-private"
                  value="private"
                  className="mt-0.5"
                />
                <div className="flex flex-col gap-0.5">
                  <span className="flex items-center gap-1.5 text-[13px] font-semibold text-[#2C2C2C]">
                    <Lock className="h-3.5 w-3.5 text-[#6B6B6B]" />
                    {t("visibilityPrivate")}
                  </span>
                  <span className="text-[12px] text-[#6B6B6B]">
                    {t("visibilityPrivateDesc")}
                  </span>
                </div>
              </Label>
            </RadioGroup>

            {visibilityError && (
              <p className="text-[12px] text-[#C4574C]">{visibilityError}</p>
            )}

            {/* Members manager (private + owner only) */}
            {visibility === "private" && isOwner && (
              <div className="flex flex-col gap-3 pt-1">
                <Label className="text-[13px] font-medium text-[#2C2C2C]">
                  {t("members")}
                </Label>

                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={handleSearchKeyDown}
                  placeholder={t("addMemberPlaceholder")}
                  className="h-10 rounded-lg border-[#E5E2DC] text-[13px] focus-visible:ring-[#C67A52]"
                />

                {/* Search results */}
                {search.trim() && results.length > 0 && (
                  <ScrollArea className="max-h-40 rounded-lg border border-[#E5E2DC]">
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
                  <p className="text-[12px] text-[#9A9A9A]">{t("noMembers")}</p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {members.map((m) => (
                      <div
                        key={m.uuid}
                        className="flex items-center justify-between gap-2 rounded-lg border border-[#E5E2DC] px-3 py-2"
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          {m.memberType === "agent" ? (
                            <Bot className="h-3.5 w-3.5 shrink-0 text-[#6B6B6B]" />
                          ) : (
                            <UserIcon className="h-3.5 w-3.5 shrink-0 text-[#6B6B6B]" />
                          )}
                          <span className="truncate text-[13px] text-[#2C2C2C]">
                            {m.name ?? m.memberUuid}
                          </span>
                          <Badge variant="secondary" className="shrink-0 text-[10px]">
                            {m.memberType === "agent"
                              ? t("memberAgent")
                              : t("memberUser")}
                          </Badge>
                        </span>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={t("removeMember")}
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
        </div>

        {/* Danger Zone */}
        {isOwner && (
          <div className="border-t border-[#E5E2DC] px-6 py-5">
            {!showDeleteConfirm ? (
              <button
                onClick={() => setShowDeleteConfirm(true)}
                className="flex w-full cursor-pointer items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-left text-[13px] font-medium text-red-600 transition-colors hover:border-red-300 hover:bg-red-100"
              >
                <Trash2 className="h-4 w-4" />
                {t("deleteGroup")}
              </button>
            ) : (
              <div className="space-y-3 rounded-lg border border-red-200 bg-red-50 p-4">
                <div className="flex items-center gap-2 text-[13px] font-semibold text-red-700">
                  <AlertTriangle className="h-4 w-4" />
                  {t("deleteConfirmTitle")}
                </div>
                <p className="text-[12px] text-red-600">
                  {t("deleteConfirmDesc")}
                </p>

                {projectCount > 0 && (
                  <div className="space-y-2 pt-1">
                    <Label className="flex cursor-pointer items-center gap-2 text-[12px] font-normal text-[#2C2C2C]">
                      <input
                        type="radio"
                        name="deleteOption"
                        checked={!deleteProjects}
                        onChange={() => setDeleteProjects(false)}
                        className="accent-[#C67A52]"
                      />
                      {t("deleteKeepProjects", { count: projectCount })}
                    </Label>
                    <Label className="flex cursor-pointer items-center gap-2 text-[12px] font-normal text-red-600">
                      <input
                        type="radio"
                        name="deleteOption"
                        checked={deleteProjects}
                        onChange={() => setDeleteProjects(true)}
                        className="accent-red-600"
                      />
                      {t("deleteWithProjects", { count: projectCount })}
                    </Label>
                  </div>
                )}

                <div className="flex gap-2 pt-1">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowDeleteConfirm(false)}
                    className="rounded-lg border-[#E5E2DC] text-[12px]"
                  >
                    {t("cancel")}
                  </Button>
                  <Button
                    size="sm"
                    onClick={handleDelete}
                    disabled={deleting}
                    className="rounded-lg bg-red-600 text-[12px] text-white hover:bg-red-700"
                  >
                    <Trash2 className="mr-1 h-3 w-3" />
                    {deleting ? t("deleting") : t("confirmDelete")}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
