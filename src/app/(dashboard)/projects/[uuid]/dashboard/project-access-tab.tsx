"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Check, ChevronsUpDown, Loader2, Lock, Trash2, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";

export type ProjectVisibility = "public" | "private";
export type ProjectAccessLevel = "viewer" | "editor" | "admin";
export type ProjectMemberRole = "viewer" | "editor" | "admin";

export interface ProjectMember {
  uuid: string;
  userUuid: string;
  name: string | null;
  email: string | null;
  role: ProjectMemberRole;
  createdAt: string;
}

interface CompanyUser {
  uuid: string;
  name: string;
  email: string | null;
}

const ROLES: ProjectMemberRole[] = ["viewer", "editor", "admin"];

/** Server message for the last-admin invariant (project-member.service.ts). */
const LAST_ADMIN_MESSAGE = "A project must keep at least one admin";

interface ApiFailure {
  status: number;
  code?: string;
  message?: string;
}

/** Map an API failure to a localized `projectAccess.errors.*` key. */
export function accessErrorKey(failure: ApiFailure): string {
  if (failure.message?.startsWith(LAST_ADMIN_MESSAGE)) return "errors.lastAdmin";
  if (failure.status === 409 || failure.code === "CONFLICT") return "errors.alreadyMember";
  if (failure.message?.startsWith("User not found in this company")) return "errors.notInCompany";
  if (failure.status === 403 || failure.code === "FORBIDDEN") return "errors.forbidden";
  if (failure.status === 422 || failure.code === "VALIDATION_ERROR") return "errors.invalid";
  return "errors.generic";
}

async function callApi<T>(url: string, init?: RequestInit): Promise<
  { ok: true; data: T } | { ok: false; failure: ApiFailure }
> {
  try {
    const res = await fetch(url, init);
    const body = await res.json().catch(() => null);
    if (res.ok && body?.success === true) return { ok: true, data: body.data as T };
    return {
      ok: false,
      failure: { status: res.status, code: body?.error?.code, message: body?.error?.message },
    };
  } catch {
    return { ok: false, failure: { status: 0 } };
  }
}

const jsonInit = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});

interface ProjectAccessTabProps {
  projectUuid: string;
  visibility: ProjectVisibility;
  accessLevel: ProjectAccessLevel;
  onVisibilityChange: (visibility: ProjectVisibility) => void;
  // Called after any member mutation so the parent can re-read the caller's own
  // access level (e.g. an admin who just demoted or removed themself).
  onMembersChanged?: () => void;
}

export function ProjectAccessTab({
  projectUuid,
  visibility,
  accessLevel,
  onVisibilityChange,
  onMembersChanged,
}: ProjectAccessTabProps) {
  const t = useTranslations("projectAccess");
  const tCommon = useTranslations("common");
  const isAdmin = accessLevel === "admin";
  const membersUrl = `/api/projects/${projectUuid}/members`;

  const [members, setMembers] = useState<ProjectMember[] | null>(null);
  const [membersFailed, setMembersFailed] = useState(false);
  const [memberError, setMemberError] = useState<string | null>(null);
  const [busyMember, setBusyMember] = useState<string | null>(null);

  const [pendingVisibility, setPendingVisibility] = useState<ProjectVisibility | null>(null);
  const [savingVisibility, setSavingVisibility] = useState(false);

  const loadMembers = useCallback(async () => {
    const result = await callApi<{ members: ProjectMember[] }>(membersUrl);
    if (result.ok) {
      setMembers(result.data.members);
      setMembersFailed(false);
    } else {
      setMembersFailed(true);
    }
  }, [membersUrl]);

  useEffect(() => {
    void loadMembers();
  }, [loadMembers]);

  const memberLabel = (m: Pick<ProjectMember, "name" | "email">) =>
    m.name || m.email || t("members.unnamed");

  const confirmVisibility = async () => {
    if (!pendingVisibility) return;
    setSavingVisibility(true);
    const result = await callApi(`/api/projects/${projectUuid}`, jsonInit("PATCH", {
      visibility: pendingVisibility,
    }));
    setSavingVisibility(false);
    if (result.ok) {
      onVisibilityChange(pendingVisibility);
      toast.success(t("visibilityUpdated"));
    } else {
      toast.error(t(accessErrorKey(result.failure)));
    }
    setPendingVisibility(null);
  };

  const changeRole = async (member: ProjectMember, role: ProjectMemberRole) => {
    if (role === member.role) return;
    setMemberError(null);
    setBusyMember(member.userUuid);
    const result = await callApi(`${membersUrl}/${member.userUuid}`, jsonInit("PATCH", { role }));
    setBusyMember(null);
    if (result.ok) {
      setMembers((prev) => prev?.map((m) => (m.userUuid === member.userUuid ? { ...m, role } : m)) ?? prev);
      toast.success(t("roleUpdated"));
      onMembersChanged?.();
    } else {
      setMemberError(t(accessErrorKey(result.failure)));
    }
  };

  const removeMember = async (member: ProjectMember) => {
    setMemberError(null);
    setBusyMember(member.userUuid);
    const result = await callApi(`${membersUrl}/${member.userUuid}`, jsonInit("DELETE"));
    setBusyMember(null);
    if (result.ok) {
      setMembers((prev) => prev?.filter((m) => m.userUuid !== member.userUuid) ?? prev);
      toast.success(t("memberRemoved"));
      onMembersChanged?.();
    } else {
      setMemberError(t(accessErrorKey(result.failure)));
    }
  };

  const addMember = async (user: CompanyUser, role: ProjectMemberRole) => {
    setMemberError(null);
    const result = await callApi(membersUrl, jsonInit("POST", { userUuid: user.uuid, role }));
    if (result.ok) {
      toast.success(t("memberAdded"));
      onMembersChanged?.();
      await loadMembers();
      return true;
    }
    setMemberError(t(accessErrorKey(result.failure)));
    return false;
  };

  const memberUuids = useMemo(
    () => new Set((members ?? []).map((m) => m.userUuid)),
    [members],
  );

  return (
    <div className="flex flex-col gap-7" data-testid="project-access-tab">
      {!isAdmin && (
        <p className="flex items-center gap-2 rounded-lg border border-border bg-muted px-3 py-2 text-[12px] text-muted-foreground">
          <Lock className="h-3.5 w-3.5 shrink-0" />
          {t("readOnlyHint")}
        </p>
      )}

      {/* Visibility */}
      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h3 id="project-visibility-label" className="text-[14px] font-semibold text-foreground">
            {t("visibility.title")}
          </h3>
          <p className="text-[12px] text-muted-foreground">{t("visibility.description")}</p>
        </div>
        <RadioGroup
          aria-labelledby="project-visibility-label"
          value={visibility}
          disabled={!isAdmin || savingVisibility}
          onValueChange={(value) => {
            if (value !== visibility) setPendingVisibility(value as ProjectVisibility);
          }}
          className="grid gap-2 sm:grid-cols-2"
        >
          {(["public", "private"] as const).map((option) => (
            <Label
              key={option}
              htmlFor={`project-visibility-${option}`}
              className={`flex items-start gap-3 rounded-lg border border-border bg-card p-3 font-normal transition-colors has-[[data-state=checked]]:border-primary ${
                isAdmin && !savingVisibility
                  ? "cursor-pointer hover:bg-accent"
                  : "cursor-not-allowed opacity-60"
              }`}
            >
              <RadioGroupItem id={`project-visibility-${option}`} value={option} className="mt-0.5 cursor-pointer disabled:cursor-not-allowed" />
              <span className="flex flex-col gap-1">
                <span className="text-[13px] font-medium text-foreground">
                  {t(`visibility.${option}`)}
                </span>
                <span className="text-[12px] text-muted-foreground">
                  {t(`visibility.${option}Hint`)}
                </span>
              </span>
            </Label>
          ))}
        </RadioGroup>
      </section>

      <AlertDialog
        open={pendingVisibility !== null}
        onOpenChange={(open) => {
          if (!open && !savingVisibility) setPendingVisibility(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t(pendingVisibility === "private" ? "confirm.toPrivateTitle" : "confirm.toPublicTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(pendingVisibility === "private"
                ? "confirm.toPrivateDescription"
                : "confirm.toPublicDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={savingVisibility}>
              {tCommon("cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={savingVisibility}
              onClick={(event) => {
                event.preventDefault();
                void confirmVisibility();
              }}
            >
              {savingVisibility && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("confirm.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Members */}
      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="text-[14px] font-semibold text-foreground">{t("members.title")}</h3>
          <p className="text-[12px] text-muted-foreground">{t("members.description")}</p>
        </div>

        {memberError && (
          <div
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-destructive"
          >
            {memberError}
          </div>
        )}

        {members === null ? (
          membersFailed ? (
            <p className="text-[12px] text-destructive">{t("members.loadFailed")}</p>
          ) : (
            <p className="flex items-center gap-2 text-[12px] text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t("members.loading")}
            </p>
          )
        ) : (
          <div className="rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("members.name")}</TableHead>
                  <TableHead className="w-[140px]">{t("members.role")}</TableHead>
                  {isAdmin && <TableHead className="w-[56px] text-right"><span className="sr-only">{t("members.actions")}</span></TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={isAdmin ? 3 : 2} className="text-center text-[12px] text-muted-foreground">
                      {t("members.empty")}
                    </TableCell>
                  </TableRow>
                ) : (
                  members.map((member) => {
                    const label = memberLabel(member);
                    const busy = busyMember === member.userUuid;
                    return (
                      <TableRow key={member.userUuid}>
                        <TableCell className="whitespace-normal">
                          <div className="flex min-w-0 flex-col">
                            <span className="truncate text-[13px] font-medium text-foreground">{label}</span>
                            {member.email && member.name && (
                              <span className="truncate text-[12px] text-muted-foreground">{member.email}</span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          {isAdmin ? (
                            <Select
                              value={member.role}
                              disabled={busy}
                              onValueChange={(role) => void changeRole(member, role as ProjectMemberRole)}
                            >
                              <SelectTrigger
                                size="sm"
                                className="w-[120px]"
                                aria-label={t("members.roleFor", { name: label })}
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {ROLES.map((role) => (
                                  <SelectItem key={role} value={role}>{t(`roles.${role}`)}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          ) : (
                            <Badge variant="secondary">{t(`roles.${member.role}`)}</Badge>
                          )}
                        </TableCell>
                        {isAdmin && (
                          <TableCell className="text-right">
                            <Button
                              variant="ghost"
                              size="icon"
                              disabled={busy}
                              aria-label={t("members.remove", { name: label })}
                              onClick={() => void removeMember(member)}
                              className="h-8 w-8 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                            >
                              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                            </Button>
                          </TableCell>
                        )}
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        )}

        {isAdmin && members !== null && (
          <AddMemberRow excludeUuids={memberUuids} onAdd={addMember} />
        )}
      </section>
    </div>
  );
}

interface AddMemberRowProps {
  excludeUuids: Set<string>;
  onAdd: (user: CompanyUser, role: ProjectMemberRole) => Promise<boolean>;
}

function AddMemberRow({ excludeUuids, onAdd }: AddMemberRowProps) {
  const t = useTranslations("projectAccess");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CompanyUser[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<CompanyUser | null>(null);
  const [role, setRole] = useState<ProjectMemberRole>("editor");
  const [adding, setAdding] = useState(false);

  // Company users come from the mention search (the only company-user listing
  // exposed to non-super-admins); it only searches users for a non-empty query.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(async () => {
      const result = await callApi<Array<{ type: string; uuid: string; name: string; email?: string | null }>>(
        `/api/mentionables?q=${encodeURIComponent(q)}&limit=20`,
      );
      if (cancelled) return;
      setSearching(false);
      setResults(result.ok
        ? result.data
          .filter((item) => item.type === "user")
          .map((item) => ({ uuid: item.uuid, name: item.name, email: item.email ?? null }))
        : []);
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const candidates = results.filter((user) => !excludeUuids.has(user.uuid));

  const handleAdd = async () => {
    if (!selected) return;
    setAdding(true);
    const ok = await onAdd(selected, role);
    setAdding(false);
    if (ok) {
      setSelected(null);
      setQuery("");
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-dashed border-border p-3">
      <span className="text-[12px] font-medium text-muted-foreground">{t("add.title")}</span>
      <div className="flex flex-wrap items-center gap-2">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              role="combobox"
              aria-expanded={open}
              aria-label={t("add.selectUser")}
              className="min-w-[200px] flex-1 justify-between font-normal"
            >
              <span className={selected ? "truncate text-foreground" : "truncate text-muted-foreground"}>
                {selected ? selected.name : t("add.selectUser")}
              </span>
              <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[300px] p-0" align="start">
            <Command shouldFilter={false}>
              <CommandInput
                value={query}
                onValueChange={setQuery}
                placeholder={t("add.searchPlaceholder")}
              />
              <CommandList>
                {!query.trim() ? (
                  <p className="px-3 py-4 text-center text-[12px] text-muted-foreground">{t("add.typeToSearch")}</p>
                ) : searching ? (
                  <p className="flex items-center justify-center gap-2 px-3 py-4 text-[12px] text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {t("add.searching")}
                  </p>
                ) : (
                  <>
                    <CommandEmpty>{t("add.noResults")}</CommandEmpty>
                    <CommandGroup>
                      {candidates.map((user) => (
                        <CommandItem
                          key={user.uuid}
                          value={user.uuid}
                          onSelect={() => {
                            setSelected(user);
                            setOpen(false);
                          }}
                        >
                          <div className="flex min-w-0 flex-1 flex-col">
                            <span className="truncate text-[13px]">{user.name}</span>
                            {user.email && (
                              <span className="truncate text-[11px] text-muted-foreground">{user.email}</span>
                            )}
                          </div>
                          {selected?.uuid === user.uuid && <Check className="h-4 w-4 text-primary" />}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </>
                )}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        <Select value={role} onValueChange={(value) => setRole(value as ProjectMemberRole)}>
          <SelectTrigger className="w-[120px]" aria-label={t("add.role")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ROLES.map((r) => (
              <SelectItem key={r} value={r}>{t(`roles.${r}`)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button onClick={() => void handleAdd()} disabled={!selected || adding} className="gap-1.5">
          {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
          {adding ? t("add.adding") : t("add.add")}
        </Button>
      </div>
    </div>
  );
}
